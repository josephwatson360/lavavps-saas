import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createHmac } from 'crypto';
import { createLogger } from '../../layer/src/logger';

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

const logger  = createLogger('stripeWebhookHandler');
const secrets = new SecretsManagerClient({});
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn     = new SFNClient({});

const TABLE_NAME                = process.env.TABLE_NAME!;
const PROVISIONING_SM_ARN       = process.env.PROVISIONING_SM_ARN!;
const WEBHOOK_SECRET_ARN        = process.env.WEBHOOK_SECRET_ARN!;

// Cache the webhook secret in Lambda memory (warm invocations reuse it)
let cachedWebhookSecret: string | null = null;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN }));
      const data   = JSON.parse(result.SecretString ?? '{}');
      cachedWebhookSecret = data.webhookSigningSecret;
    } catch (err) {
      logger.error('Failed to fetch webhook signing secret', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      return { statusCode: 500, body: 'Configuration error' };
    }
  }

  if (!verifyStripeSignature(rawBody, signature, cachedWebhookSecret!)) {
    logger.warn('Webhook rejected: invalid signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  // ── Step 2: Parse event ────────────────────────────────────────────────
  let stripeEvent: StripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const eventId   = stripeEvent.id;
  const eventType = stripeEvent.type;

  logger.info('Webhook received', { event_id: eventId, event_type: eventType });

  // ── Step 3: Idempotency check ──────────────────────────────────────────
  // If this event was already processed, return 200 immediately
  const existing = await dynamo.send(new GetCommand({
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
  } catch (err) {
    logger.error('Webhook handler failed', {
      event_id:   eventId,
      event_type: eventType,
      error:      err instanceof Error ? err.message : 'unknown',
    });
    // Return 500 so Stripe retries (it will retry for 72 hours)
    return { statusCode: 500, body: 'Handler failed' };
  }

  // ── Step 5: Mark event as processed ───────────────────────────────────
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk:           `STRIPE_EVENT#${eventId}`,
      sk:           `STRIPE_EVENT#${eventId}`,
      event_id:     eventId,
      event_type:   eventType,
      processed_at: new Date().toISOString(),
      ttl:          Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30-day TTL
    },
  }));

  return { statusCode: 200, body: 'OK' };
};

// ── Event Router ──────────────────────────────────────────────────────────────

async function routeEvent(event: StripeEvent): Promise<void> {
  switch (event.type) {

    case 'checkout.session.completed': {
      const session  = event.data.object as unknown as StripeCheckoutSession;
      const addonType = session.metadata?.addon_type;

      if (addonType === 'additional_agent') {
        // Add-on: provision new agent for existing tenant
        await startProvisioning({
          mode:             'additional_agent',
          stripeCustomerId: session.customer as string,
          stripeSubId:      session.subscription as string,
          planCode:         session.metadata?.plan_code ?? 'starter',
        });
      } else if (addonType === 'storage') {
        // Add-on: increase storage quota
        await addStorage({
          stripeCustomerId: session.customer as string,
          storageGb:        parseInt(session.metadata?.storage_gb ?? '10'),
        });
      } else {
        // New subscription: full tenant provisioning
        await startProvisioning({
          mode:             'new_tenant',
          stripeCustomerId: session.customer as string,
          stripeSubId:      session.subscription as string,
          planCode:         session.metadata?.plan_code ?? 'starter',
          customerEmail:    session.customer_email ?? session.customer_details?.email ?? '',
        });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as unknown as StripeSubscription;
      await updatePlan({
        stripeCustomerId: sub.customer as string,
        stripeSubId:      sub.id,
        newPlanCode:      sub.metadata?.plan_code ?? 'starter',
        status:           sub.status,
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as unknown as StripeSubscription;
      await suspendTenant({ stripeCustomerId: sub.customer as string, stripeSubId: sub.id });
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as unknown as StripeInvoice;
      await handlePaymentFailure({
        stripeCustomerId: invoice.customer as string,
        attemptCount:     invoice.attempt_count ?? 1,
      });
      break;
    }

    default:
      logger.info('Unhandled event type — skipping', { event_type: event.type });
  }
}

// ── Action Handlers ───────────────────────────────────────────────────────────

async function startProvisioning(params: {
  mode:             'new_tenant' | 'additional_agent';
  stripeCustomerId: string;
  stripeSubId:      string;
  planCode:         string;
  customerEmail?:   string;
}): Promise<void> {
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: PROVISIONING_SM_ARN,
    name:            `provision-${params.stripeSubId}-${Date.now()}`,
    input:           JSON.stringify(params),
  }));
  logger.info('Provisioning state machine started', params);
}

async function addStorage(params: {
  stripeCustomerId: string;
  storageGb:        number;
}): Promise<void> {
  // Look up tenant by Stripe customer ID via GSI-1
  const result = await dynamo.send(new QueryCommand({
    TableName:              TABLE_NAME,
    IndexName:              'byStripeCustomer',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `STRIPE#${params.stripeCustomerId}` },
    Limit: 1,
  }));

  if (!result.Items?.length) {
    logger.warn('addStorage: tenant not found', params);
    return;
  }

  const tenantId = result.Items[0].tenant_id as string;
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
    UpdateExpression: 'ADD storage_quota_gb :gb',
    ExpressionAttributeValues: { ':gb': params.storageGb },
  }));

  logger.info('Storage quota increased', { tenant_id: tenantId, added_gb: params.storageGb });
}

async function updatePlan(params: {
  stripeCustomerId: string;
  stripeSubId:      string;
  newPlanCode:      string;
  status:           string;
}): Promise<void> {
  const result = await dynamo.send(new QueryCommand({
    TableName:              TABLE_NAME,
    IndexName:              'byStripeCustomer',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `STRIPE#${params.stripeCustomerId}` },
    Limit: 1,
  }));

  if (!result.Items?.length) return;
  const tenantId = result.Items[0].tenant_id as string;

  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
    UpdateExpression: 'SET plan_code = :plan, subscription_status = :status, updated_at = :now',
    ExpressionAttributeValues: {
      ':plan':   params.newPlanCode,
      ':status': params.status,
      ':now':    new Date().toISOString(),
    },
  }));

  logger.info('Plan updated', { tenant_id: tenantId, new_plan: params.newPlanCode });
}

async function suspendTenant(params: {
  stripeCustomerId: string;
  stripeSubId:      string;
}): Promise<void> {
  const result = await dynamo.send(new QueryCommand({
    TableName:              TABLE_NAME,
    IndexName:              'byStripeCustomer',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `STRIPE#${params.stripeCustomerId}` },
    Limit: 1,
  }));

  if (!result.Items?.length) return;
  const tenantId = result.Items[0].tenant_id as string;

  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
    UpdateExpression: 'SET #status = :s, subscription_status = :sub, suspended_at = :now, updated_at = :now',
    ExpressionAttributeNames:  { '#status': 'status' },
    ExpressionAttributeValues: {
      ':s':   'SUSPENDED',
      ':sub': 'canceled',
      ':now': new Date().toISOString(),
    },
  }));

  logger.info('Tenant suspended — subscription cancelled', { tenant_id: tenantId });
}

async function handlePaymentFailure(params: {
  stripeCustomerId: string;
  attemptCount:     number;
}): Promise<void> {
  // After 3 failed attempts, suspend the tenant
  if (params.attemptCount >= 3) {
    await suspendTenant({ stripeCustomerId: params.stripeCustomerId, stripeSubId: 'payment_failed' });
  } else {
    logger.info('Payment failed — attempt', params);
    // TODO: send payment failure email (Phase 6 SES integration)
  }
}

// ── Stripe Signature Verification ────────────────────────────────────────────

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  try {
    // Parse Stripe-Signature header: t=timestamp,v1=signature
    const parts: Record<string, string> = {};
    header.split(',').forEach(part => {
      const [k, v] = part.split('=');
      parts[k] = v;
    });

    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) return false;

    // Reject requests older than 5 minutes (replay protection)
    const requestTime = parseInt(timestamp, 10);
    const nowSeconds  = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - requestTime) > 300) return false;

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const expected = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    // Constant-time comparison
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

// ── Stripe Type Definitions ───────────────────────────────────────────────────

interface StripeEvent {
  id:   string;
  type: string;
  data: { object: Record<string, unknown> };
}

interface StripeCheckoutSession {
  customer:         string | null;
  subscription:     string | null;
  customer_email:   string | null;
  customer_details?: { email?: string };
  metadata?:        Record<string, string>;
}

interface StripeSubscription {
  id:       string;
  customer: string;
  status:   string;
  metadata: Record<string, string>;
}

interface StripeInvoice {
  customer:      string;
  attempt_count: number;
}
