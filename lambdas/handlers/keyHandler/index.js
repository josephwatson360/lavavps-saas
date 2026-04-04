"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_lambda_1 = require("@aws-sdk/client-lambda");
const logger_1 = require("../../layer/src/logger");
const response_1 = require("../../layer/src/response");
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
const logger = (0, logger_1.createLogger)('keyHandler');
const secrets = new client_secrets_manager_1.SecretsManagerClient({});
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const lambda = new client_lambda_1.LambdaClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const CONFIG_RENDERER_ARN = process.env.CONFIG_RENDERER_ARN;
const AWS_REGION = process.env.AWS_REGION_NAME;
const AWS_ACCOUNT = process.env.AWS_ACCOUNT;
const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'mistral', 'cohere'];
const handler = async (event) => {
    const tenantId = event.requestContext.authorizer?.tenantId;
    const agentId = event.pathParameters?.agentId;
    if (!tenantId || !agentId)
        return (0, response_1.badRequest)('Missing tenant or agent context');
    // Verify agent belongs to tenant
    const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));
    if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
        return (0, response_1.notFound)('Agent');
    }
    // ── POST — store API key ───────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        const body = (0, response_1.parseBody)(event.body);
        if (!body?.provider || !body?.apiKey) {
            return (0, response_1.badRequest)('Request body must include provider and apiKey');
        }
        if (!SUPPORTED_PROVIDERS.includes(body.provider.toLowerCase())) {
            return (0, response_1.badRequest)(`Unsupported provider. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
        }
        if (body.apiKey.length < 10) {
            return (0, response_1.badRequest)('apiKey appears invalid (too short)');
        }
        const provider = body.provider.toLowerCase();
        const secretName = `/openclaw/prod/${tenantId}/${agentId}/llm-key`;
        const secretValue = JSON.stringify({ provider, apiKey: body.apiKey });
        // Check if secret already exists
        let secretArn;
        try {
            const existing = await secrets.send(new client_secrets_manager_1.DescribeSecretCommand({ SecretId: secretName }));
            // Update existing secret
            await secrets.send(new client_secrets_manager_1.UpdateSecretCommand({
                SecretId: secretName,
                SecretString: secretValue,
            }));
            secretArn = existing.ARN;
        }
        catch (err) {
            const awsErr = err;
            if (awsErr.name === 'ResourceNotFoundException') {
                // Create new secret
                const created = await secrets.send(new client_secrets_manager_1.CreateSecretCommand({
                    Name: secretName,
                    SecretString: secretValue,
                    Description: `LLM API key for tenant ${tenantId} agent ${agentId}`,
                    Tags: [
                        { Key: 'TenantId', Value: tenantId },
                        { Key: 'AgentId', Value: agentId },
                        { Key: 'ManagedBy', Value: 'LavaVPS' },
                    ],
                }));
                secretArn = created.ARN;
            }
            else {
                throw err;
            }
        }
        // Store secret ARN and provider in DynamoDB (not the key itself)
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
            UpdateExpression: 'SET llm_secret_arn = :arn, llm_provider = :p, updated_at = :now',
            ExpressionAttributeValues: {
                ':arn': secretArn,
                ':p': provider,
                ':now': new Date().toISOString(),
            },
        }));
        // Trigger configRenderer to apply new provider config
        await lambda.send(new client_lambda_1.InvokeCommand({
            FunctionName: CONFIG_RENDERER_ARN,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ tenantId, agentId })),
        }));
        logger.info('LLM API key stored', {
            tenant_id: tenantId,
            agent_id: agentId,
            provider,
            secret_arn: secretArn,
        });
        return (0, response_1.created)({
            message: `${provider} API key stored securely. Your agent will use this key for all LLM calls.`,
            provider,
            // Never return the key or ARN to the client
        });
    }
    // ── DELETE — remove API key ────────────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
        const secretName = `/openclaw/prod/${tenantId}/${agentId}/llm-key`;
        try {
            await secrets.send(new client_secrets_manager_1.DeleteSecretCommand({
                SecretId: secretName,
                RecoveryWindowInDays: 7, // 7-day recovery window before permanent deletion
                ForceDeleteWithoutRecovery: false,
            }));
        }
        catch (err) {
            const awsErr = err;
            if (awsErr.name !== 'ResourceNotFoundException')
                throw err;
            // Secret doesn't exist — still clear DynamoDB reference
        }
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
            UpdateExpression: 'REMOVE llm_secret_arn, llm_provider SET updated_at = :now',
            ExpressionAttributeValues: { ':now': new Date().toISOString() },
        }));
        logger.info('LLM API key removed', { tenant_id: tenantId, agent_id: agentId });
        return (0, response_1.noContent)();
    }
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
exports.handler = handler;
