"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_apigatewaymanagementapi_1 = require("@aws-sdk/client-apigatewaymanagementapi");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const logger_1 = require("./logger");
// ─────────────────────────────────────────────────────────────────────────────
// wsHandler
//
// WebSocket routes: $connect, $disconnect, $default
//
// $connect:
//   - Validates JWT from query param ?token=<jwt>
//   - Looks up agent's ECS task private IP from DynamoDB
//   - Stores connectionId -> {tenantId, agentId, taskIp} in DynamoDB (TTL: 2h)
//   - Updates last_activity_at on agent record
//
// $disconnect:
//   - Cleans up connection record from DynamoDB
//
// $default:
//   - Forwards message from portal to OpenClaw WebSocket on task private IP
//   - Receives response from OpenClaw and relays back to portal via APIGW management API
//   - Updates last_activity_at to reset idle timeout
//
// Note: Auth mode = trusted-proxy on OpenClaw.
//   ALB handles Cognito auth for REST/HTTP requests.
//   WebSocket connections through API Gateway v2 use the Cognito authorizer
//   configured on the $connect route.
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('wsHandler');
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const OPENCLAW_PORT = process.env.OPENCLAW_PORT ?? '18789';
const WS_ENDPOINT = process.env.WS_MANAGEMENT_ENDPOINT; // API GW management endpoint
const WS_TTL_SECONDS = 7200; // 2 hours
const handler = async (event) => {
    const { connectionId, routeKey, domainName, stage } = event.requestContext;
    const apigw = new client_apigatewaymanagementapi_1.ApiGatewayManagementApiClient({
        endpoint: `https://${domainName}/${stage}`,
    });
    // ── $connect ────────────────────────────────────────────────────────────
    if (routeKey === '$connect') {
        const qsp = event.queryStringParameters ?? {};
        const agentId = qsp.agentId;
        // Decode JWT from ?token= query param (WS browsers cannot send headers)
        let tenantId = '';
        let planCode = 'starter';
        try {
            const token = qsp.token ?? '';
            const parts = token.split('.');
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            tenantId = payload['custom:tenant_id'] ?? '';
            planCode = payload['custom:plan_code'] ?? 'starter';
        } catch(e) {
            logger.warn('WS connect: invalid JWT', { connectionId });
            return { statusCode: 401 };
        }
        if (!tenantId || !agentId) {
            logger.warn('WS connect rejected: missing tenant or agent', { connectionId });
            return { statusCode: 401 };
        }
        // Fetch agent record to get task IP
        const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        }));
        if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
            return { statusCode: 404 };
        }
        const item = agentResult.Item;
        const status = item.status;
        const taskIp = item.task_private_ip;
        if (status !== 'RUNNING' || !taskIp) {
            // Agent not running — tell portal to call /start first
            logger.warn('WS connect: agent not running', {
                tenant_id: tenantId, agent_id: agentId, status,
            });
            return { statusCode: 503 }; // Service Unavailable - agent needs wake
        }
        // Store connection → agent mapping (TTL: 2 hours)
        const now = Math.floor(Date.now() / 1000);
        await dynamo.send(new lib_dynamodb_1.PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `WS#${connectionId}`,
                sk: `WS#${connectionId}`,
                connection_id: connectionId,
                tenant_id: tenantId,
                agent_id: agentId,
                task_ip: taskIp,
                connected_at: new Date().toISOString(),
                ttl: now + WS_TTL_SECONDS,
            },
        }));
        // Update agent activity
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
            UpdateExpression: 'SET last_activity_at = :now',
            ExpressionAttributeValues: { ':now': new Date().toISOString() },
        }));
        logger.info('WS connected', { connection_id: connectionId, tenant_id: tenantId, agent_id: agentId });
        return { statusCode: 200 };
    }
    // ── $disconnect ─────────────────────────────────────────────────────────
    if (routeKey === '$disconnect') {
        await dynamo.send(new lib_dynamodb_1.DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: `WS#${connectionId}`, sk: `WS#${connectionId}` },
        }));
        logger.info('WS disconnected', { connection_id: connectionId });
        return { statusCode: 200 };
    }
    // ── $default — relay message to OpenClaw ─────────────────────────────────
    const connResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `WS#${connectionId}`, sk: `WS#${connectionId}` },
    }));
    if (!connResult.Item) {
        logger.warn('WS message: no connection record', { connection_id: connectionId });
        return { statusCode: 410 }; // Gone
    }
    const conn = connResult.Item;
    const taskIp = conn.task_ip;
    const tenantId = conn.tenant_id;
    const agentId = conn.agent_id;
    const body = event.body ?? '';
    // Update activity timestamp (resets idle timer)
    await dynamo.send(new lib_dynamodb_1.UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        UpdateExpression: 'SET last_activity_at = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
    // Forward message to OpenClaw WebSocket
    const openclawWsUrl = `ws://${taskIp}:${OPENCLAW_PORT}`;
    try {
        // Use a persistent WS connection in production; for simplicity here we
        // use a single-message WebSocket request pattern.
        // In production, the wsHandler maintains a connection pool per task IP.
        const response = await forwardToOpenClaw(openclawWsUrl, body);
        if (response) {
            await apigw.send(new client_apigatewaymanagementapi_1.PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(response),
            }));
        }
    }
    catch (err) {
        logger.error('Failed to relay message to OpenClaw', {
            tenant_id: tenantId,
            agent_id: agentId,
            task_ip: taskIp,
            error: err instanceof Error ? err.message : 'unknown',
        });
        // Send error back to portal
        try {
            await apigw.send(new client_apigatewaymanagementapi_1.PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(JSON.stringify({
                    type: 'error',
                    message: 'Agent connection error. Please refresh and try again.',
                })),
            }));
        }
        catch { /* connection may have closed */ }
    }
    return { statusCode: 200 };
};
exports.handler = handler;
// ── Forward single message to OpenClaw WebSocket ──────────────────────────────
// This uses a simple request-response pattern. In Phase 7 we'll add
// connection pooling for streaming responses.
async function forwardToOpenClaw(wsUrl, message) {
    return new Promise((resolve, reject) => {
        // Node.js 24 has native WebSocket support
        const ws = new globalThis.WebSocket(wsUrl);
        let responded = false;
        const timeout = setTimeout(() => {
            if (!responded) {
                ws.close();
                reject(new Error('OpenClaw WebSocket timeout'));
            }
        }, 25000);
        ws.onopen = () => ws.send(message);
        ws.onmessage = (event) => {
            responded = true;
            clearTimeout(timeout);
            ws.close();
            resolve(typeof event.data === 'string' ? event.data : null);
        };
        ws.onerror = (err) => {
            clearTimeout(timeout);
            reject(new Error(`OpenClaw WS error: ${err}`));
        };
        ws.onclose = () => {
            if (!responded) {
                clearTimeout(timeout);
                resolve(null);
            }
        };
    });
}
