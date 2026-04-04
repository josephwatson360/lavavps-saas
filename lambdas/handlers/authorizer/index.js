"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const aws_jwt_verify_1 = require("aws-jwt-verify");
const logger_1 = require("./logger");
// ─────────────────────────────────────────────────────────────────────────────
// authorizerHandler
//
// Custom Lambda authorizer for API Gateway REST and WebSocket APIs.
// Validates Cognito JWTs and extracts tenant context into the auth context
// object that is passed to every downstream Lambda as event.requestContext.authorizer.
//
// Auth context fields propagated downstream:
//   tenantId    - the tenant's unique ID (from custom:tenant_id Cognito attribute)
//   planCode    - starter | pro | business (from custom:plan_code)
//   role        - owner | member (from custom:role)
//   sub         - Cognito user sub (unique per user)
//   email       - user email address
//
// For WebSocket $connect: token passed as query param ?token=<jwt>
// For REST: token in Authorization header as Bearer <jwt>
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('authorizerHandler');
// Verifier is initialized once outside the handler (reused across warm invocations)
const verifier = aws_jwt_verify_1.CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID,
    tokenUse: 'access',
    clientId: process.env.USER_POOL_CLIENT_ID,
});
const handler = async (event) => {
    // Extract token from Authorization header or query string (for WebSocket)
    let token;
    if (event.headers?.Authorization) {
        const authHeader = event.headers.Authorization;
        token = authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : authHeader;
    }
    else if (event.queryStringParameters?.token) {
        // WebSocket $connect passes JWT as query param (browsers can't set WS headers)
        token = event.queryStringParameters.token;
    }
    if (!token) {
        logger.warn('No token found in request', {
            path: event.path,
            method: event.httpMethod,
        });
        return denyPolicy('unknown', event.methodArn);
    }
    try {
        const payload = await verifier.verify(token);
        // Extract custom Cognito attributes from JWT claims
        const tenantId = payload['custom:tenant_id'];
        const planCode = payload['custom:plan_code'];
        const role = payload['custom:role'];
        if (!tenantId) {
            // User registered but provisioning hasn't completed yet
            logger.warn('JWT missing tenant_id - provisioning may be incomplete', {
                sub: payload.sub,
            });
            return denyPolicy(payload.sub, event.methodArn);
        }
        logger.info('Auth success', {
            tenant_id: tenantId,
            plan_code: planCode,
            sub: payload.sub,
        });
        return allowPolicy(payload.sub, event.methodArn, {
            tenantId: tenantId,
            planCode: planCode ?? 'starter',
            role: role ?? 'owner',
            sub: payload.sub,
            email: payload.email ?? '',
        });
    }
    catch (err) {
        logger.warn('JWT verification failed', {
            error: err instanceof Error ? err.message : 'unknown',
            path: event.path,
        });
        return denyPolicy('unknown', event.methodArn);
    }
};
exports.handler = handler;
// ── IAM Policy Helpers ────────────────────────────────────────────────────────
function allowPolicy(principalId, methodArn, context) {
    return {
        principalId,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [{
                    Action: 'execute-api:Invoke',
                    Effect: 'Allow',
                    // Allow access to all methods in this API stage for the authenticated user.
                    // Downstream Lambdas enforce tenant-scoped access via tenantId in context.
                    Resource: methodArn.replace(/\/[^/]+\/[^/]+$/, '/*/*'),
                }],
        },
        context,
    };
}
function denyPolicy(principalId, methodArn) {
    return {
        principalId,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [{
                    Action: 'execute-api:Invoke',
                    Effect: 'Deny',
                    Resource: methodArn,
                }],
        },
    };
}
