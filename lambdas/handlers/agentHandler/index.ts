import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../layer/src/logger';
import { ok, created, noContent, badRequest, forbidden, notFound, internalError, parseBody } from '../../layer/src/response';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// agentHandler
//
// GET    /agents              - List all agents for tenant
// POST   /agents              - Provision a new agent (enforces plan quota)
// GET    /agents/{agentId}    - Get single agent
// DELETE /agents/{agentId}    - Delete agent (stops task, removes records)
// ─────────────────────────────────────────────────────────────────────────────

const logger = createLogger('agentHandler');
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

const PLAN_AGENT_LIMITS: Record<string, number> = {
  starter:  1,
  pro:      5,
  business: 10,
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const tenantId = event.requestContext.authorizer?.tenantId as string;
  const planCode  = event.requestContext.authorizer?.planCode  as string ?? 'starter';
  const agentId  = event.pathParameters?.agentId;

  if (!tenantId) return badRequest('Missing tenant context');

  // ── GET /agents ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && !agentId) {
    const result = await dynamo.send(new QueryCommand({
      TableName:              TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk':     `TENANT#${tenantId}`,
        ':prefix': 'AGENT#',
      },
    }));

    const agents = (result.Items ?? []).map(item => ({
      agentId:         item.agent_id,
      name:            item.config_agentName ?? item.agent_id,
      status:          item.status ?? 'STOPPED',
      planCode:        item.plan_code,
      primaryModel:    item.config_primaryModel ?? null,
      onboardingDone:  item.onboarding_complete ?? false,
      createdAt:       item.created_at,
      lastActivityAt:  item.last_activity_at ?? null,
    }));

    return ok({ agents, count: agents.length });
  }

  // ── GET /agents/{agentId} ──────────────────────────────────────────────
  if (event.httpMethod === 'GET' && agentId) {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));

    if (!result.Item || result.Item.tenant_id !== tenantId) {
      return notFound('Agent');
    }

    return ok({
      agentId:          result.Item.agent_id,
      name:             result.Item.config_agentName ?? result.Item.agent_id,
      status:           result.Item.status ?? 'STOPPED',
      planCode:         result.Item.plan_code,
      primaryModel:     result.Item.config_primaryModel ?? null,
      onboardingDone:   result.Item.onboarding_complete ?? false,
      configVersion:    result.Item.config_version ?? 0,
      storageQuotaGb:   result.Item.storage_quota_gb ?? 5,
      storageUsedBytes: result.Item.storage_used_bytes ?? 0,
      createdAt:        result.Item.created_at,
      lastActivityAt:   result.Item.last_activity_at ?? null,
      taskArn:          result.Item.task_arn ?? null,
    });
  }

  // ── POST /agents ───────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && !agentId) {
    // Check current agent count against plan limit
    const existing = await dynamo.send(new QueryCommand({
      TableName:              TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk':     `TENANT#${tenantId}`,
        ':prefix': 'AGENT#',
      },
      Select: 'COUNT',
    }));

    const currentCount = existing.Count ?? 0;
    const limit = PLAN_AGENT_LIMITS[planCode] ?? 1;

    if (currentCount >= limit) {
      return {
        statusCode: 402,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error:   'AGENT_LIMIT_REACHED',
          message: `Your ${planCode} plan includes ${limit} agent${limit > 1 ? 's' : ''}. Purchase an additional agent add-on to add more.`,
          current: currentCount,
          limit,
        }),
      };
    }

    const body = parseBody<{ name?: string }>(event.body);
    const newAgentId = randomUUID();
    const now = new Date().toISOString();

    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk:                `TENANT#${tenantId}`,
        sk:                `AGENT#${newAgentId}`,
        agent_id:          newAgentId,
        tenant_id:         tenantId,
        plan_code:         planCode,
        status:            'PROVISIONING',
        config_agentName:  body?.name ?? `Agent ${currentCount + 1}`,
        config_version:    0,
        onboarding_complete: false,
        storage_quota_gb:  PLAN_AGENT_LIMITS[planCode] === 1 ? 5 : planCode === 'pro' ? 50 : 100,
        storage_used_bytes: 0,
        created_at:        now,
        updated_at:        now,
        // GSI-2 for Task Watcher
        gsi2pk:            'STATUS#PROVISIONING',
        gsi2sk:            now,
      },
      ConditionExpression: 'attribute_not_exists(pk)', // prevent duplicate
    }));

    logger.info('Agent record created', { tenant_id: tenantId, agent_id: newAgentId });

    return created({
      agentId:  newAgentId,
      status:   'PROVISIONING',
      message:  'Agent created. Configure your LLM provider API key to complete setup.',
    });
  }

  // ── DELETE /agents/{agentId} ───────────────────────────────────────────
  if (event.httpMethod === 'DELETE' && agentId) {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));

    if (!result.Item || result.Item.tenant_id !== tenantId) {
      return notFound('Agent');
    }

    // Mark as DELETING — actual ECS task stop + EFS cleanup handled async
    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
      UpdateExpression: 'SET #status = :s, updated_at = :now',
      ExpressionAttributeNames:  { '#status': 'status' },
      ExpressionAttributeValues: { ':s': 'DELETING', ':now': new Date().toISOString() },
    }));

    logger.info('Agent marked for deletion', { tenant_id: tenantId, agent_id: agentId });

    return noContent();
  }

  return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
