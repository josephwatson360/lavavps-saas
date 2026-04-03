import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { createLogger } from '../../layer/src/logger';

// ─────────────────────────────────────────────────────────────────────────────
// taskWatcherLambda
//
// Runs every 2 minutes via EventBridge scheduled rule.
// Two responsibilities:
//
//   1. Idle timeout enforcement
//      Scans GSI-2 (byAgentStatus) for RUNNING tasks.
//      Any task where last_activity_at > plan idle_timeout_min → StopTask.
//
//   2. Crash loop detection
//      If an agent restarts 3+ times within 10 minutes → SUSPEND it.
//      Sends SNS alert to ops team and notification to tenant.
//
// This runs as a scheduled Lambda — no API Gateway trigger.
// ─────────────────────────────────────────────────────────────────────────────

const logger = createLogger('taskWatcherLambda');
const ecs    = new ECSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns    = new SNSClient({});

const TABLE_NAME   = process.env.TABLE_NAME!;
const CLUSTER_NAME = process.env.CLUSTER_NAME!;
const OPS_SNS_ARN  = process.env.OPS_SNS_ARN ?? '';

const PLAN_IDLE_TIMEOUTS: Record<string, number> = {
  starter:  15,  // minutes
  pro:      30,
  business: 60,
};

const CRASH_LOOP_THRESHOLD = 3;    // failures within...
const CRASH_LOOP_WINDOW    = 10;   // ...minutes

export const handler = async (): Promise<void> => {
  const now = new Date();
  logger.info('Task watcher starting', { timestamp: now.toISOString() });

  // Scan for all RUNNING tasks
  const runningResult = await dynamo.send(new QueryCommand({
    TableName:              TABLE_NAME,
    IndexName:              'byAgentStatus',
    KeyConditionExpression: 'gsi2pk = :status',
    ExpressionAttributeValues: { ':status': 'STATUS#RUNNING' },
    ProjectionExpression:   'pk, sk, tenant_id, agent_id, plan_code, task_arn, last_activity_at, idle_timeout_min, restart_count, last_restart_at',
  }));

  const runningTasks = runningResult.Items ?? [];
  logger.info(`Found ${runningTasks.length} running tasks`);

  let stopped = 0;
  let suspended = 0;

  for (const task of runningTasks) {
    const tenantId   = task.tenant_id as string;
    const agentId    = task.agent_id  as string;
    const planCode   = task.plan_code as string ?? 'starter';
    const taskArn    = task.task_arn  as string | undefined;

    // ── Check idle timeout ──────────────────────────────────────────────
    const idleTimeoutMin    = (task.idle_timeout_min as number)
      ?? PLAN_IDLE_TIMEOUTS[planCode]
      ?? 15;
    const lastActivityAt    = task.last_activity_at as string | undefined;
    const lastActivity      = lastActivityAt ? new Date(lastActivityAt) : null;
    const idleMs            = lastActivity
      ? now.getTime() - lastActivity.getTime()
      : Infinity;
    const idleTimeoutMs     = idleTimeoutMin * 60 * 1000;

    if (idleMs > idleTimeoutMs) {
      logger.info('Stopping idle task', {
        tenant_id:      tenantId,
        agent_id:       agentId,
        idle_minutes:   Math.round(idleMs / 60000),
        timeout_minutes: idleTimeoutMin,
      });

      if (taskArn) {
        try {
          await ecs.send(new StopTaskCommand({
            cluster: CLUSTER_NAME,
            task:    taskArn,
            reason:  `Idle timeout: ${idleTimeoutMin} minutes`,
          }));
        } catch (err) {
          logger.warn('ECS StopTask failed for idle task', {
            tenant_id: tenantId,
            agent_id:  agentId,
            task_arn:  taskArn,
            error:     err instanceof Error ? err.message : 'unknown',
          });
        }
      }

      await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        UpdateExpression: 'SET #s = :s, task_arn = :null, gsi2pk = :gsi2pk, gsi2sk = :now, updated_at = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s':      'STOPPED',
          ':null':   null,
          ':gsi2pk': 'STATUS#STOPPED',
          ':now':    now.toISOString(),
        },
      }));

      stopped++;
      continue;
    }

    // ── Check crash loop ────────────────────────────────────────────────
    const restartCount   = (task.restart_count as number)  ?? 0;
    const lastRestartAt  = task.last_restart_at as string | undefined;
    const lastRestart    = lastRestartAt ? new Date(lastRestartAt) : null;
    const restartAgeMs   = lastRestart ? now.getTime() - lastRestart.getTime() : Infinity;
    const windowMs       = CRASH_LOOP_WINDOW * 60 * 1000;

    if (restartCount >= CRASH_LOOP_THRESHOLD && restartAgeMs < windowMs) {
      logger.error('Crash loop detected — suspending agent', {
        tenant_id:     tenantId,
        agent_id:      agentId,
        restart_count: restartCount,
        window_minutes: CRASH_LOOP_WINDOW,
      });

      if (taskArn) {
        try {
          await ecs.send(new StopTaskCommand({
            cluster: CLUSTER_NAME,
            task:    taskArn,
            reason:  `Crash loop: ${restartCount} restarts in ${CRASH_LOOP_WINDOW} minutes`,
          }));
        } catch { /* continue with suspension even if stop fails */ }
      }

      await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        UpdateExpression: 'SET #s = :s, task_arn = :null, gsi2pk = :gsi2pk, gsi2sk = :now, restart_count = :zero, suspended_at = :now, updated_at = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s':      'SUSPENDED',
          ':null':   null,
          ':gsi2pk': 'STATUS#SUSPENDED',
          ':now':    now.toISOString(),
          ':zero':   0,
        },
      }));

      // Alert ops team
      if (OPS_SNS_ARN) {
        try {
          await sns.send(new PublishCommand({
            TopicArn: OPS_SNS_ARN,
            Subject:  `[LavaVPS] Agent Suspended - Crash Loop`,
            Message:  JSON.stringify({
              event:         'AGENT_SUSPENDED_CRASH_LOOP',
              tenant_id:     tenantId,
              agent_id:      agentId,
              restart_count: restartCount,
              timestamp:     now.toISOString(),
            }),
          }));
        } catch { /* non-critical */ }
      }

      suspended++;
    }
  }

  logger.info('Task watcher complete', { stopped, suspended, checked: runningTasks.length });
};
