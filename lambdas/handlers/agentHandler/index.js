"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const logger_1 = require("./logger");
const response_1 = require("./response");
const crypto_1 = require("crypto");
// ─────────────────────────────────────────────────────────────────────────────
// agentHandler
//
// GET    /agents              - List all agents for tenant
// POST   /agents              - Provision a new agent (enforces plan quota)
// GET    /agents/{agentId}    - Get single agent
// DELETE /agents/{agentId}    - Delete agent (stops task, removes records)
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('agentHandler');
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const PLAN_AGENT_LIMITS = {
    starter: 2,
    pro: 4,
    business: 10,
};
const handler = async (event) => {
    const tenantId = event.requestContext.authorizer?.claims?.['custom:tenant_id'];
    const planCode = event.requestContext.authorizer?.claims?.['custom:plan_code'] ?? 'starter';
    const agentId = event.pathParameters?.agentId;
    if (!tenantId)
        return (0, response_1.badRequest)('Missing tenant context');
    // ── GET /agents ────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && !agentId) {
        const result = await dynamo.send(new lib_dynamodb_1.QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: {
                ':pk': `TENANT#${tenantId}`,
                ':prefix': 'AGENT#',
            },
        }));
        const agents = (result.Items ?? []).map(item => ({
            agentId: item.agent_id,
            name: item.config_agentName ?? item.agent_id,
            status: item.status ?? 'STOPPED',
            planCode: item.plan_code,
            primaryModel: item.config_primaryModel ?? null,
            onboardingDone: item.onboarding_complete ?? false,
            createdAt: item.created_at,
            lastActivityAt: item.last_activity_at ?? null,
        }));
        return (0, response_1.ok)({ agents, count: agents.length });
    }
    // ── GET /agents/{agentId} ──────────────────────────────────────────────
    if (event.httpMethod === 'GET' && agentId) {
        const result = await dynamo.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        }));
        if (!result.Item || result.Item.tenant_id !== tenantId) {
            return (0, response_1.notFound)('Agent');
        }
        return (0, response_1.ok)({
            agentId: result.Item.agent_id,
            name: result.Item.config_agentName ?? result.Item.agent_id,
            status: result.Item.status ?? 'STOPPED',
            planCode: result.Item.plan_code,
            primaryModel: result.Item.config_primaryModel ?? null,
            onboardingDone: result.Item.onboarding_complete ?? false,
            configVersion: result.Item.config_version ?? 0,
            storageQuotaGb: result.Item.storage_quota_gb ?? 5,
            storageUsedBytes: result.Item.storage_used_bytes ?? 0,
            createdAt: result.Item.created_at,
            lastActivityAt: result.Item.last_activity_at ?? null,
            taskArn: result.Item.task_arn ?? null,
        });
    }
    // ── POST /agents ───────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && !agentId) {
        // Check current agent count against plan limit
        const existing = await dynamo.send(new lib_dynamodb_1.QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: {
                ':pk': `TENANT#${tenantId}`,
                ':prefix': 'AGENT#',
            },
            Select: 'COUNT',
        }));
        const currentCount = existing.Count ?? 0;
        const baseLimit = PLAN_AGENT_LIMITS[planCode] ?? 1;
        const profileResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: 'PROFILE' },
        }));
        const addonAgentCount = parseInt(String(profileResult.Item?.addon_agent_count ?? '0'), 10);
        const effectiveLimit = baseLimit + addonAgentCount;
        if (currentCount >= effectiveLimit) {
            return {
                statusCode: 402,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'AGENT_LIMIT_REACHED',
                    message: `Your plan includes ${effectiveLimit} agent${effectiveLimit > 1 ? 's' : ''}. Purchase an additional agent add-on to add more.`,
                    current: currentCount,
                    limit: effectiveLimit,
                }),
            };
        }
        const body = (0, response_1.parseBody)(event.body);
        const newAgentId = (0, crypto_1.randomUUID)();
        const now = new Date().toISOString();
        await dynamo.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `TENANT#${tenantId}`,
                sk: `AGENT#${newAgentId}`,
                agent_id: newAgentId,
                tenant_id: tenantId,
                plan_code: planCode,
                status: 'PROVISIONING',
                config_agentName: body?.name ?? `Agent ${currentCount + 1}`,
                config_version: 0,
                onboarding_complete: false,
                storage_quota_gb: PLAN_AGENT_LIMITS[planCode] === 1 ? 5 : planCode === 'pro' ? 50 : 100,
                storage_used_bytes: 0,
                created_at: now,
                updated_at: now,
                // GSI-2 for Task Watcher
                gsi2pk: 'STATUS#PROVISIONING',
                gsi2sk: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)', // prevent duplicate
        }));
        logger.info('Agent record created', { tenant_id: tenantId, agent_id: newAgentId });
        return (0, response_1.created)({
            agentId: newAgentId,
            status: 'PROVISIONING',
            message: 'Agent created. Configure your LLM provider API key to complete setup.',
        });
    }
    // ── DELETE /agents/{agentId} ───────────────────────────────────────────
    if (event.httpMethod === 'DELETE' && agentId) {
        const result = await dynamo.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        }));
        if (!result.Item || result.Item.tenant_id !== tenantId) {
            return (0, response_1.notFound)('Agent');
        }
        // Mark as DELETING — actual ECS task stop + EFS cleanup handled async
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
            UpdateExpression: 'SET #status = :s, updated_at = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':s': 'DELETING', ':now': new Date().toISOString() },
        }));
        logger.info('Agent marked for deletion', { tenant_id: tenantId, agent_id: agentId });
        return (0, response_1.noContent)();
    }
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
exports.handler = handler;
