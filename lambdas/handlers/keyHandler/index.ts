import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, CreateSecretCommand, UpdateSecretCommand, DeleteSecretCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { createLogger } from '../../layer/src/logger';
import { ok, created, noContent, badRequest, forbidden, notFound, parseBody } from '../../layer/src/response';

// ─────────────────────────────────────────────────────────────────────────────
// keyHandler
//
// POST   /agents/{agentId}/keys  - Store LLM provider API key in Secrets Manager
// DELETE /agents/{agentId}/keys  - Remove API key
//
// Security:
//   - API key is written to Secrets Manager (KMS encrypted), never to DynamoDB
//   - Only the Secret ARN is stored in DynamoDB
//   - Key is NEVER returned after initial storage (write-only)
//   - After storing, configRenderer is triggered to apply the new provider config
// ─────────────────────────────────────────────────────────────────────────────

const logger = createLogger('keyHandler');
const secrets = new SecretsManagerClient({});
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda  = new LambdaClient({});

const TABLE_NAME          = process.env.TABLE_NAME!;
const CONFIG_RENDERER_ARN = process.env.CONFIG_RENDERER_ARN!;
const AWS_REGION          = process.env.AWS_REGION_NAME!;
const AWS_ACCOUNT         = process.env.AWS_ACCOUNT!;

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'mistral', 'cohere'];

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const tenantId = event.requestContext.authorizer?.tenantId as string;
  const agentId  = event.pathParameters?.agentId;

  if (!tenantId || !agentId) return badRequest('Missing tenant or agent context');

  // Verify agent belongs to tenant
  const agentResult = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
  }));

  if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
    return notFound('Agent');
  }

  // ── POST — store API key ───────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    const body = parseBody<{ provider: string; apiKey: string }>(event.body);

    if (!body?.provider || !body?.apiKey) {
      return badRequest('Request body must include provider and apiKey');
    }

    if (!SUPPORTED_PROVIDERS.includes(body.provider.toLowerCase())) {
      return badRequest(`Unsupported provider. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }

    if (body.apiKey.length < 10) {
      return badRequest('apiKey appears invalid (too short)');
    }

    const provider   = body.provider.toLowerCase();
    const secretName = `/openclaw/prod/${tenantId}/${agentId}/llm-key`;
    const secretValue = JSON.stringify({ provider, apiKey: body.apiKey });

    // Check if secret already exists
    let secretArn: string;
    try {
      const existing = await secrets.send(new DescribeSecretCommand({ SecretId: secretName }));
      // Update existing secret
      await secrets.send(new UpdateSecretCommand({
        SecretId:     secretName,
        SecretString: secretValue,
      }));
      secretArn = existing.ARN!;
    } catch (err: unknown) {
      const awsErr = err as { name?: string };
      if (awsErr.name === 'ResourceNotFoundException') {
        // Create new secret
        const created = await secrets.send(new CreateSecretCommand({
          Name:         secretName,
          SecretString: secretValue,
          Description:  `LLM API key for tenant ${tenantId} agent ${agentId}`,
          Tags: [
            { Key: 'TenantId',  Value: tenantId },
            { Key: 'AgentId',   Value: agentId },
            { Key: 'ManagedBy', Value: 'LavaVPS' },
          ],
        }));
        secretArn = created.ARN!;
      } else {
        throw err;
      }
    }

    // Store secret ARN and provider in DynamoDB (not the key itself)
    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
      UpdateExpression: 'SET llm_secret_arn = :arn, llm_provider = :p, updated_at = :now',
      ExpressionAttributeValues: {
        ':arn': secretArn,
        ':p':   provider,
        ':now': new Date().toISOString(),
      },
    }));

    // Trigger configRenderer to apply new provider config
    await lambda.send(new InvokeCommand({
      FunctionName:   CONFIG_RENDERER_ARN,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ tenantId, agentId })),
    }));

    logger.info('LLM API key stored', {
      tenant_id: tenantId,
      agent_id:  agentId,
      provider,
      secret_arn: secretArn,
    });

    return created({
      message:  `${provider} API key stored securely. Your agent will use this key for all LLM calls.`,
      provider,
      // Never return the key or ARN to the client
    });
  }

  // ── DELETE — remove API key ────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const secretName = `/openclaw/prod/${tenantId}/${agentId}/llm-key`;

    try {
      await secrets.send(new DeleteSecretCommand({
        SecretId:                   secretName,
        RecoveryWindowInDays:       7, // 7-day recovery window before permanent deletion
        ForceDeleteWithoutRecovery: false,
      }));
    } catch (err: unknown) {
      const awsErr = err as { name?: string };
      if (awsErr.name !== 'ResourceNotFoundException') throw err;
      // Secret doesn't exist — still clear DynamoDB reference
    }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
      UpdateExpression: 'REMOVE llm_secret_arn, llm_provider SET updated_at = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));

    logger.info('LLM API key removed', { tenant_id: tenantId, agent_id: agentId });
    return noContent();
  }

  return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
