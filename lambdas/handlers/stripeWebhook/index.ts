import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
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
//   checkout.session.completed       → routes by metadata.type:
//     type = 'plan'                  → startProvisioning (new_tenant)
//     type = 'addon_agent'           → incrementAddonAgents
//     type = 'addon_storage'         → addStorage
//   customer.subscription.updated    → updatePlan
//   customer.subscription.deleted    → suspendTenant
//   invoice.payment_failed           → paymentFailureHandler
//
// IMPORTANT: metadata key is 'type' (not 'addon_type') — must match billingHandler.
// IMPORTANT: DynamoDB PROFILE record uses sk = 'PROFILE' (not 'TENANT#${tenantId}').
// ─────────────────────────────────────────────────────────────────────────────

const logger   = createLogger('stripeWebhookHandler');
const secrets  = new SecretsManagerClient({});
const dynamo   = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito  = new CognitoIdentityProviderClient({});
const sfn      = new SFNClient({});

const TABLE_NAME          = process.env.TABLE_NAME!;
const PROVISIONING_SM_ARN = process.env.PROVISIONING_SM_ARN!;
const WEBHOOK_SECRET_ARN  = process.env.WEBHOOK_SECRET_ARN!;
const USER_POOL_ID        = process.env.USER_POOL_ID!;

// Cache the webhook secret in Lambda memory (warm invocations reuse it)
let cachedWebhookSecret: string | null = null;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // ── Step 1: HMAC verification ──────────────────────────────────────────────
  const signature = event.headers['stripe-signature'] ?? event.headers['Stripe-Signature'];
  if (!signature) {
    logger.warn('Webhook rejected: missing Stripe-Signature header');
    return { statusCode: 400, body: 'Missing signature' };
  }

  const rawBody = event.body ?? '';

  if (!cachedWebhookSecret) {
    try {
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN }));
      const data   = JSON.parse(result.SecretString ?? '{}');
      // Secret may be stored as plain string or as JSON with webhookSigningSecret key
      cachedWebhookSecret = data.webhookSigningSecret ?? result.SecretString ?? '';
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

  // ── Step 2: Parse event ────────────────────────────────────────────────────
  let stripeEvent: StripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const eventId   = stripeEvent.id;
  const eventType = stripeEvent.type;

  logger.info('Webhook received', { event_id: eventId, event_type: eventType });

  // ── Step 3: Idempotency check ──────────────────────────────────────────────
  const existing = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `STRIPE_EVENT#${eventId}`, sk: `STRIPE_EVENT#${eventId}` },
  }));

  if (existing.Item) {
    logger.info('Duplicate webhook event — already processed', { event_id: eventId });
    return { statusCode: 200, body: 'Already processed' };
  }

  // ── Step 4: Route to handler ───────────────────────────────────────────────
  try {
    await routeEvent(stripeEvent);
  } catch (err) {
    logger.error('Webhook handler failed', {
      event_id:   eventId,
      event_type: eventType,
      error:      err instanceof Error ? err.message : 'unknown',
      stack:      err instanceof Error ? err.stack : undefined,
    });
    return { statusCode: 500, body: 'Handler failed' };
  }

  // ── Step 5: Mark event as processed ───────────────────────────────────────
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk:           `STRIPE_EVENT#${eventId}`,
      sk:           `STRIPE_EVENT#${eventId}`,
      event_id:     eventId,
      event_type:   eventType,
      processed_at: new Date().toISOString(),
      ttl:          Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60),
    },
  }));

  return { statusCode: 200, body: 'OK' };
};

// ── Event Router ──────────────────────────────────────────────────────────────

async function routeEvent(event: StripeEvent): Promise<void> {
  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object as unknown as StripeCheckoutSession;

      // Route by metadata.type (set by billingHandler when creating the session)
      // NOTE: key is 'type' not 'addon_type'
      const checkoutType = session.metadata?.type ?? '';

      logger.info('Checkout completed', {
        checkout_type:    checkoutType,
        customer:         session.customer,
        subscription:     session.subscription,
        metadata:         session.metadata,
      });

      if (checkoutType === 'addon_agent') {
        await incrementAddonAgents({
          stripeCustomerId: session.customer as string,
          stripeSubId:      session.subscription as string,
        });
      } else if (checkoutType === 'addon_storage') {
        await addStorage({
          stripeCustomerId: session.customer as string,
          storageGb:        parseInt(session.metadata?.storage_gb ?? '10', 10),
        });
      } else {
        // type === 'plan' or unset — full tenant provisioning
        const planCode = session.metadata?.plan_code ?? 'starter';
        await startProvisioning({
          mode:             'new_tenant',
          stripeCustomerId: session.customer as string,
          stripeSubId:      session.subscription as string,
          planCode,
          customerEmail:    session.customer_email ?? session.customer_details?.email ?? '',
        });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as unknown as StripeSubscription;
      // Fired when plan changes, trial ends, or subscription status changes
      // plan_code in metadata is set by Stripe metadata on the subscription
      await updatePlan({
        stripeCustomerId: sub.customer as string,
        stripeSubId:      sub.id,
        newPlanCode:      sub.metadata?.plan_code ?? '',
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

async function incrementAddonAgents(params: {
  stripeCustomerId: string;
  stripeSubId:      string;
}): Promise<void> {
  const tenant = await getTenantByStripeCustomer(params.stripeCustomerId);
  if (!tenant) {
    logger.warn('incrementAddonAgents: tenant not found', params);
    return;
  }

  const { tenantId, cognitoSub } = tenant;

  // Increment addon_agent_count in DynamoDB PROFILE record
  const result = await dynamo.send(new UpdateCommand({
    TableName:        TABLE_NAME,
    Key:              { pk: `TENANT#${tenantId}`, sk: 'PROFILE' },
    UpdateExpression: 'ADD addon_agent_count :one SET updated_at = :now',
    ExpressionAttributeValues: {
      ':one': 1,
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  }));

  const newCount = (result.Attributes?.addon_agent_count as number) ?? 1;

  // Update Cognito custom attribute so JWT reflects new limit immediately on next refresh
  if (cognitoSub) {
    try {
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId:     USER_POOL_ID,
        Username:       cognitoSub,
        UserAttributes: [
          { Name: 'custom:addon_agents', Value: String(newCount) },
        ],
      }));
    } catch (err) {
      // Non-fatal — DynamoDB is source of truth, JWT updates on next login
      logger.warn('Failed to update Cognito addon_agents attribute', {
        error: err instanceof Error ? err.message : 'unknown',
        tenant_id: tenantId,
      });
    }
  }

  logger.info('Addon agent added', { tenant_id: tenantId, new_addon_count: newCount });
}

async function addStorage(params: {
  stripeCustomerId: string;
  storageGb:        number;
}): Promise<void> {
  const tenant = await getTenantByStripeCustomer(params.stripeCustomerId);
  if (!tenant) {
    logger.warn('addStorage: tenant not found', params);
    return;
  }

  const { tenantId } = tenant;

  // ADD is atomic increment — safe for concurrent calls
  await dynamo.send(new UpdateCommand({
    TableName:        TABLE_NAME,
    Key:              { pk: `TENANT#${tenantId}`, sk: 'PROFILE' },
    UpdateExpression: 'ADD storage_addon_gb :gb SET updated_at = :now',
    ExpressionAttributeValues: {
      ':gb':  params.storageGb,
      ':now': new Date().toISOString(),
    },
  }));

  logger.info('Storage quota increased', { tenant_id: tenantId, added_gb: params.storageGb });
}

async function updatePlan(params: {
  stripeCustomerId: string;
  stripeSubId:      string;
  newPlanCode:      string;
  status:           string;
}): Promise<void> {
  // Only update if we have a plan code (not all subscription.updated events have it)
  if (!params.newPlanCode) {
    logger.info('updatePlan: no plan_code in subscription metadata, skipping', params);
    return;
  }

  const tenant = await getTenantByStripeCustomer(params.stripeCustomerId);
  if (!tenant) {
    logger.warn('updatePlan: tenant not found', params);
    return;
  }

  const { tenantId, cognitoSub } = tenant;

  await dynamo.send(new UpdateCommand({
    TableName:        TABLE_NAME,
    Key:              { pk: `TENANT#${tenantId}`, sk: 'PROFILE' },
    UpdateExpression: 'SET plan_code = :plan, subscription_status = :status, updated_at = :now',
    ExpressionAttributeValues: {
      ':plan':   params.newPlanCode,
      ':status': params.status,
      ':now':    new Date().toISOString(),
    },
  }));

  // Update Cognito so JWT reflects new plan on next token refresh
  if (cognitoSub && params.newPlanCode) {
    try {
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId:     USER_POOL_ID,
        Username:       cognitoSub,
        UserAttributes: [
          { Name: 'custom:plan_code', Value: params.newPlanCode },
        ],
      }));
    } catch (err) {
      logger.warn('Failed to update Cognito plan_code attribute', {
        error: err instanceof Error ? err.message : 'unknown',
        tenant_id: tenantId,
      });
    }
  }

  logger.info('Plan updated in DynamoDB + Cognito', {
    tenant_id: tenantId,
    new_plan:  params.newPlanCode,
    status:    params.status,
  });
}

async function suspendTenant(params: {
  stripeCustomerId: string;
  stripeSubId:      string;
}): Promise<void> {
  const tenant = await getTenantByStripeCustomer(params.stripeCustomerId);
  if (!tenant) {
    logger.warn('suspendTenant: tenant not found', params);
    return;
  }

  const { tenantId } = tenant;

  await dynamo.send(new UpdateCommand({
    TableName:        TABLE_NAME,
    Key:              { pk: `TENANT#${tenantId}`, sk: 'PROFILE' },
    UpdateExpression: 'SET #s = :s, subscription_status = :sub, suspended_at = :now, updated_at = :now',
    ExpressionAttributeNames:  { '#s': 'status' },
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
  if (params.attemptCount >= 3) {
    await suspendTenant({ stripeCustomerId: params.stripeCustomerId, stripeSubId: 'payment_failed' });
  } else {
    logger.info('Payment failed — will retry', params);
  }
}

// ── Shared Helper ─────────────────────────────────────────────────────────────

async function getTenantByStripeCustomer(
  stripeCustomerId: string,
): Promise<{ tenantId: string; cognitoSub: string } | null> {
  const result = await dynamo.send(new QueryCommand({
    TableName:              TABLE_NAME,
    IndexName:              'byStripeCustomer',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `STRIPE#${stripeCustomerId}` },
    Limit: 1,
  }));

  if (!result.Items?.length) return null;

  return {
    tenantId:   result.Items[0].tenant_id as string,
    cognitoSub: result.Items[0].cognito_sub as string ?? '',
  };
}

// ── Stripe Signature Verification ─────────────────────────────────────────────

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  try {
    const parts: Record<string, string> = {};
    header.split(',').forEach(part => {
      const [k, v] = part.split('=');
      parts[k] = v;
    });

    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) return false;

    const requestTime = parseInt(timestamp, 10);
    const nowSeconds  = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - requestTime) > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const expected = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

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
  customer:          string | null;
  subscription:      string | null;
  customer_email:    string | null;
  customer_details?: { email?: string };
  metadata?:         Record<string, string>;
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
