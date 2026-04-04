"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_sfn_1 = require("@aws-sdk/client-sfn");
const crypto_1 = require("crypto");
const logger_1 = require("./logger");
// ─────────────────────────────────────────────────────────────────────────────
// stripeWebhookHandler
//
// Receives Stripe webhook events and routes them to the appropriate handler.
//
// Security:
//   1. HMAC-SHA256 signature verification on every request (Stripe-Signature header)
//   2. Idempotency check: Stripe event ID stored in DynamoDB, duplicates ignored
//   3. Webhook signing secret stored in Secrets Manager — never in env vars
//
// Events handled:
//   checkout.session.completed       → provisioningStateMachine (new customer)
//   customer.subscription.updated    → updatePlanHandler (plan change)
//   customer.subscription.deleted    → suspendTenantHandler (cancellation)
//   invoice.payment_failed           → paymentFailureHandler
//
// Add-on events (checkout.session.completed with metadata.type = 'addon'):
//   additional_agent                 → provisioningStateMachine (agent only)
//   storage_addon                    → addStorageHandler
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('stripeWebhookHandler');
const secrets = new client_secrets_manager_1.SecretsManagerClient({});
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const sfn = new client_sfn_1.SFNClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const PROVISIONING_SM_ARN = process.env.PROVISIONING_SM_ARN;
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN;
// Cache the webhook secret in Lambda memory (warm invocations reuse it)
let cachedWebhookSecret = null;
const handler = async (event) => {
    // ── Step 1: HMAC verification ──────────────────────────────────────────
    const signature = event.headers['stripe-signature'] ?? event.headers['Stripe-Signature'];
    if (!signature) {
        logger.warn('Webhook rejected: missing Stripe-Signature header');
        return { statusCode: 400, body: 'Missing signature' };
    }
    const rawBody = event.body ?? '';
    // Fetch signing secret from Secrets Manager (cached in Lambda memory)
    if (!cachedWebhookSecret) {
        try {
            const result = await secrets.send(new client_secrets_manager_1.GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN }));
            const data = JSON.parse(result.SecretString ?? '{}');
            cachedWebhookSecret = data.webhookSigningSecret;
        }
        catch (err) {
            logger.error('Failed to fetch webhook signing secret', {
                error: err instanceof Error ? err.message : 'unknown',
            });
            return { statusCode: 500, body: 'Configuration error' };
        }
    }
    if (!verifyStripeSignature(rawBody, signature, cachedWebhookSecret)) {
        logger.warn('Webhook rejected: invalid signature');
        return { statusCode: 400, body: 'Invalid signature' };
    }
    // ── Step 2: Parse event ────────────────────────────────────────────────
    let stripeEvent;
    try {
        stripeEvent = JSON.parse(rawBody);
    }
    catch {
        return { statusCode: 400, body: 'Invalid JSON' };
    }
    const eventId = stripeEvent.id;
    const eventType = stripeEvent.type;
    logger.info('Webhook received', { event_id: eventId, event_type: eventType });
    // ── Step 3: Idempotency check ──────────────────────────────────────────
    // If this event was already processed, return 200 immediately
    const existing = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `STRIPE_EVENT#${eventId}`, sk: `STRIPE_EVENT#${eventId}` },
    }));
    if (existing.Item) {
        logger.info('Duplicate webhook event — already processed', { event_id: eventId });
        return { statusCode: 200, body: 'Already processed' };
    }
    // ── Step 4: Route to handler ───────────────────────────────────────────
    try {
        await routeEvent(stripeEvent);
    }
    catch (err) {
        logger.error('Webhook handler failed', {
            event_id: eventId,
            event_type: eventType,
            error: err instanceof Error ? err.message : 'unknown',
        });
        // Return 500 so Stripe retries (it will retry for 72 hours)
        return { statusCode: 500, body: 'Handler failed' };
    }
    // ── Step 5: Mark event as processed ───────────────────────────────────
    await dynamo.send(new lib_dynamodb_1.PutCommand({
        TableName: TABLE_NAME,
        Item: {
            pk: `STRIPE_EVENT#${eventId}`,
            sk: `STRIPE_EVENT#${eventId}`,
            event_id: eventId,
            event_type: eventType,
            processed_at: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30-day TTL
        },
    }));
    return { statusCode: 200, body: 'OK' };
};
exports.handler = handler;
// ── Event Router ──────────────────────────────────────────────────────────────
async function routeEvent(event) {
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const addonType = session.metadata?.addon_type;
            if (addonType === 'additional_agent') {
                // Add-on: provision new agent for existing tenant
                await startProvisioning({
                    mode: 'additional_agent',
                    stripeCustomerId: session.customer,
                    stripeSubId: session.subscription,
                    planCode: session.metadata?.plan_code ?? 'starter',
                });
            }
            else if (addonType === 'storage') {
                // Add-on: increase storage quota
                await addStorage({
                    stripeCustomerId: session.customer,
                    storageGb: parseInt(session.metadata?.storage_gb ?? '10'),
                });
            }
            else {
                // New subscription: full tenant provisioning
                await startProvisioning({
                    mode: 'new_tenant',
                    stripeCustomerId: session.customer,
                    stripeSubId: session.subscription,
                    planCode: session.metadata?.plan_code ?? 'starter',
                    customerEmail: session.customer_email ?? session.customer_details?.email ?? '',
                });
            }
            break;
        }
        case 'customer.subscription.updated': {
            const sub = event.data.object;
            await updatePlan({
                stripeCustomerId: sub.customer,
                stripeSubId: sub.id,
                newPlanCode: sub.metadata?.plan_code ?? 'starter',
                status: sub.status,
            });
            break;
        }
        case 'customer.subscription.deleted': {
            const sub = event.data.object;
            await suspendTenant({ stripeCustomerId: sub.customer, stripeSubId: sub.id });
            break;
        }
        case 'invoice.payment_failed': {
            const invoice = event.data.object;
            await handlePaymentFailure({
                stripeCustomerId: invoice.customer,
                attemptCount: invoice.attempt_count ?? 1,
            });
            break;
        }
        default:
            logger.info('Unhandled event type — skipping', { event_type: event.type });
    }
}
// ── Action Handlers ───────────────────────────────────────────────────────────
async function startProvisioning(params) {
    await sfn.send(new client_sfn_1.StartExecutionCommand({
        stateMachineArn: PROVISIONING_SM_ARN,
        name: `provision-${params.stripeSubId}-${Date.now()}`,
        input: JSON.stringify(params),
    }));
    logger.info('Provisioning state machine started', params);
}
async function addStorage(params) {
    // Look up tenant by Stripe customer ID via GSI-1
    const result = await dynamo.send(new lib_dynamodb_1.QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'byStripeCustomer',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': `STRIPE#${params.stripeCustomerId}` },
        Limit: 1,
    }));
    if (!result.Items?.length) {
        logger.warn('addStorage: tenant not found', params);
        return;
    }
    const tenantId = result.Items[0].tenant_id;
    const { UpdateCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/lib-dynamodb')));
    await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
        UpdateExpression: 'ADD storage_quota_gb :gb',
        ExpressionAttributeValues: { ':gb': params.storageGb },
    }));
    logger.info('Storage quota increased', { tenant_id: tenantId, added_gb: params.storageGb });
}
async function updatePlan(params) {
    const result = await dynamo.send(new lib_dynamodb_1.QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'byStripeCustomer',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': `STRIPE#${params.stripeCustomerId}` },
        Limit: 1,
    }));
    if (!result.Items?.length)
        return;
    const tenantId = result.Items[0].tenant_id;
    const { UpdateCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/lib-dynamodb')));
    await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
        UpdateExpression: 'SET plan_code = :plan, subscription_status = :status, updated_at = :now',
        ExpressionAttributeValues: {
            ':plan': params.newPlanCode,
            ':status': params.status,
            ':now': new Date().toISOString(),
        },
    }));
    logger.info('Plan updated', { tenant_id: tenantId, new_plan: params.newPlanCode });
}
async function suspendTenant(params) {
    const result = await dynamo.send(new lib_dynamodb_1.QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'byStripeCustomer',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': `STRIPE#${params.stripeCustomerId}` },
        Limit: 1,
    }));
    if (!result.Items?.length)
        return;
    const tenantId = result.Items[0].tenant_id;
    const { UpdateCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/lib-dynamodb')));
    await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
        UpdateExpression: 'SET #status = :s, subscription_status = :sub, suspended_at = :now, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
            ':s': 'SUSPENDED',
            ':sub': 'canceled',
            ':now': new Date().toISOString(),
        },
    }));
    logger.info('Tenant suspended — subscription cancelled', { tenant_id: tenantId });
}
async function handlePaymentFailure(params) {
    // After 3 failed attempts, suspend the tenant
    if (params.attemptCount >= 3) {
        await suspendTenant({ stripeCustomerId: params.stripeCustomerId, stripeSubId: 'payment_failed' });
    }
    else {
        logger.info('Payment failed — attempt', params);
        // TODO: send payment failure email (Phase 6 SES integration)
    }
}
// ── Stripe Signature Verification ────────────────────────────────────────────
function verifyStripeSignature(payload, header, secret) {
    try {
        // Parse Stripe-Signature header: t=timestamp,v1=signature
        const parts = {};
        header.split(',').forEach(part => {
            const [k, v] = part.split('=');
            parts[k] = v;
        });
        const timestamp = parts['t'];
        const signature = parts['v1'];
        if (!timestamp || !signature)
            return false;
        // Reject requests older than 5 minutes (replay protection)
        const requestTime = parseInt(timestamp, 10);
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSeconds - requestTime) > 300)
            return false;
        // Compute expected signature
        const signedPayload = `${timestamp}.${payload}`;
        const expected = (0, crypto_1.createHmac)('sha256', secret)
            .update(signedPayload, 'utf8')
            .digest('hex');
        // Constant-time comparison
        if (expected.length !== signature.length)
            return false;
        let diff = 0;
        for (let i = 0; i < expected.length; i++) {
            diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
        }
        return diff === 0;
    }
    catch {
        return false;
    }
}
