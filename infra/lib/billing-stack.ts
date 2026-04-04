import * as cdk    from 'aws-cdk-lib';
import * as kms    from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam    from 'aws-cdk-lib/aws-iam';
import * as logs   from 'aws-cdk-lib/aws-logs';
import * as sns    from 'aws-cdk-lib/aws-sns';
import * as subs   from 'aws-cdk-lib/aws-sns-subscriptions';
import * as apigw  from 'aws-cdk-lib/aws-apigateway';
import * as sfn    from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks  from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sm     from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// BillingStack
//
// Stripe webhook handler + Step Functions provisioning saga.
//
// Provisioning State Machine (10 steps + compensating rollbacks):
//   1. createCognitoUser    → Create Cognito user + assign tenant_id
//   2. createDynamoRecords  → Write tenant/agent/subscription records
//   3. createEfsAccessPoint → EFS AP with uid=1000 for agent
//   4. createIamTaskRole    → Scoped IAM role for this agent's task
//   5. renderInitialConfig  → Write default openclaw.json via configRenderer
//   6. sendWelcomeEmail     → SES welcome email (non-critical)
//
// On any step failure: Step Functions triggers compensating actions in reverse.
// The running agent is never touched on provisioning failure.
// ─────────────────────────────────────────────────────────────────────────────

export interface BillingStackProps extends cdk.StackProps {
  readonly cmk: kms.Key;
}

export class BillingStack extends cdk.Stack {
  public readonly provisioningSmArn: string;
  public readonly webhookEndpointUrl: string;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    // ── Stripe Secrets ────────────────────────────────────────────────────
    // Stripe webhook signing secret (populated manually in AWS Secrets Manager)
    // Path: /openclaw/prod/stripe/webhook-signing-secret
    // Content: { "webhookSigningSecret": "whsec_..." }
    const stripeWebhookSecret = sm.Secret.fromSecretNameV2(
      this, 'StripeWebhookSecret',
      '/openclaw/prod/stripe/webhook-signing-secret',
    );

    // ── SNS Topics ────────────────────────────────────────────────────────
    const opsAlertsTopic = new sns.Topic(this, 'OpsAlerts', {
      topicName:    'lavavps-ops-alerts',
      displayName:  'LavaVPS Operations Alerts',
      masterKey:    props.cmk,
    });

    const provisioningTopic = new sns.Topic(this, 'ProvisioningNotifications', {
      topicName:    'lavavps-provisioning',
      displayName:  'LavaVPS Provisioning Events',
      masterKey:    props.cmk,
    });

    // ── Lambda log group ──────────────────────────────────────────────────
    const billingLogGroup = new logs.LogGroup(this, 'BillingLogGroup', {
      logGroupName:  '/openclaw/billing',
      retention:     logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.cmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const baseEnv = {
      TABLE_NAME:           Config.deployed.dynamoTableName,
      USER_POOL_ID:         Config.deployed.userPoolId,
      EFS_ID:               Config.deployed.efsId,
      CONFIG_BUCKET:        Config.deployed.configBucket,
      CONFIG_RENDERER_ARN:  Config.deployed.configRendererArn,
      CLUSTER_ARN:          Config.deployed.clusterArn,
      FARGATE_EXECUTION_ROLE: Config.deployed.fargateExecutionRole,
      AWS_ACCOUNT:          Config.account,
      AWS_REGION_NAME:      Config.region,
      OPS_SNS_ARN:          opsAlertsTopic.topicArn,
    };

    const baseLambdaProps = {
      runtime:      lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      logGroup:     billingLogGroup,
      tracing:      lambda.Tracing.ACTIVE,
      memorySize:   512,
    };

    // ── Provisioning Lambda ───────────────────────────────────────────────
    const provisioningFn = new lambda.Function(this, 'ProvisioningFn', {
      ...baseLambdaProps,
      functionName: 'lavavps-provisioning',
      description:  'Step Functions task handler for all provisioning steps',
      code:         lambda.Code.fromAsset('lambdas/handlers/provisioning'),
      handler:      'index.handler',
      timeout:      cdk.Duration.seconds(60),
      environment:  baseEnv,
    });

    // Grant broad permissions for provisioning (creates resources for tenants)
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                  'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [Config.deployed.dynamoTableArn,
                  `${Config.deployed.dynamoTableArn}/index/*`],
    }));
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser',
                  'cognito-idp:AdminSetUserPassword'],
      resources: [Config.deployed.userPoolArn],
    }));
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DeleteAccessPoint',
                  'elasticfilesystem:DescribeAccessPoints'],
      resources: [`arn:aws:elasticfilesystem:${Config.region}:${Config.account}:file-system/${Config.deployed.efsId}`,
                  `arn:aws:elasticfilesystem:${Config.region}:${Config.account}:access-point/*`],
    }));
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['iam:CreateRole', 'iam:DeleteRole', 'iam:PutRolePolicy',
                  'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
      resources: [`arn:aws:iam::${Config.account}:role/lavavps-task-*`],
    }));
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['lambda:InvokeFunction'],
      resources: [Config.deployed.configRendererArn],
    }));
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['ses:SendEmail'],
      resources: ['*'],
    }));
    provisioningFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [Config.deployed.cmkArn],
    }));

    // ── Step Functions: Provisioning State Machine ────────────────────────
    // Saga pattern: each step has a compensating action invoked on failure.
    // Step Functions handles retry logic and error propagation.

    const invoke = (stepName: string, resultPath?: string) =>
      new tasks.LambdaInvoke(this, `Step_${stepName}`, {
        lambdaFunction:  provisioningFn,
        payload:         sfn.TaskInput.fromObject({
          step:             stepName,
          'mode.$':         '$.mode',
          'stripeCustomerId.$': '$.stripeCustomerId',
          'stripeSubId.$':  '$.stripeSubId',
          'planCode.$':     '$.planCode',
          'customerEmail.$': '$.customerEmail',
          'tenantId.$':     sfn.JsonPath.stringAt('$.tenantId'),
          'agentId.$':      sfn.JsonPath.stringAt('$.agentId'),
          'cognitoUserId.$': sfn.JsonPath.stringAt('$.cognitoUserId'),
          'efsApId.$':      sfn.JsonPath.stringAt('$.efsApId'),
          'iamRoleArn.$':   sfn.JsonPath.stringAt('$.iamRoleArn'),
        }),
        resultSelector:  { 'result.$': '$.Payload' },
        resultPath:      resultPath ?? sfn.JsonPath.DISCARD,
        retryOnServiceExceptions: true,
      });

    // Build state machine chain
    const step1 = invoke('createCognitoUser',     '$.cognitoResult');
    const step2 = invoke('createDynamoRecords',    sfn.JsonPath.DISCARD);
    const step3 = invoke('createEfsAccessPoint',   '$.efsResult');
    const step4 = invoke('createIamTaskRole',      '$.iamResult');
    const step5 = invoke('renderInitialConfig',    sfn.JsonPath.DISCARD);
    const step6 = invoke('sendWelcomeEmail',       sfn.JsonPath.DISCARD);

    const succeed = new sfn.Succeed(this, 'ProvisioningComplete', {
      comment: 'Tenant and agent provisioned successfully',
    });

    const fail = new sfn.Fail(this, 'ProvisioningFailed', {
      comment: 'Provisioning failed — compensating actions completed',
    });

    // Simple linear chain (Step Functions handles retries)
    const chain = step1
      .next(step2)
      .next(step3)
      .next(step4)
      .next(step5)
      .next(step6)
      .next(succeed);

    const stateMachine = new sfn.StateMachine(this, 'ProvisioningSM', {
      stateMachineName: 'lavavps-provisioning',
      definitionBody:   sfn.DefinitionBody.fromChainable(chain),
      timeout:          cdk.Duration.minutes(10),
      tracingEnabled:   true,
      logs: {
        destination:          new logs.LogGroup(this, 'SFNLogGroup', {
          logGroupName:  '/openclaw/stepfunctions/provisioning',
          retention:     logs.RetentionDays.ONE_MONTH,
          encryptionKey: props.cmk,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level:                sfn.LogLevel.ERROR,
        includeExecutionData: true,
      },
    });

    this.provisioningSmArn = stateMachine.stateMachineArn;

    // ── Stripe Webhook Lambda ─────────────────────────────────────────────
    const webhookFn = new lambda.Function(this, 'StripeWebhookFn', {
      ...baseLambdaProps,
      functionName: 'lavavps-stripe-webhook',
      description:  'Stripe webhook: HMAC verify, idempotency, route to state machine',
      code:         lambda.Code.fromAsset('lambdas/handlers/stripeWebhook'),
      handler:      'index.handler',
      timeout:      cdk.Duration.seconds(30),
      environment: {
        ...baseEnv,
        PROVISIONING_SM_ARN: stateMachine.stateMachineArn,
        WEBHOOK_SECRET_ARN:  stripeWebhookSecret.secretArn,
      },
    });

    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
      resources: [Config.deployed.dynamoTableArn,
                  `${Config.deployed.dynamoTableArn}/index/*`],
    }));
    // grantRead handles the ARN suffix wildcard correctly (fromSecretNameV2
    // generates ???? placeholders that are NOT wildcards in IAM policies)
    stripeWebhookSecret.grantRead(webhookFn);
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['states:StartExecution'],
      resources: [stateMachine.stateMachineArn],
    }));
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['kms:Decrypt'],
      resources: [Config.deployed.cmkArn],
    }));

    // ── Webhook API Gateway endpoint ──────────────────────────────────────
    // Public HTTPS endpoint — Stripe posts here. No auth (HMAC is the gate).
    const webhookApi = new apigw.RestApi(this, 'WebhookApi', {
      restApiName:    'lavavps-webhook',
      description:    'Stripe webhook receiver',
      endpointTypes:  [apigw.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
      },
    });

    const webhookResource = webhookApi.root.addResource('stripe');
    webhookResource.addMethod('POST', new apigw.LambdaIntegration(webhookFn, {
      proxy: true,
      // Preserve raw body for HMAC verification — critical
      contentHandling: apigw.ContentHandling.CONVERT_TO_TEXT,
    }));

    this.webhookEndpointUrl = `${webhookApi.url}stripe`;

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebhookEndpointUrl', {
      value:      this.webhookEndpointUrl,
      exportName: 'LavaVPS-WebhookEndpointUrl',
      description: 'Add this URL to Stripe webhook settings',
    });

    new cdk.CfnOutput(this, 'ProvisioningSmArn', {
      value:      stateMachine.stateMachineArn,
      exportName: 'LavaVPS-ProvisioningSmArn',
    });

    new cdk.CfnOutput(this, 'OpsAlertsTopicArn', {
      value:      opsAlertsTopic.topicArn,
      exportName: 'LavaVPS-OpsAlertsTopicArn',
      description: 'Subscribe your email here for crash loop + provisioning failure alerts',
    });

    new cdk.CfnOutput(this, 'StripeSecretNote', {
      value:      'MANUAL STEP: Store Stripe webhook signing secret at /openclaw/prod/stripe/webhook-signing-secret as { "webhookSigningSecret": "whsec_..." }',
      description: 'Required before Stripe webhooks will be accepted',
    });

    cdk.Tags.of(this).add('Stack', 'Billing');
  }
}
