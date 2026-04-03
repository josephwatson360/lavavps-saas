import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EFSClient, CreateAccessPointCommand, DeleteAccessPointCommand } from '@aws-sdk/client-efs';
import { IAMClient, CreateRoleCommand, DeleteRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand } from '@aws-sdk/client-iam';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SESv2Client as SESClient, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createLogger } from '../../layer/src/logger';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// provisioningLambda
//
// Invoked by the Step Functions state machine — one function handles all steps.
// The step name is passed in the event as `step`.
//
// Each step is a separate Lambda invocation, giving Step Functions full
// visibility and retry/compensate control.
//
// Steps:
//   createCognitoUser       Create Cognito user with custom attributes
//   createDynamoRecords     Write tenant + agent + subscription records
//   createEfsAccessPoint    Create EFS Access Point (uid=1000)
//   createIamTaskRole       Create per-tenant IAM task role (least privilege)
//   renderInitialConfig     First openclaw.json via configRenderer
//   sendWelcomeEmail        SES welcome email
//
// Steps handled by separate Lambdas (referenced by ARN in state machine):
//   startEcsTask            → taskHandler
//   waitForReadyz           → taskHandler (polls /readyz)
//
// Compensating actions (rollback on failure):
//   Each create step has a matching delete action invoked if a later step fails.
// ─────────────────────────────────────────────────────────────────────────────

const logger   = createLogger('provisioningLambda');
const cognito  = new CognitoIdentityProviderClient({});
const dynamo   = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const efs      = new EFSClient({});
const iam      = new IAMClient({});
const s3       = new S3Client({});
const lambda   = new LambdaClient({});
const ses      = new SESClient({ region: 'us-east-1' });

const TABLE_NAME              = process.env.TABLE_NAME!;
const USER_POOL_ID            = process.env.USER_POOL_ID!;
const EFS_ID                  = process.env.EFS_ID!;
const CONFIG_BUCKET           = process.env.CONFIG_BUCKET!;
const CONFIG_RENDERER_ARN     = process.env.CONFIG_RENDERER_ARN!;
const AWS_ACCOUNT             = process.env.AWS_ACCOUNT!;
const AWS_REGION              = process.env.AWS_REGION_NAME!;
const CLUSTER_ARN             = process.env.CLUSTER_ARN!;
const FARGATE_EXECUTION_ROLE  = process.env.FARGATE_EXECUTION_ROLE!;

const PLAN_STORAGE_GB: Record<string, number>  = { starter: 5,  pro: 50, business: 100 };
const PLAN_AGENT_LIMIT: Record<string, number> = { starter: 1,  pro: 5,  business: 10 };

interface ProvisioningInput {
  step:             string;
  mode:             'new_tenant' | 'additional_agent';
  stripeCustomerId: string;
  stripeSubId:      string;
  planCode:         string;
  customerEmail?:   string;
  tenantId?:        string;  // set after createCognitoUser, passed through steps
  agentId?:         string;
  cognitoUserId?:   string;
  efsApId?:         string;
  iamRoleArn?:      string;
}

export const handler = async (event: ProvisioningInput): Promise<Record<string, unknown>> => {
  const { step } = event;
  logger.info('Provisioning step started', { step, mode: event.mode });

  switch (step) {
    case 'createCognitoUser':  return createCognitoUser(event);
    case 'createDynamoRecords': return createDynamoRecords(event);
    case 'createEfsAccessPoint': return createEfsAccessPoint(event);
    case 'createIamTaskRole':  return createIamTaskRole(event);
    case 'renderInitialConfig': return renderInitialConfig(event);
    case 'sendWelcomeEmail':   return sendWelcomeEmail(event);
    // Compensating actions
    case 'deleteCognitoUser':  return deleteCognitoUser(event);
    case 'deleteDynamoRecords': return deleteDynamoRecords(event);
    case 'deleteEfsAccessPoint': return deleteEfsAccessPoint(event);
    case 'deleteIamTaskRole':  return deleteIamTaskRole(event);
    default:
      throw new Error(`Unknown provisioning step: ${step}`);
  }
};

// ── Step Handlers ─────────────────────────────────────────────────────────────

async function createCognitoUser(event: ProvisioningInput) {
  if (event.mode === 'additional_agent') {
    // Additional agent: tenant already exists, look up tenantId from Stripe customer
    const result = await dynamo.send(new QueryCommand({
      TableName:              TABLE_NAME,
      IndexName:              'byStripeCustomer',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': `STRIPE#${event.stripeCustomerId}` },
      Limit: 1,
    }));
    if (!result.Items?.length) throw new Error('Tenant not found for additional agent');
    return { tenantId: result.Items[0].tenant_id, agentId: randomUUID(), cognitoUserId: result.Items[0].cognito_user_id };
  }

  const tenantId = randomUUID();
  const agentId  = randomUUID();
  const email    = event.customerEmail!;

  const tempPassword = generateTempPassword();

  const createResult = await cognito.send(new AdminCreateUserCommand({
    UserPoolId:        USER_POOL_ID,
    Username:          email,
    TemporaryPassword: tempPassword,
    MessageAction:     'SUPPRESS', // We send our own welcome email
    UserAttributes: [
      { Name: 'email',              Value: email },
      { Name: 'email_verified',     Value: 'true' },
      { Name: 'custom:tenant_id',   Value: tenantId },
      { Name: 'custom:plan_code',   Value: event.planCode },
      { Name: 'custom:role',        Value: 'owner' },
    ],
  }));

  const cognitoUserId = createResult.User?.Username ?? email;
  logger.info('Cognito user created', { tenant_id: tenantId, email });

  return { tenantId, agentId, cognitoUserId, tempPassword };
}

async function createDynamoRecords(event: ProvisioningInput) {
  const { tenantId, agentId, stripeCustomerId, stripeSubId, planCode } = {
    tenantId:         event.tenantId!,
    agentId:          event.agentId!,
    stripeCustomerId: event.stripeCustomerId,
    stripeSubId:      event.stripeSubId,
    planCode:         event.planCode,
  };
  const now = new Date().toISOString();

  // Tenant record
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk:                  `TENANT#${tenantId}`,
      sk:                  `TENANT#${tenantId}`,
      tenant_id:           tenantId,
      cognito_user_id:     event.cognitoUserId,
      plan_code:           planCode,
      stripe_customer_id:  stripeCustomerId,
      subscription_status: 'active',
      storage_quota_gb:    PLAN_STORAGE_GB[planCode] ?? 5,
      storage_used_bytes:  0,
      agent_limit:         PLAN_AGENT_LIMIT[planCode] ?? 1,
      created_at:          now,
      updated_at:          now,
      // GSI-1: lookup by Stripe customer ID
      gsi1pk:              `STRIPE#${stripeCustomerId}`,
      gsi1sk:              `TENANT#${tenantId}`,
    },
  }));

  // Agent record
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk:                 `TENANT#${tenantId}`,
      sk:                 `AGENT#${agentId}`,
      agent_id:           agentId,
      tenant_id:          tenantId,
      plan_code:          planCode,
      status:             'PROVISIONING',
      config_version:     0,
      onboarding_complete: false,
      created_at:         now,
      updated_at:         now,
      gsi2pk:             'STATUS#PROVISIONING',
      gsi2sk:             now,
    },
  }));

  // Subscription record
  await dynamo.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk:                  `TENANT#${tenantId}`,
      sk:                  `SUB#${stripeSubId}`,
      stripe_sub_id:       stripeSubId,
      stripe_customer_id:  stripeCustomerId,
      tenant_id:           tenantId,
      plan_code:           planCode,
      status:              'active',
      created_at:          now,
    },
  }));

  logger.info('DynamoDB records created', { tenant_id: tenantId, agent_id: agentId });
  return {};
}

async function createEfsAccessPoint(event: ProvisioningInput) {
  const { tenantId, agentId } = event as { tenantId: string; agentId: string };

  const result = await efs.send(new CreateAccessPointCommand({
    FileSystemId: EFS_ID,
    PosixUser:    { Uid: 1000, Gid: 1000 },
    RootDirectory: {
      Path:       `/tenants/${tenantId}/agents/${agentId}`,
      CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
    },
    Tags: [
      { Key: 'TenantId', Value: tenantId },
      { Key: 'AgentId',  Value: agentId },
      { Key: 'ManagedBy', Value: 'LavaVPS' },
    ],
  }));

  const efsApId = result.AccessPointId!;

  // Store Access Point ID on agent record
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    UpdateExpression: 'SET efs_access_point_id = :id',
    ExpressionAttributeValues: { ':id': efsApId },
  }));

  logger.info('EFS Access Point created', { tenant_id: tenantId, agent_id: agentId, efs_ap_id: efsApId });
  return { efsApId };
}

async function createIamTaskRole(event: ProvisioningInput) {
  const { tenantId, agentId, efsApId } = event as { tenantId: string; agentId: string; efsApId: string };

  const roleName = `lavavps-task-${tenantId.slice(0, 8)}-${agentId.slice(0, 8)}`;

  const createResult = await iam.send(new CreateRoleCommand({
    RoleName:    roleName,
    Description: `LavaVPS per-tenant task role for ${tenantId}/${agentId}`,
    AssumeRolePolicyDocument: JSON.stringify({
      Version:   '2012-10-17',
      Statement: [{
        Effect:    'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action:    'sts:AssumeRole',
      }],
    }),
    Tags: [
      { Key: 'TenantId', Value: tenantId },
      { Key: 'AgentId',  Value: agentId },
    ],
  }));

  const roleArn = createResult.Role?.Arn ?? (() => { throw new Error("Role ARN missing"); })();

  // Scope policy: own EFS AP, own Secrets, own S3 prefix, own log group
  await iam.send(new PutRolePolicyCommand({
    RoleName:       roleName,
    PolicyName:     'lavavps-agent-policy',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        // EFS: only own Access Point
        {
          Effect:   'Allow',
          Action:   ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Resource: `arn:aws:elasticfilesystem:${AWS_REGION}:${AWS_ACCOUNT}:file-system/${EFS_ID}`,
          Condition: {
            StringEquals: { 'elasticfilesystem:AccessPointArn': `arn:aws:elasticfilesystem:${AWS_REGION}:${AWS_ACCOUNT}:access-point/${efsApId}` },
          },
        },
        // Secrets Manager: only own secret
        {
          Effect:   'Allow',
          Action:   ['secretsmanager:GetSecretValue'],
          Resource: `arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT}:secret:/openclaw/prod/${tenantId}/${agentId}/*`,
        },
        // CloudWatch Logs
        {
          Effect:   'Allow',
          Action:   ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: `arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT}:log-group:/openclaw/agents:log-stream:openclaw-*/${tenantId}/*`,
        },
      ],
    }),
  }));

  // Store IAM role ARN on agent record
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    UpdateExpression: 'SET iam_task_role_arn = :arn, iam_task_role_name = :name',
    ExpressionAttributeValues: { ':arn': roleArn, ':name': roleName },
  }));

  logger.info('IAM task role created', { tenant_id: tenantId, agent_id: agentId, role_arn: roleArn });
  return { iamRoleArn: roleArn };
}

async function renderInitialConfig(event: ProvisioningInput) {
  const { tenantId, agentId } = event as { tenantId: string; agentId: string };

  // Invoke configRenderer to write default openclaw.json to EFS
  const result = await lambda.send(new InvokeCommand({
    FunctionName:   CONFIG_RENDERER_ARN,
    InvocationType: 'RequestResponse',
    Payload:        Buffer.from(JSON.stringify({ tenantId, agentId })),
  }));

  if (result.FunctionError) {
    throw new Error(`configRenderer failed: ${result.FunctionError}`);
  }

  // Update agent status to READY
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    UpdateExpression: 'SET #s = :s, gsi2pk = :gsi2pk, provisioned_at = :now, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s':      'STOPPED',
      ':gsi2pk': 'STATUS#STOPPED',
      ':now':    new Date().toISOString(),
    },
  }));

  logger.info('Initial config rendered', { tenant_id: tenantId, agent_id: agentId });
  return {};
}

async function sendWelcomeEmail(event: ProvisioningInput) {
  const { tenantId, customerEmail, planCode } = event as {
    tenantId: string; customerEmail?: string; planCode: string;
  };

  if (!customerEmail) return {};

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: 'welcome@lavavps.ai',
      Destination:      { ToAddresses: [customerEmail] },
      Content: {
        Simple: {
          Subject: { Data: 'Welcome to LavaVPS — your AI agent is ready' },
          Body: {
            Html: {
              Data: `
                <h2>Welcome to LavaVPS!</h2>
                <p>Your ${planCode} plan is active and your first AI agent has been provisioned.</p>
                <p>To get started:</p>
                <ol>
                  <li><a href="https://lavavps.ai">Sign in to your portal</a></li>
                  <li>Add your LLM provider API key (Anthropic, OpenAI, etc.)</li>
                  <li>Your agent will walk you through setup</li>
                </ol>
                <p>Your token purchases go directly to your LLM provider — LavaVPS never charges for API usage.</p>
                <p>Questions? Reply to this email or join our <a href="https://discord.gg/lavavps">Discord</a>.</p>
              `,
            },
          },
        },
      },
    }));
  } catch (err) {
    // Non-critical: log but don't fail provisioning
    logger.warn('Welcome email failed', {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }

  return {};
}

// ── Compensating Actions (Rollback) ───────────────────────────────────────────

async function deleteCognitoUser(event: ProvisioningInput) {
  if (!event.cognitoUserId) return {};
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   event.cognitoUserId,
    }));
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name !== 'UserNotFoundException') throw err;
  }
  return {};
}

async function deleteDynamoRecords(event: ProvisioningInput) {
  const { tenantId, agentId, stripeSubId } = event as {
    tenantId?: string; agentId?: string; stripeSubId: string;
  };
  if (!tenantId) return {};

  const deletes = [];
  if (tenantId) deletes.push(dynamo.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` } })));
  if (agentId)  deletes.push(dynamo.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` } })));
  deletes.push(dynamo.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: `TENANT#${tenantId}`, sk: `SUB#${stripeSubId}` } })));

  await Promise.allSettled(deletes);
  return {};
}

async function deleteEfsAccessPoint(event: ProvisioningInput) {
  const { efsApId } = event as { efsApId?: string };
  if (!efsApId) return {};
  try {
    await efs.send(new DeleteAccessPointCommand({ AccessPointId: efsApId }));
  } catch { /* ignore */ }
  return {};
}

async function deleteIamTaskRole(event: ProvisioningInput) {
  const { tenantId, agentId } = event as { tenantId?: string; agentId?: string };
  if (!tenantId || !agentId) return {};
  const roleName = `lavavps-task-${tenantId.slice(0, 8)}-${agentId.slice(0, 8)}`;
  try {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: 'lavavps-agent-policy' }));
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch { /* ignore */ }
  return {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let pwd = '';
  for (let i = 0; i < 16; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  // Ensure it meets Cognito password policy (upper + lower + number + symbol)
  return `Lv${pwd}!1`;
}
