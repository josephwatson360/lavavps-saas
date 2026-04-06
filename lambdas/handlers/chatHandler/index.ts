import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../layer/src/logger';

// ── Lambda Response Streaming types ──────────────────────────────────────────
// awslambda is injected by the Lambda runtime — declare types for TypeScript.
declare const awslambda: {
  streamifyResponse: (
    handler: (event: any, responseStream: NodeJS.WritableStream) => Promise<void>
  ) => any;
  HttpResponseStream: {
    from: (
      stream: NodeJS.WritableStream,
      metadata: { statusCode: number; headers?: Record<string, string> }
    ) => NodeJS.WritableStream;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// chatHandler
//
// Streams chat completions from OpenClaw to the portal using Lambda
// Response Streaming. The portal sends a POST with a JSON body containing
// the user message; this handler proxies to OpenClaw's OpenAI-compatible
// /v1/chat/completions endpoint and pipes the SSE stream back.
//
// Auth:    Cognito JWT from Authorization header (validated by API Gateway
//          JWT authorizer or manually here for HTTP API).
//
// OpenClaw auth: trusted-proxy mode. Lambda subnet CIDRs are in OpenClaw's
//          trustedProxies list (locked in configRenderer). This handler
//          passes x-amzn-oidc-identity so OpenClaw knows who the user is.
//
// Route:   POST /chat/{agentId}
// ─────────────────────────────────────────────────────────────────────────────

const logger     = createLogger('chatHandler');
const dynamo     = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;
const OPENCLAW_PORT = process.env.OPENCLAW_PORT ?? '18789';

function badRequest(message: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 400, body: JSON.stringify({ error: 'BAD_REQUEST', message }) };
}

function unauthorized(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 401, body: JSON.stringify({ error: 'UNAUTHORIZED' }) };
}

function serviceUnavailable(message: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 503, body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE', message }) };
}

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream: NodeJS.WritableStream) => {

    // ── Extract tenant context from JWT claims ─────────────────────────────
    const authorizer = (event.requestContext as any).authorizer;
    const tenantId   = authorizer?.lambda?.tenant_id
                    ?? authorizer?.jwt?.claims?.['custom:tenant_id']
                    ?? authorizer?.claims?.['custom:tenant_id'];
    const userId     = authorizer?.lambda?.sub
                    ?? authorizer?.jwt?.claims?.sub
                    ?? authorizer?.claims?.sub
                    ?? 'unknown';

    if (!tenantId) {
      logger.warn('chatHandler: missing tenant context');
      const httpResponseMetadata = {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
      };
      responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);
      responseStream.write(JSON.stringify({ error: 'UNAUTHORIZED' }));
      responseStream.end();
      return;
    }

    const agentId = event.pathParameters?.agentId;
    if (!agentId) {
      const meta = { statusCode: 400, headers: { 'Content-Type': 'application/json' } };
      responseStream = awslambda.HttpResponseStream.from(responseStream, meta);
      responseStream.write(JSON.stringify({ error: 'BAD_REQUEST', message: 'Missing agentId' }));
      responseStream.end();
      return;
    }

    // ── Parse request body ─────────────────────────────────────────────────
    let body: { messages?: Array<{role: string; content: string}>; model?: string; stream?: boolean };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      const meta = { statusCode: 400, headers: { 'Content-Type': 'application/json' } };
      responseStream = awslambda.HttpResponseStream.from(responseStream, meta);
      responseStream.write(JSON.stringify({ error: 'BAD_REQUEST', message: 'Invalid JSON body' }));
      responseStream.end();
      return;
    }

    // ── Get agent record from DynamoDB ─────────────────────────────────────
    const agentResult = await dynamo.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));

    if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
      const meta = { statusCode: 404, headers: { 'Content-Type': 'application/json' } };
      responseStream = awslambda.HttpResponseStream.from(responseStream, meta);
      responseStream.write(JSON.stringify({ error: 'NOT_FOUND', message: 'Agent not found' }));
      responseStream.end();
      return;
    }

    const status  = agentResult.Item.status as string;
    const taskIp  = agentResult.Item.task_private_ip as string | undefined;

    if (status !== 'RUNNING' || !taskIp) {
      const meta = { statusCode: 503, headers: { 'Content-Type': 'application/json' } };
      responseStream = awslambda.HttpResponseStream.from(responseStream, meta);
      responseStream.write(JSON.stringify({
        error:   'SERVICE_UNAVAILABLE',
        message: status === 'STARTING' ? 'Agent is starting' : 'Agent is not running',
        status,
      }));
      responseStream.end();
      return;
    }

    // ── Set up streaming response headers ──────────────────────────────────
    const httpResponseMetadata = {
      statusCode: 200,
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata);

    // ── Proxy to OpenClaw /v1/chat/completions ─────────────────────────────
    const openclawUrl = `http://${taskIp}:${OPENCLAW_PORT}/v1/chat/completions`;

    const openclawBody = {
      model:    `openclaw/${agentId}`,
      messages: body.messages ?? [],
      stream:   true,
      user:     `${tenantId}:${agentId}`,  // stable session key per user+agent
    };

    logger.info('Proxying to OpenClaw', { tenantId, agentId, taskIp, userId });

    try {
      const response = await fetch(openclawUrl, {
        method:  'POST',
        headers: {
          'Content-Type':          'application/json',
          'x-amzn-oidc-identity':  userId,  // trusted-proxy identity header
        },
        body: JSON.stringify(openclawBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('OpenClaw error response', { status: response.status, body: errorText });
        responseStream.write(`data: ${JSON.stringify({ error: 'OPENCLAW_ERROR', status: response.status })}\n\n`);
        responseStream.end();
        return;
      }

      // ── Pipe SSE stream from OpenClaw to portal ────────────────────────
      if (!response.body) {
        responseStream.write('data: [DONE]\n\n');
        responseStream.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        responseStream.write(chunk);
      }

      responseStream.end();
      logger.info('Stream complete', { tenantId, agentId });

    } catch (err) {
      logger.error('Failed to proxy to OpenClaw', {
        tenantId, agentId, taskIp,
        error: err instanceof Error ? err.message : 'unknown',
      });
      responseStream.write(`data: ${JSON.stringify({ type: 'error', message: 'Agent connection error' })}\n\n`);
      responseStream.end();
    }
  }
);
