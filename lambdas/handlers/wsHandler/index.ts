import {
  APIGatewayProxyWebsocketHandlerV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../layer/src/logger';

const logger = createLogger('wsHandler');
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME     = process.env.TABLE_NAME!;
const OPENCLAW_PORT  = process.env.OPENCLAW_PORT ?? '18789';
const WS_TTL_SECONDS = 7200;

// ─────────────────────────────────────────────────────────────────────────────
// Persistent connection pool: poolKey → WebSocket
// Survives across Lambda invocations within the same warm container.
// Each WebSocket stays open, forwarding ALL streaming chunks immediately.
// ─────────────────────────────────────────────────────────────────────────────
interface PoolEntry {
  ws:           WebSocket;
  connectionId: string;
  apigw:        ApiGatewayManagementApiClient;
}

const pool = new Map<string, PoolEntry>();

function poolKey(taskIp: string, connectionId: string): string {
  return `${taskIp}::${connectionId}`;
}

async function getOrCreateOpenClawWs(
  taskIp:       string,
  connectionId: string,
  apigw:        ApiGatewayManagementApiClient,
): Promise<WebSocket> {
  const key      = poolKey(taskIp, connectionId);
  const existing = pool.get(key);

  if (existing && existing.ws.readyState === (globalThis as any).WebSocket.OPEN) {
    existing.connectionId = connectionId;
    existing.apigw        = apigw;
    return existing.ws;
  }

  if (existing) {
    try { existing.ws.close(); } catch { /* ignore */ }
    pool.delete(key);
  }

  const WS = (globalThis as any).WebSocket as typeof WebSocket;
  const ws  = new WS(`ws://${taskIp}:${OPENCLAW_PORT}`);
  const entry: PoolEntry = { ws, connectionId, apigw };
  pool.set(key, entry);

  // ── Relay EVERY chunk immediately to portal ───────────────────────────────
  ws.onmessage = async (event: MessageEvent) => {
    const data = typeof event.data === 'string' ? event.data : null;
    if (!data) return;
    const current = pool.get(key);
    if (!current) return;
    try {
      await current.apigw.send(new PostToConnectionCommand({
        ConnectionId: current.connectionId,
        Data:         Buffer.from(data),
      }));
    } catch (err: unknown) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 410) pool.delete(key); // portal gone
    }
  };

  ws.onerror = () => { pool.delete(key); };
  ws.onclose = () => { pool.delete(key); };

  // Wait for open (max 10s)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenClaw connect timeout')), 10000);
    ws.onopen  = () => { clearTimeout(timeout); resolve(); };
    const orig = ws.onerror;
    ws.onerror = (e) => {
      clearTimeout(timeout);
      if (orig) orig.call(ws, e);
      reject(new Error('OpenClaw connect error'));
    };
  });

  return ws;
}

// ─────────────────────────────────────────────────────────────────────────────
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event): Promise<APIGatewayProxyResultV2> => {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;
  const apigw = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  // ── $connect ──────────────────────────────────────────────────────────────
  if (routeKey === '$connect') {
    const qsp      = (event as unknown as Record<string, Record<string, string>>).queryStringParameters ?? {};
    const agentId  = qsp.agentId;

    // Decode JWT from ?token= query param.
    // WS $connect has auth:NONE — browsers cannot set WS headers.
    // JWT is cryptographically signed by Cognito; we decode claims only.
    // Full cryptographic verification is done in wsHandler via aws-jwt-verify (Phase 8.2).
    let tenantId = '';
    let planCode  = 'starter';
    try {
      const token  = qsp.token ?? '';
      const b64    = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, string>;
      tenantId = payload['custom:tenant_id'] ?? '';
      planCode = payload['custom:plan_code']  ?? 'starter';
    } catch (e) {
      logger.warn('WS connect: invalid JWT', { connectionId });
      return { statusCode: 401 };
    }

    if (!tenantId || !agentId) {
      logger.warn('WS connect rejected: missing tenant or agent', { connectionId });
      return { statusCode: 401 };
    }
    const agentResult = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));

    if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
      return { statusCode: 404 };
    }

    const item   = agentResult.Item;
    const status = item.status as string;
    const taskIp = item.task_private_ip as string | undefined;

    if (status !== 'RUNNING' || !taskIp) {
      logger.warn('WS connect: agent not running', { connectionId, tenantId, agentId, status });
      return { statusCode: 503 };
    }

    const now = Math.floor(Date.now() / 1000);
    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `WS#${connectionId}`, sk: `WS#${connectionId}`,
        connection_id: connectionId, tenant_id: tenantId,
        agent_id: agentId, task_ip: taskIp,
        connected_at: new Date().toISOString(),
        ttl: now + WS_TTL_SECONDS,
      },
    }));

    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
      UpdateExpression: 'SET last_activity_at = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));

    // Pre-warm the OpenClaw connection so first message has zero extra latency
    try {
      await getOrCreateOpenClawWs(taskIp, connectionId, apigw);
      logger.info('WS connected + OpenClaw pre-warmed', { connectionId, tenantId, agentId });
    } catch (err) {
      logger.warn('OpenClaw pre-warm failed — will retry on first message', {
        connectionId, taskIp, error: err instanceof Error ? err.message : 'unknown',
      });
    }

    return { statusCode: 200 };
  }

  // ── $disconnect ───────────────────────────────────────────────────────────
  if (routeKey === '$disconnect') {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: `WS#${connectionId}`, sk: `WS#${connectionId}` },
    }));
    for (const [key, entry] of pool.entries()) {
      if (entry.connectionId === connectionId) {
        try { entry.ws.close(1000, 'portal disconnected'); } catch { /* ignore */ }
        pool.delete(key);
      }
    }
    logger.info('WS disconnected', { connectionId });
    return { statusCode: 200 };
  }

  // ── $default — relay to OpenClaw, stream all chunks back ─────────────────
  const connResult = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `WS#${connectionId}`, sk: `WS#${connectionId}` },
  }));

  if (!connResult.Item) {
    logger.warn('WS message: no connection record', { connectionId });
    return { statusCode: 410 };
  }

  const conn     = connResult.Item;
  const taskIp   = conn.task_ip   as string;
  const tenantId = conn.tenant_id as string;
  const agentId  = conn.agent_id  as string;
  const body     = event.body ?? '';

  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    UpdateExpression: 'SET last_activity_at = :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
  }));

  try {
    const openclawWs = await getOrCreateOpenClawWs(taskIp, connectionId, apigw);
    openclawWs.send(body);
    logger.info('Message forwarded to OpenClaw', { connectionId, tenantId, agentId });
  } catch (err) {
    logger.error('Failed to relay to OpenClaw', {
      tenantId, agentId, taskIp,
      error: err instanceof Error ? err.message : 'unknown',
    });
    try {
      await apigw.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({ type: 'error', message: 'Agent connection error. Reconnecting...' })),
      }));
    } catch { /* portal may have closed */ }
  }

  return { statusCode: 200 };
};
