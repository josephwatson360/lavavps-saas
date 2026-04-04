"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// API Response Helpers — Lambda Layer Utility
//
// CORS: uses * since we authenticate via Bearer token (not cookies).
// Bearer-token auth is not a "credentialed" CORS request, so * is valid.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.created = created;
exports.noContent = noContent;
exports.badRequest = badRequest;
exports.unauthorized = unauthorized;
exports.forbidden = forbidden;
exports.notFound = notFound;
exports.unprocessable = unprocessable;
exports.tooManyRequests = tooManyRequests;
exports.internalError = internalError;
exports.parseBody = parseBody;
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amzn-Trace-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Content-Type': 'application/json',
};
function ok(body) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
function created(body) {
    return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
function noContent() {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}
function badRequest(message, details) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BAD_REQUEST', message, details }) };
}
function unauthorized() {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication required' }) };
}
function forbidden(message = 'Access denied') {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'FORBIDDEN', message }) };
}
function notFound(resource) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'NOT_FOUND', message: `${resource} not found` }) };
}
function unprocessable(message, validationErrors) {
    return { statusCode: 422, headers: CORS_HEADERS, body: JSON.stringify({ error: 'UNPROCESSABLE', message, validationErrors }) };
}
function tooManyRequests(message = 'Rate limit exceeded') {
    return { statusCode: 429, headers: CORS_HEADERS, body: JSON.stringify({ error: 'TOO_MANY_REQUESTS', message }) };
}
function internalError(message = 'Internal server error') {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'INTERNAL_ERROR', message }) };
}
function parseBody(body) {
    if (!body)
        return null;
    try {
        return JSON.parse(body);
    }
    catch {
        return null;
    }
}
