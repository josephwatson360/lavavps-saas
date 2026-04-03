// ─────────────────────────────────────────────────────────────────────────────
// API Response Helpers — Lambda Layer Utility
//
// All Lambda handlers use these helpers for consistent response formatting.
// Includes CORS headers for the portal origin.
// ─────────────────────────────────────────────────────────────────────────────

import { APIGatewayProxyResult } from 'aws-lambda';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  'https://lavavps.ai',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amzn-Trace-Id',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Content-Type':                 'application/json',
};

export function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers:    CORS_HEADERS,
    body:       JSON.stringify(body),
  };
}

export function created(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 201,
    headers:    CORS_HEADERS,
    body:       JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyResult {
  return {
    statusCode: 204,
    headers:    CORS_HEADERS,
    body:       '',
  };
}

export function badRequest(message: string, details?: unknown): APIGatewayProxyResult {
  return {
    statusCode: 400,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'BAD_REQUEST', message, details }),
  };
}

export function unauthorized(): APIGatewayProxyResult {
  return {
    statusCode: 401,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication required' }),
  };
}

export function forbidden(message = 'Access denied'): APIGatewayProxyResult {
  return {
    statusCode: 403,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'FORBIDDEN', message }),
  };
}

export function notFound(resource: string): APIGatewayProxyResult {
  return {
    statusCode: 404,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'NOT_FOUND', message: `${resource} not found` }),
  };
}

export function unprocessable(message: string, validationErrors?: unknown[]): APIGatewayProxyResult {
  return {
    statusCode: 422,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'UNPROCESSABLE', message, validationErrors }),
  };
}

export function tooManyRequests(message = 'Rate limit exceeded'): APIGatewayProxyResult {
  return {
    statusCode: 429,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'TOO_MANY_REQUESTS', message }),
  };
}

export function internalError(message = 'Internal server error'): APIGatewayProxyResult {
  return {
    statusCode: 500,
    headers:    CORS_HEADERS,
    body:       JSON.stringify({ error: 'INTERNAL_ERROR', message }),
  };
}

/** Parse and validate a JSON request body. Returns null if invalid. */
export function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
