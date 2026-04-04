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
exports.handler = handler;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
// ─────────────────────────────────────────────────────────────────────────────
// billingHandler — Stripe Checkout & Customer Portal sessions
//
// POST /billing/checkout  → create Stripe Checkout Session (plan or add-on)
// POST /billing/portal    → create Stripe Customer Portal Session
//
// Stripe price IDs are stored in Secrets Manager at:
//   /openclaw/prod/stripe/price-ids
// ─────────────────────────────────────────────────────────────────────────────
const sm = new client_secrets_manager_1.SecretsManagerClient({ region: process.env.AWS_REGION });
const ddb = new client_dynamodb_1.DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.TABLE_NAME ?? 'lavavps-main';
const PORTAL_URL = process.env.PORTAL_URL ?? 'https://main.d2fwekdsfw5bt0.amplifyapp.com';
const PRICE_IDS_SECRET = process.env.PRICE_IDS_SECRET ?? '/openclaw/prod/stripe/price-ids';
const STRIPE_SECRET_ARN = process.env.STRIPE_SECRET_ARN ?? '/openclaw/prod/stripe/secret-key';
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json',
};
function ok(body, status = 200) {
    return { statusCode: status, headers: CORS, body: JSON.stringify(body) };
}
function err(message, status = 400) {
    return { statusCode: status, headers: CORS, body: JSON.stringify({ message }) };
}
async function getStripeKey() {
    const res = await sm.send(new client_secrets_manager_1.GetSecretValueCommand({ SecretId: STRIPE_SECRET_ARN }));
    return res.SecretString ?? '';
}
async function getPriceIds() {
    try {
        const res = await sm.send(new client_secrets_manager_1.GetSecretValueCommand({ SecretId: PRICE_IDS_SECRET }));
        return JSON.parse(res.SecretString ?? '{}');
    }
    catch {
        // Return placeholder IDs — update these in Secrets Manager with real Stripe price IDs
        return {
            plan_starter: process.env.STRIPE_PRICE_STARTER ?? '',
            plan_pro: process.env.STRIPE_PRICE_PRO ?? '',
            plan_business: process.env.STRIPE_PRICE_BUSINESS ?? '',
            addon_agent: process.env.STRIPE_PRICE_ADDON_AGENT ?? '',
            addon_storage_10: process.env.STRIPE_PRICE_STORAGE_10 ?? '',
            addon_storage_50: process.env.STRIPE_PRICE_STORAGE_50 ?? '',
            addon_storage_100: process.env.STRIPE_PRICE_STORAGE_100 ?? '',
        };
    }
}
async function getStripeCustomerId(tenantId) {
    const res = await ddb.send(new client_dynamodb_1.GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: { S: `TENANT#${tenantId}` },
            sk: { S: 'PROFILE' },
        },
        ProjectionExpression: 'stripeCustomerId',
    }));
    return res.Item?.stripeCustomerId?.S ?? null;
}
async function handler(event) {
    const path = event.path ?? '';
    const method = event.httpMethod;
    // Extract tenant context from JWT claims (injected by Cognito authorizer)
    const claims = event.requestContext.authorizer?.claims ?? {};
    const tenantId = claims['custom:tenant_id'];
    const email = claims['email'];
    if (!tenantId)
        return err('Unauthorized', 401);
    // Lazy-load Stripe to avoid bundling issues
    const stripeKey = await getStripeKey();
    const Stripe = (await Promise.resolve().then(() => __importStar(require('stripe')))).default;
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
    // ── POST /billing/checkout ─────────────────────────────────────────────────
    if (method === 'POST' && path.endsWith('/billing/checkout')) {
        const body = JSON.parse(event.body ?? '{}');
        const { type, planCode, storageGb } = body;
        if (!type)
            return err('type is required');
        const priceIds = await getPriceIds();
        let priceId;
        let mode = 'subscription';
        if (type === 'plan') {
            if (!planCode)
                return err('planCode is required for plan checkout');
            priceId = priceIds[`plan_${planCode}`];
            mode = 'subscription';
        }
        else if (type === 'addon_agent') {
            priceId = priceIds['addon_agent'];
            mode = 'subscription';
        }
        else if (type === 'addon_storage') {
            if (!storageGb)
                return err('storageGb is required for storage add-on');
            priceId = priceIds[`addon_storage_${storageGb}`];
            mode = 'subscription'; // one-time purchase
        }
        else {
            return err(`Unknown type: ${type}`);
        }
        if (!priceId) {
            return err('Price not configured. Please contact support@lavavps.ai', 503);
        }
        // Look up existing Stripe customer or let Stripe create one
        const customerId = await getStripeCustomerId(tenantId);
        const session = await stripe.checkout.sessions.create({
            mode,
            ...(customerId ? { customer: customerId } : { customer_email: email }),
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${PORTAL_URL}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${PORTAL_URL}/billing?checkout=cancelled`,
            metadata: {
                tenant_id: tenantId,
                type,
                plan_code: planCode ?? '',
                storage_gb: storageGb?.toString() ?? '',
            },
            // 3-day trial for new plan subscriptions
            ...(type === 'plan' && !customerId ? {
                subscription_data: { trial_period_days: 3 },
            } : {}),
        });
        return ok({ checkoutUrl: session.url, sessionId: session.id });
    }
    // ── POST /billing/portal ───────────────────────────────────────────────────
    if (method === 'POST' && path.endsWith('/billing/portal')) {
        const customerId = await getStripeCustomerId(tenantId);
        if (!customerId) {
            return err('No billing account found. Please complete a checkout first.', 404);
        }
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${PORTAL_URL}/billing`,
        });
        return ok({ portalUrl: session.url });
    }
    
  // GET /billing — live billing info from DynamoDB (source of truth)
  if (method === 'GET' && path.includes('/billing')) {
    const item = await ddb.send(new (require("@aws-sdk/client-dynamodb").GetItemCommand)({
      TableName: TABLE_NAME,
      Key: { pk: { S: `TENANT#${tenantId}` }, sk: { S: 'PROFILE' } },
    }));
    const BASE_STORAGE = { starter: 5, pro: 50, business: 100 };
    const BASE_AGENTS  = { starter: 2, pro: 4,  business: 10  };
    const planCode     = item.Item?.plan_code?.S ?? 'starter';
    const storageAddon = parseInt(item.Item?.storage_addon_gb?.N  ?? '0', 10);
    const addonAgents  = parseInt(item.Item?.addon_agent_count?.N ?? '0', 10);
    const storageBase  = BASE_STORAGE[planCode] ?? 5;
    const agentBase    = BASE_AGENTS[planCode]  ?? 2;
    return ok({
      planCode,
      status:             item.Item?.status?.S              ?? 'ACTIVE',
      subscriptionStatus: item.Item?.subscription_status?.S ?? 'active',
      stripeCustomerId:   item.Item?.stripe_customer_id?.S  ?? null,
      storageBase, storageAddon, storageTotal: storageBase + storageAddon,
      agentBase, addonAgents, agentMax: agentBase + addonAgents,
    });
  }

  return err('Not found', 404);
}
