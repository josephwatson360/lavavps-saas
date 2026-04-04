"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_ecs_1 = require("@aws-sdk/client-ecs");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const logger_1 = require("../../layer/src/logger");
const response_1 = require("../../layer/src/response");
// ─────────────────────────────────────────────────────────────────────────────
// taskHandler
//
// GET  /agents/{agentId}/status  - Get current ECS task status
// POST /agents/{agentId}/start   - Start ECS task (pre-wake for WebSocket)
// POST /agents/{agentId}/stop    - Stop ECS task
//
// Pre-wake flow:
//   Portal calls POST /start before opening WebSocket.
//   Handler starts ECS task and polls /readyz up to 45 seconds.
//   Returns RUNNING once healthy, or error if startup times out.
//   This ensures the WS connection always lands on a ready agent.
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('taskHandler');
const ecs = new client_ecs_1.ECSClient({});
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const CLUSTER_NAME = process.env.CLUSTER_NAME;
const PLAN_TASK_DEFS = {
    starter: 'lavavps-openclaw-starter',
    pro: 'lavavps-openclaw-pro',
    business: 'lavavps-openclaw-business',
};
const PRIVATE_SUBNETS = process.env.PRIVATE_SUBNETS?.split(',') ?? [];
const FARGATE_SG_ID = process.env.FARGATE_SG_ID;
const handler = async (event) => {
    const tenantId = event.requestContext.authorizer?.tenantId;
    const planCode = event.requestContext.authorizer?.planCode ?? 'starter';
    const agentId = event.pathParameters?.agentId;
    const action = event.pathParameters?.action; // start | stop
    if (!tenantId || !agentId)
        return (0, response_1.badRequest)('Missing tenant or agent context');
    // Fetch agent record
    const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));
    if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
        return (0, response_1.notFound)('Agent');
    }
    const item = agentResult.Item;
    // ── GET /status ────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const status = item.status ?? 'STOPPED';
        const taskArn = item.task_arn;
        let ecsStatus = null;
        if (taskArn && status === 'RUNNING') {
            try {
                const tasksResult = await ecs.send(new client_ecs_1.DescribeTasksCommand({
                    cluster: CLUSTER_NAME,
                    tasks: [taskArn],
                }));
                const task = tasksResult.tasks?.[0];
                ecsStatus = task?.lastStatus ?? 'UNKNOWN';
                // Sync status if ECS says task is stopped
                if (task?.lastStatus === 'STOPPED' || task?.lastStatus === 'DEPROVISIONING') {
                    await dynamo.send(new lib_dynamodb_1.UpdateCommand({
                        TableName: TABLE_NAME,
                        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
                        UpdateExpression: 'SET #s = :s, task_arn = :null, gsi2pk = :gsi2pk, gsi2sk = :now',
                        ExpressionAttributeNames: { '#s': 'status' },
                        ExpressionAttributeValues: {
                            ':s': 'STOPPED',
                            ':null': null,
                            ':gsi2pk': 'STATUS#STOPPED',
                            ':now': new Date().toISOString(),
                        },
                    }));
                    return (0, response_1.ok)({ status: 'STOPPED', agentId, taskArn: null });
                }
            }
            catch {
                // ECS describe failed — return cached status
            }
        }
        return (0, response_1.ok)({
            status,
            agentId,
            taskArn: taskArn ?? null,
            ecsStatus,
            lastActivityAt: item.last_activity_at ?? null,
        });
    }
    // ── POST /start ────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'start') {
        const currentStatus = item.status ?? 'STOPPED';
        // Already running — return immediately
        if (currentStatus === 'RUNNING') {
            return (0, response_1.ok)({ status: 'RUNNING', agentId, taskArn: item.task_arn });
        }
        // Already starting — return in-progress
        if (currentStatus === 'STARTING') {
            return (0, response_1.ok)({ status: 'STARTING', agentId, message: 'Agent is already starting' });
        }
        // Check API key is configured
        if (!item.llm_secret_arn) {
            return (0, response_1.badRequest)('No LLM API key configured. Add an API key before starting the agent.');
        }
        // Determine task definition for plan
        const taskDefFamily = PLAN_TASK_DEFS[planCode] ?? PLAN_TASK_DEFS.starter;
        const iamTaskRole = item.iam_task_role_arn;
        if (!iamTaskRole) {
            return (0, response_1.internalError)('Agent task role not provisioned. Contact support.');
        }
        // Mark as STARTING
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
            UpdateExpression: 'SET #s = :s, gsi2pk = :gsi2pk, gsi2sk = :now, updated_at = :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
                ':s': 'STARTING',
                ':gsi2pk': 'STATUS#STARTING',
                ':now': new Date().toISOString(),
            },
        }));
        // Launch ECS task
        const efsApId = item.efs_access_point_id;
        try {
            const runResult = await ecs.send(new client_ecs_1.RunTaskCommand({
                cluster: CLUSTER_NAME,
                taskDefinition: taskDefFamily,
                launchType: planCode === 'starter' ? 'FARGATE' : 'FARGATE',
                capacityProviderStrategy: planCode === 'starter'
                    ? [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 },
                        { capacityProvider: 'FARGATE', weight: 1, base: 0 }]
                    : [{ capacityProvider: 'FARGATE', weight: 1, base: 1 }],
                networkConfiguration: {
                    awsvpcConfiguration: {
                        subnets: PRIVATE_SUBNETS,
                        securityGroups: [FARGATE_SG_ID],
                        assignPublicIp: 'DISABLED',
                    },
                },
                overrides: {
                    taskRoleArn: iamTaskRole,
                    containerOverrides: [{
                            name: 'openclaw',
                            environment: [
                                { name: 'TENANT_ID', value: tenantId },
                                { name: 'AGENT_ID', value: agentId },
                            ],
                        }],
                },
                // EFS volume with tenant-specific Access Point
                ...(efsApId ? {
                    volumes: [{
                            name: 'openclaw-data',
                            efsVolumeConfiguration: {
                                fileSystemId: process.env.EFS_ID,
                                transitEncryption: 'ENABLED',
                                authorizationConfig: {
                                    accessPointId: efsApId,
                                    iam: 'ENABLED',
                                },
                            },
                        }],
                } : {}),
                tags: [
                    { key: 'TenantId', value: tenantId },
                    { key: 'AgentId', value: agentId },
                ],
            }));
            const task = runResult.tasks?.[0];
            const taskArn = task?.taskArn;
            if (!taskArn) {
                throw new Error('ECS RunTask did not return a task ARN');
            }
            // Update DynamoDB with task ARN
            await dynamo.send(new lib_dynamodb_1.UpdateCommand({
                TableName: TABLE_NAME,
                Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
                UpdateExpression: 'SET task_arn = :arn, updated_at = :now',
                ExpressionAttributeValues: {
                    ':arn': taskArn,
                    ':now': new Date().toISOString(),
                },
            }));
            // Poll /readyz up to 45 seconds for pre-wake
            const taskIp = task?.attachments?.[0]?.details?.find(d => d.name === 'privateIPv4Address')?.value;
            if (taskIp) {
                const ready = await pollReadyz(taskIp, 45);
                if (ready) {
                    await dynamo.send(new lib_dynamodb_1.UpdateCommand({
                        TableName: TABLE_NAME,
                        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
                        UpdateExpression: 'SET #s = :s, gsi2pk = :gsi2pk, last_activity_at = :now, updated_at = :now',
                        ExpressionAttributeNames: { '#s': 'status' },
                        ExpressionAttributeValues: {
                            ':s': 'RUNNING',
                            ':gsi2pk': 'STATUS#RUNNING',
                            ':now': new Date().toISOString(),
                        },
                    }));
                    return (0, response_1.ok)({ status: 'RUNNING', agentId, taskArn });
                }
            }
            // Task started but /readyz not yet ready — portal will poll status
            return (0, response_1.ok)({ status: 'STARTING', agentId, taskArn, message: 'Agent is starting' });
        }
        catch (err) {
            logger.error('Failed to start ECS task', {
                tenant_id: tenantId,
                agent_id: agentId,
                error: err instanceof Error ? err.message : 'unknown',
            });
            // Revert status
            await dynamo.send(new lib_dynamodb_1.UpdateCommand({
                TableName: TABLE_NAME,
                Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
                UpdateExpression: 'SET #s = :s, gsi2pk = :gsi2pk, updated_at = :now',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: {
                    ':s': 'STOPPED',
                    ':gsi2pk': 'STATUS#STOPPED',
                    ':now': new Date().toISOString(),
                },
            }));
            return (0, response_1.internalError)('Failed to start agent. Please try again.');
        }
    }
    // ── POST /stop ─────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'stop') {
        const taskArn = item.task_arn;
        if (taskArn) {
            try {
                await ecs.send(new client_ecs_1.StopTaskCommand({
                    cluster: CLUSTER_NAME,
                    task: taskArn,
                    reason: `Stopped by user: ${tenantId}`,
                }));
            }
            catch (err) {
                logger.warn('ECS StopTask failed', {
                    tenant_id: tenantId,
                    agent_id: agentId,
                    task_arn: taskArn,
                    error: err instanceof Error ? err.message : 'unknown',
                });
            }
        }
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
            UpdateExpression: 'SET #s = :s, task_arn = :null, gsi2pk = :gsi2pk, gsi2sk = :now, updated_at = :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
                ':s': 'STOPPED',
                ':null': null,
                ':gsi2pk': 'STATUS#STOPPED',
                ':now': new Date().toISOString(),
            },
        }));
        logger.info('Agent stopped', { tenant_id: tenantId, agent_id: agentId });
        return (0, response_1.ok)({ status: 'STOPPED', agentId });
    }
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
exports.handler = handler;
// ── Pre-wake: poll /readyz until agent is ready ───────────────────────────────
async function pollReadyz(taskIp, timeoutSeconds) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const url = `http://${taskIp}:${process.env.OPENCLAW_PORT ?? '18789'}/readyz`;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (resp.ok)
                return true;
        }
        catch {
            // Not ready yet — continue polling
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}
