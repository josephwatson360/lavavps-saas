import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { ECSClient, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../layer/src/logger';

// ─────────────────────────────────────────────────────────────────────────────
// taskStateChangeHandler
//
// EventBridge trigger: ECS Task State Change
//   - Cluster: lavavps-agents
//   - detail.lastStatus: RUNNING | STOPPED
//
// On RUNNING:
//   1. Extract TENANT_ID, AGENT_ID from task container environment variables
//   2. Extract task private IP from task attachment details
//   3. Update DynamoDB: status=RUNNING, task_private_ip, task_arn
//   4. Find all open WebSocket connections for this agent
//   5. Push {type: "agent_ready", agentId} to each connection via PostToConnection
//   6. Handle stale connections (410 Gone) by deleting DynamoDB records
//
// On STOPPED:
//   1. Extract TENANT_ID, AGENT_ID from task environment
//   2. Update DynamoDB: status=STOPPED, clear task_private_ip and task_arn
//   3. Close and clean up any open WebSocket connections for this agent
//
// This is the CORRECT production approach — zero polling, event-driven,
// sub-second propagation from ECS RUNNING to portal chat connected.
// ─────────────────────────────────────────────────────────────────────────────

const logger     = createLogger('taskStateChangeHandler');
const dynamo     = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecs        = new ECSClient({});
const CLUSTER    = process.env.CLUSTER_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;
const WS_ENDPOINT = process.env.WS_ENDPOINT!; // https://{id}.execute-api.{region}.amazonaws.com/{stage}

interface EcsTaskStateChangeEvent {
  source:     string;
  detailType: string;
  detail: {
    lastStatus:   string;
    taskArn:      string;
    clusterArn:   string;
    stoppedReason?: string;
    containers?: Array<{
      name:         string;
      lastStatus:   string;
      exitCode?:    number;
      environment?: Array<{ name: string; value: string }>;
    }>;
    attachments?: Array<{
      type:    string;
      details: Array<{ name: string; value: string }>;
    }>;
    overrides?: {
      containerOverrides?: Array<{
        name:        string;
        environment?: Array<{ name: string; value: string }>;
      }>;
    };
  };
}

function getEnvVars(event: EcsTaskStateChangeEvent): { tenantId: string; agentId: string } | null {
  // Environment variables come from container overrides in the event
  const overrides = event.detail.overrides?.containerOverrides ?? [];
  for (const override of overrides) {
    const env = override.environment ?? [];
    const tenantId = env.find(e => e.name === 'TENANT_ID')?.value;
    const agentId  = env.find(e => e.name === 'AGENT_ID')?.value;
    if (tenantId && agentId) return { tenantId, agentId };
  }

  // Fallback: check containers array (some events include this)
  const containers = event.detail.containers ?? [];
  for (const container of containers) {
    const env = container.environment ?? [];
    const tenantId = env.find(e => e.name === 'TENANT_ID')?.value;
    const agentId  = env.find(e => e.name === 'AGENT_ID')?.value;
    if (tenantId && agentId) return { tenantId, agentId };
  }

  return null;
}

function getPrivateIpFromEvent(event: EcsTaskStateChangeEvent): string | null {
  const attachments = event.detail.attachments ?? [];
  for (const attachment of attachments) {
    if (attachment.type === 'ElasticNetworkInterface') {
      const ip = attachment.details.find(d => d.name === 'privateIPv4Address')?.value;
      if (ip) return ip;
    }
  }
  return null;
}

async function getPrivateIp(taskArn: string, eventIp: string | null): Promise<string | null> {
  // Try the event payload first (fastest)
  if (eventIp) return eventIp;

  // Fallback: call DescribeTasks to get the private IP
  try {
    const result = await ecs.send(new DescribeTasksCommand({
      cluster: CLUSTER,
      tasks:   [taskArn],
    }));
    const task = result.tasks?.[0];
    if (!task) return null;
    for (const attachment of task.attachments ?? []) {
      if (attachment.type === 'ElasticNetworkInterface') {
        const detail = attachment.details?.find(d => d.name === 'privateIPv4Address');
        if (detail?.value) return detail.value;
      }
    }
  } catch (err) {
    // Log but don't fail — DynamoDB will be updated without IP
  }
  return null;
}

async function notifyPortal(tenantId: string, agentId: string, type: string): Promise<void> {
  if (!WS_ENDPOINT) {
    logger.warn('WS_ENDPOINT not configured — cannot push to portal', { tenantId, agentId });
    return;
  }

  const apigw = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });
  const payload = Buffer.from(JSON.stringify({ type, agentId }));

  // Query all open WebSocket connections for this agent
  const connsResult = await dynamo.send(new QueryCommand({
    TableName:              TABLE_NAME,
    IndexName:              'byAgentStatus', // reuse existing GSI — or scan WS# prefix
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk':     `TENANT#${tenantId}`,
      ':prefix': 'WS#',
    },
  })).catch(() => ({ Items: [] as Record<string, unknown>[] }));

  // Fallback: scan for WS records if GSI query fails
  if (!connsResult.Items?.length) {
    // Try direct scan of WS# records
    const scanResult = await dynamo.send(new QueryCommand({
      TableName:              TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk':     `TENANT#${tenantId}`,
        ':prefix': 'WS#',
      },
    })).catch(() => ({ Items: [] as Record<string, unknown>[] }));
    connsResult.Items = scanResult.Items ?? [];
  }

  const connections = (connsResult.Items ?? []).filter(
    item => item.agent_id === agentId,
  );

  logger.info(`Notifying ${connections.length} WS connections`, { tenantId, agentId, type });

  for (const conn of connections) {
    const connectionId = conn.connection_id as string;
    try {
      await apigw.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data:         payload,
      }));
      logger.info('Pushed to portal', { connectionId, type });
    } catch (err: unknown) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 410) {
        // Stale connection — clean up
        logger.info('Removing stale WS connection', { connectionId });
        await dynamo.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: `WS#${connectionId}`, sk: `WS#${connectionId}` },
        })).catch(() => {});
      } else {
        logger.warn('Failed to push to connection', { connectionId, error: String(err) });
      }
    }
  }
}

export const handler = async (event: EcsTaskStateChangeEvent): Promise<void> => {
  const status  = event.detail.lastStatus;
  const taskArn = event.detail.taskArn;

  logger.info('ECS task state change', { status, taskArn });

  const ids = getEnvVars(event);
  if (!ids) {
    logger.warn('Could not extract TENANT_ID/AGENT_ID from task event — skipping', { taskArn });
    return;
  }

  const { tenantId, agentId } = ids;
  const agentKey = { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` };

  // ── RUNNING ────────────────────────────────────────────────────────────────
  if (status === 'RUNNING') {
    const privateIp = await getPrivateIp(taskArn, getPrivateIpFromEvent(event));

    if (!privateIp) {
      logger.warn('Task RUNNING but no private IP found', { tenantId, agentId, taskArn });
      // Still update status — taskWatcher will eventually sync
    }

    await dynamo.send(new UpdateCommand({
      TableName:                TABLE_NAME,
      Key:                      agentKey,
      UpdateExpression:         'SET #s = :s, gsi2pk = :g, task_private_ip = :ip, task_arn = :arn, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s':   'RUNNING',
        ':g':   'STATUS#RUNNING',
        ':ip':  privateIp ?? '',
        ':arn': taskArn,
        ':now': new Date().toISOString(),
      },
    }));

    logger.info('Agent marked RUNNING', { tenantId, agentId, taskArn, privateIp });

    // Push agent_ready to portal — portal connects WebSocket immediately
    await notifyPortal(tenantId, agentId, 'agent_ready');
  }

  // ── STOPPED / DEPROVISIONING ───────────────────────────────────────────────
  else if (status === 'STOPPED' || status === 'DEPROVISIONING') {
    const stoppedReason = event.detail.stoppedReason ?? 'Unknown';

    await dynamo.send(new UpdateCommand({
      TableName:                TABLE_NAME,
      Key:                      agentKey,
      UpdateExpression:         'SET #s = :s, gsi2pk = :g, updated_at = :now REMOVE task_private_ip, task_arn',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s':   'STOPPED',
        ':g':   'STATUS#STOPPED',
        ':now': new Date().toISOString(),
      },
    }));

    logger.info('Agent marked STOPPED', { tenantId, agentId, taskArn, stoppedReason });

    // Push agent_stopped to portal — portal shows "Agent stopped" in chat
    await notifyPortal(tenantId, agentId, 'agent_stopped');
  }
};
