import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../layer/src/logger';
import { ok, created, badRequest, forbidden, notFound, parseBody } from '../../layer/src/response';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// jobHandler  (Pro+ only — Ralph Loop autonomous tasks)
//
// GET    /agents/{agentId}/jobs           - List jobs for agent
// POST   /agents/{agentId}/jobs           - Create and start a new job
// GET    /agents/{agentId}/jobs/{jobId}   - Get job status + progress
// DELETE /agents/{agentId}/jobs/{jobId}   - Stop a running job
//
// A "job" is a tasks.md uploaded to the agent workspace that OpenClaw
// runs autonomously. The job record tracks progress, status, and results.
// Max iterations are enforced by the OpenClaw runtime (not here).
// ─────────────────────────────────────────────────────────────────────────────

const logger = createLogger('jobHandler');
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const tenantId = event.requestContext.authorizer?.claims?.['custom:tenant_id'] as string;
  const planCode  = event.requestContext.authorizer?.claims?.['custom:plan_code'] as string ?? 'starter';
  const agentId  = event.pathParameters?.agentId;
  const jobId    = event.pathParameters?.jobId;

  if (!tenantId || !agentId) return badRequest('Missing tenant or agent context');

  // Ralph Loop is Pro+ only
  if (!['pro', 'business'].includes(planCode)) {
    return {
      statusCode: 402,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:   'PLAN_REQUIRED',
        message: 'Autonomous tasks (Ralph Loop) require Pro or Business plan.',
      }),
    };
  }

  // Verify agent belongs to tenant
  const agentResult = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
  }));

  if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
    return notFound('Agent');
  }

  // ── GET /jobs — list all jobs for agent ───────────────────────────────
  if (event.httpMethod === 'GET' && !jobId) {
    const result = await dynamo.send(new QueryCommand({
      TableName:              TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk':     `TENANT#${tenantId}`,
        ':prefix': `JOB#${agentId}#`,
      },
      ScanIndexForward: false, // newest first
      Limit:            20,
    }));

    return ok({
      jobs: (result.Items ?? []).map(formatJob),
    });
  }

  // ── GET /jobs/{jobId} ─────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && jobId) {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `JOB#${agentId}#${jobId}` },
    }));

    if (!result.Item) return notFound('Job');
    return ok(formatJob(result.Item));
  }

  // ── POST /jobs — create new job ───────────────────────────────────────
  if (event.httpMethod === 'POST' && !jobId) {
    const body = parseBody<{
      title:         string;
      tasks:         string;   // Markdown task list (will be written as tasks.md)
      maxIterations?: number;
    }>(event.body);

    if (!body?.title || !body?.tasks) {
      return badRequest('Request body must include title and tasks (markdown task list)');
    }

    // Enforce maxIterations limit
    const maxIterations = Math.min(
      body.maxIterations ?? 10,
      (agentResult.Item.config_ralphLoopMaxIterations as number) ?? 50,
    );

    const newJobId = randomUUID();
    const now      = new Date().toISOString();

    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk:              `TENANT#${tenantId}`,
        sk:              `JOB#${agentId}#${newJobId}`,
        job_id:          newJobId,
        agent_id:        agentId,
        tenant_id:       tenantId,
        title:           body.title.slice(0, 200),
        tasks_markdown:  body.tasks.slice(0, 50000), // 50KB limit
        status:          'PENDING',
        max_iterations:  maxIterations,
        iteration_count: 0,
        created_at:      now,
        updated_at:      now,
        ttl:             Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 day TTL
      },
    }));

    // Note: actual job execution is triggered by the portal writing tasks.md
    // to the agent's EFS workspace and sending a start command via WebSocket.
    // The job record here tracks status/progress only.

    logger.info('Job created', { tenant_id: tenantId, agent_id: agentId, job_id: newJobId });

    return created({
      jobId:         newJobId,
      status:        'PENDING',
      maxIterations,
      message:       'Job created. Start your agent and send the job ID to begin execution.',
    });
  }

  // ── DELETE /jobs/{jobId} — stop running job ───────────────────────────
  if (event.httpMethod === 'DELETE' && jobId) {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `JOB#${agentId}#${jobId}` },
    }));

    if (!result.Item) return notFound('Job');

    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `JOB#${agentId}#${jobId}` },
      UpdateExpression: 'SET #s = :s, updated_at = :now',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'CANCELLED', ':now': new Date().toISOString() },
    }));

    return ok({ message: 'Job cancelled', jobId });
  }

  return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};

function formatJob(item: Record<string, unknown>) {
  return {
    jobId:          item.job_id,
    title:          item.title,
    status:         item.status,
    maxIterations:  item.max_iterations,
    iterationCount: item.iteration_count ?? 0,
    createdAt:      item.created_at,
    updatedAt:      item.updated_at,
    completedAt:    item.completed_at ?? null,
    result:         item.result ?? null,
  };
}
