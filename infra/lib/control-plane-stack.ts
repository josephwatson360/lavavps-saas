import * as cdk     from 'aws-cdk-lib';
import * as ec2     from 'aws-cdk-lib/aws-ec2';
import * as efs     from 'aws-cdk-lib/aws-efs';
import * as iam     from 'aws-cdk-lib/aws-iam';
import * as kms     from 'aws-cdk-lib/aws-kms';
import * as lambda  from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs    from 'aws-cdk-lib/aws-logs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw   from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as s3      from 'aws-cdk-lib/aws-s3';
import * as events  from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// ControlPlaneStack
//
// All Lambda functions and API Gateway (REST + WebSocket).
// Lambda functions are Node.js 22.x, ARM64 (20% cheaper than x86), X-Ray enabled.
//
// Lambda build order (dependency chain):
//   authorizerHandler     - JWT validation (no deps)
//   configRenderer        - config pipeline engine (no API Gateway endpoint)
//   bootstrapperLambda    - EFS writer (no API Gateway endpoint, VPC)
//   configHandler         - invokes configRenderer
//   agentHandler          - agent CRUD
//   keyHandler            - LLM API key storage
//   modelsHandler         - dynamic model list
//   taskHandler           - ECS task start/stop
//   channelHandler        - channel credentials
//   fileHandler           - EFS file management
//   wsHandler             - WebSocket $connect/$disconnect/$default
//   taskWatcherLambda     - scheduled idle timeout + crash loop detection
//   jobHandler            - Ralph Loop jobs (Phase 7)
// ─────────────────────────────────────────────────────────────────────────────

export interface ControlPlaneStackProps extends cdk.StackProps {
  readonly vpc:           ec2.Vpc;
  readonly cmk:           kms.Key;
  readonly lambdaSg:      ec2.SecurityGroup;
  readonly configBucket:     s3.Bucket;
  readonly bootstrapperApId: string;
  readonly userPool:      cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly eventBus:      events.EventBus;
}

export class ControlPlaneStack extends cdk.Stack {
  public readonly restApi:   apigw.RestApi;
  public readonly wsApi:     apigwv2.CfnApi;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    // ── Shared Lambda environment variables ───────────────────────────────
    const commonEnv = {
      TABLE_NAME:           Config.deployed.dynamoTableName,
      CONFIG_BUCKET:        Config.deployed.configBucket,
      USER_POOL_ID:         Config.deployed.userPoolId,
      USER_POOL_CLIENT_ID:  Config.deployed.userPoolClientId,
      CLUSTER_NAME:         Config.deployed.clusterName,
      OPENCLAW_PORT:        String(Config.openclawPort),
      OLLAMA_ALB_DNS:       Config.deployed.ollamaAlbDns,
      TRUSTED_PROXIES:      Config.deployed.trustedProxies.join(','),
      AWS_ACCOUNT:          Config.account,
      AWS_REGION_NAME:      Config.region,
    };

    // ── Lambda Layer (shared utilities) ───────────────────────────────────
    const utilsLayer = new lambda.LayerVersion(this, 'UtilsLayer', {
      layerVersionName: 'lavavps-utils',
      code:             lambda.Code.fromAsset('lambdas/layer'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      description:      'LavaVPS shared utilities: logger, response helpers',
    });

    // ── Shared log group for all Lambda functions ───────────────────────────
    const lambdaLogGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName:  '/openclaw/lambdas',
      retention:     logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.cmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda base props (applied to every function) ─────────────────────
    const baseLambdaProps: Partial<lambda.FunctionProps> = {
      runtime:      lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      layers:       [utilsLayer],
      environment:  commonEnv,
      tracing:      lambda.Tracing.ACTIVE,  // X-Ray tracing
      logGroup:     lambdaLogGroup,
      memorySize:   512,
      timeout:      cdk.Duration.seconds(30),
    };

    // ── IAM Policy Statements ─────────────────────────────────────────────
    const dynamoPolicy = new iam.PolicyStatement({
      actions:   ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                  'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
      resources: [
        Config.deployed.dynamoTableArn,
        `${Config.deployed.dynamoTableArn}/index/*`,
      ],
    });

    const s3ConfigPolicy = new iam.PolicyStatement({
      actions:   ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${Config.deployed.configBucket}`,
        `arn:aws:s3:::${Config.deployed.configBucket}/*`,
      ],
    });

    const secretsPolicy = new iam.PolicyStatement({
      actions:   ['secretsmanager:CreateSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:TagResource', 'secretsmanager:TagResource', 'secretsmanager:TagResource',
                  'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret'],
      resources: [`arn:aws:secretsmanager:${Config.region}:${Config.account}:secret:/openclaw/*`],
    });

    const ecsPolicy = new iam.PolicyStatement({
      actions:   ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks',
                  'ecs:DescribeServices', 'ecs:UpdateService', 'ecs:TagResource'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'ecs:cluster': Config.deployed.clusterArn,
        },
      },
    });

    const iamPassRolePolicy = new iam.PolicyStatement({
      actions:   ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${Config.account}:role/lavavps-*`,
        `arn:aws:iam::${Config.account}:role/openclaw-task-role`,
        `arn:aws:iam::${Config.account}:role/openclaw-task-execution-role`,
      ],
    });

    const elbPolicy = new iam.PolicyStatement({
      actions:   ['elasticloadbalancing:RegisterTargets', 'elasticloadbalancing:DeregisterTargets',
                  'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
                  'elasticloadbalancing:CreateRule', 'elasticloadbalancing:DeleteRule',
                  'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeRules'],
      resources: ['*'],
    });

    const kmsPolicy = new iam.PolicyStatement({
      actions:   ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [Config.deployed.cmkArn],
    });

    // ── NodejsFunction base bundling config ──────────────────────────────
    // Used by all TypeScript handlers — esbuild compiles at cdk deploy time.
    // @aws-sdk/* excluded: provided by Lambda runtime, keeps bundle small.
    const nodejsBundling = {
      minify:          true,
      sourceMap:       true,
      externalModules: ['@aws-sdk/*'],
      target:          'node22',
    };

    // ── VPC Lambda config (for EFS access) ───────────────────────────────
    const vpcLambdaProps = {
      vpc:            props.vpc,
      securityGroups: [props.lambdaSg],
      vpcSubnets:     { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    };

    // EFS Access Point ARN - built from ID passed via props
    // Used in CFN escape hatch on bootstrapperFn to avoid CDK auto-SG-management cycle
    const efsAccessPointArn = `arn:aws:elasticfilesystem:${Config.region}:${Config.account}:access-point/${props.bootstrapperApId}`;

    // ──────────────────────────────────────────────────────────────────────
    // LAMBDA FUNCTIONS
    // ──────────────────────────────────────────────────────────────────────

    // ── authorizerHandler ─────────────────────────────────────────────────
    const authorizerFn = new lambda.Function(this, 'AuthorizerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-authorizer',
      description:  'Validates Cognito JWT and extracts tenant context',
      code:         lambda.Code.fromAsset('lambdas/handlers/authorizer'),
      handler:      'index.handler',
      timeout:      cdk.Duration.seconds(10), // Authorizers must be fast
    });

    // ── bootstrapperLambda ────────────────────────────────────────────────
    const bootstrapperFn = new lambda.Function(this, 'BootstrapperFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName:  'lavavps-bootstrapper',
      description:   'Copies validated openclaw.json from S3 to tenant EFS Access Point',
      code:          lambda.Code.fromAsset('lambdas/handlers/bootstrapper'),
      handler:       'index.handler',
      timeout:       cdk.Duration.seconds(30),
      ...vpcLambdaProps,
      // No filesystem prop here - configured via CFN escape hatch below to avoid cycle
      environment: {
        ...commonEnv,
        EFS_MOUNT: '/mnt/efs',
      },
    });
    bootstrapperFn.addToRolePolicy(s3ConfigPolicy);
    bootstrapperFn.addToRolePolicy(kmsPolicy);

    // Configure EFS mount via CFN escape hatch - bypasses CDK auto-SG-management cycle
    // This is equivalent to what lambda.FileSystem.fromEfsAccessPoint() does internally
    // but without triggering cross-stack security group rule creation.
    (bootstrapperFn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'FileSystemConfigs',
      [{ Arn: efsAccessPointArn, LocalMountPath: '/mnt/efs' }],
    );

    // ── configRenderer ────────────────────────────────────────────────────
    const configRendererFn = new NodejsFunction(this, 'ConfigRendererFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-config-renderer',
      description:  'Renders locked openclaw.json from tenant DynamoDB values, validates, writes to S3/EFS',
      entry:        'lambdas/handlers/configRenderer/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      timeout:      cdk.Duration.seconds(60),
      environment: {
        ...commonEnv,
        BOOTSTRAPPER_ARN: `arn:aws:lambda:${Config.region}:${Config.account}:function:lavavps-bootstrapper`,
      },
    });
    configRendererFn.addToRolePolicy(dynamoPolicy);
    configRendererFn.addToRolePolicy(s3ConfigPolicy);
    configRendererFn.addToRolePolicy(kmsPolicy);
    configRendererFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['lambda:InvokeFunction'],
      resources: [bootstrapperFn.functionArn],
    }));

    // ── configHandler ─────────────────────────────────────────────────────
    const configHandlerFn = new NodejsFunction(this, 'ConfigHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-config-handler',
      description:  'Allowlist validates config fields, writes to DynamoDB, invokes configRenderer',
      entry:        'lambdas/handlers/configHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      environment: {
        ...commonEnv,
        CONFIG_RENDERER_ARN: configRendererFn.functionArn,
      },
    });
    configHandlerFn.addToRolePolicy(dynamoPolicy);
    configHandlerFn.addToRolePolicy(kmsPolicy);
    configHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['lambda:InvokeFunction'],
      resources: [configRendererFn.functionArn],
    }));

    // ── agentHandler ─────────────────────────────────────────────────────
    const agentHandlerFn = new NodejsFunction(this, 'AgentHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-agent-handler',
      description:  'Agent CRUD with plan quota enforcement',
      entry:        'lambdas/handlers/agentHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
    });
    agentHandlerFn.addToRolePolicy(dynamoPolicy);
    agentHandlerFn.addToRolePolicy(kmsPolicy);

    // ── keyHandler ────────────────────────────────────────────────────────
    const keyHandlerFn = new NodejsFunction(this, 'KeyHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-key-handler',
      description:  'LLM provider API key storage in Secrets Manager',
      entry:        'lambdas/handlers/keyHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      environment: {
        ...commonEnv,
        CONFIG_RENDERER_ARN: configRendererFn.functionArn,
      },
    });
    keyHandlerFn.addToRolePolicy(dynamoPolicy);
    keyHandlerFn.addToRolePolicy(secretsPolicy);
    keyHandlerFn.addToRolePolicy(kmsPolicy);
    keyHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['lambda:InvokeFunction'],
      resources: [configRendererFn.functionArn],
    }));

    // ── modelsHandler ─────────────────────────────────────────────────────
    const modelsHandlerFn = new NodejsFunction(this, 'ModelsHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-models-handler',
      description:  'Dynamic model list from LLM provider APIs (1hr cache)',
      entry:        'lambdas/handlers/modelsHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      timeout:      cdk.Duration.seconds(15),
    });
    modelsHandlerFn.addToRolePolicy(dynamoPolicy);
    modelsHandlerFn.addToRolePolicy(secretsPolicy);
    modelsHandlerFn.addToRolePolicy(kmsPolicy);

    // ── taskHandler ───────────────────────────────────────────────────────
    const taskHandlerFn = new NodejsFunction(this, 'TaskHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-task-handler',
      description:  'ECS task start/stop with pre-wake readyz polling',
      entry:        'lambdas/handlers/taskHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      timeout:      cdk.Duration.seconds(90), // pre-wake polls up to 45s
      environment: {
        ...commonEnv,
        PRIVATE_SUBNETS: Config.privateSubnetIds.join(','),
        FARGATE_SG_ID:   Config.sgIds.fargate,
        EFS_ID:          Config.deployed.efsId,
      },
    });
    taskHandlerFn.addToRolePolicy(dynamoPolicy);
    taskHandlerFn.addToRolePolicy(ecsPolicy);
    taskHandlerFn.addToRolePolicy(iamPassRolePolicy);
    taskHandlerFn.addToRolePolicy(kmsPolicy);

    // ── channelHandler ────────────────────────────────────────────────────
    const channelHandlerFn = new NodejsFunction(this, 'ChannelHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-channel-handler',
      description:  'Discord/Telegram/WhatsApp channel credential management',
      entry:        'lambdas/handlers/channelHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      environment: {
        ...commonEnv,
        CONFIG_RENDERER_ARN: configRendererFn.functionArn,
      },
    });
    channelHandlerFn.addToRolePolicy(dynamoPolicy);
    channelHandlerFn.addToRolePolicy(kmsPolicy);
    channelHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['lambda:InvokeFunction'],
      resources: [configRendererFn.functionArn],
    }));

    // ── fileHandler ───────────────────────────────────────────────────────
    const fileHandlerFn = new NodejsFunction(this, 'FileHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-file-handler',
      description:  'EFS workspace file management with storage quota enforcement',
      entry:        'lambdas/handlers/fileHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
    });
    fileHandlerFn.addToRolePolicy(dynamoPolicy);
    fileHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${Config.deployed.chatBucket}`,
        `arn:aws:s3:::${Config.deployed.chatBucket}/*`,
      ],
    }));
    fileHandlerFn.addToRolePolicy(kmsPolicy);

    // ── wsHandler ─────────────────────────────────────────────────────────
    const wsHandlerFn = new NodejsFunction(this, 'WsHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-ws-handler',
      description:  'WebSocket relay: portal <-> OpenClaw agent',
      entry:        'lambdas/handlers/wsHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      timeout:      cdk.Duration.seconds(29), // API GW WS max
      ...vpcLambdaProps,
    });
    wsHandlerFn.addToRolePolicy(dynamoPolicy);
    wsHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${Config.region}:${Config.account}:${Config.deployed.wsApiId}/*`],
    }));
    wsHandlerFn.addToRolePolicy(kmsPolicy);

    // ── taskWatcherLambda ─────────────────────────────────────────────────
    const taskWatcherFn = new NodejsFunction(this, 'TaskWatcherFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-task-watcher',
      description:  'Scheduled: idle timeout enforcement + crash loop detection',
      entry:        'lambdas/handlers/taskWatcher/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      timeout:      cdk.Duration.seconds(60),
      environment: {
        ...commonEnv,
        OPS_SNS_ARN: `arn:aws:sns:${Config.region}:${Config.account}:lavavps-ops-alerts`,
      },
    });
    taskWatcherFn.addToRolePolicy(dynamoPolicy);
    taskWatcherFn.addToRolePolicy(ecsPolicy);
    taskWatcherFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['sns:Publish'],
      resources: [`arn:aws:sns:${Config.region}:${Config.account}:lavavps-ops-alerts`],
    }));
    taskWatcherFn.addToRolePolicy(kmsPolicy);

    // Wire taskWatcher to the scheduled rule
    const taskWatcherTarget = new targets.LambdaFunction(taskWatcherFn, {
      retryAttempts: 1,
    });

    // ── jobHandler ────────────────────────────────────────────────────────
    const jobHandlerFn = new NodejsFunction(this, 'JobHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-job-handler',
      description:  'Ralph Loop autonomous task management (Pro+ only)',
      entry:        'lambdas/handlers/jobHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
    });
    jobHandlerFn.addToRolePolicy(dynamoPolicy);
    jobHandlerFn.addToRolePolicy(kmsPolicy);

    // ── billingHandler ────────────────────────────────────────────────────
    const billingHandlerFn = new lambda.Function(this, 'BillingHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-billing-handler',
      description:  'Stripe Checkout + Customer Portal session creation',
      code:         lambda.Code.fromAsset('lambdas/handlers/billingHandler'),
      handler:      'index.handler',
      environment: {
        PORTAL_URL:          'https://main.d2fwekdsfw5bt0.amplifyapp.com',
        STRIPE_SECRET_ARN:   '/openclaw/prod/stripe/secret-key',
        PRICE_IDS_SECRET:    '/openclaw/prod/stripe/price-ids',
      },
    });
    billingHandlerFn.addToRolePolicy(dynamoPolicy);
    billingHandlerFn.addToRolePolicy(kmsPolicy);
    // Grant access to Stripe secret key + price IDs
    billingHandlerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${Config.region}:${Config.account}:secret:/openclaw/prod/stripe/*`,
      ],
    }));

        // ── API Gateway REST API ───────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName:  '/openclaw/api/access',
      retention:     logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.cmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.restApi = new apigw.RestApi(this, 'RestApi', {
      restApiName:       'lavavps-api',
      description:       'LavaVPS control plane REST API',
      endpointTypes:     [apigw.EndpointType.REGIONAL],
      deployOptions: {
        stageName:          'prod',
        loggingLevel:       apigw.MethodLoggingLevel.ERROR,
        accessLogDestination: new apigw.LogGroupLogDestination(logGroup),
        accessLogFormat:    apigw.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled:     true,
        throttlingRateLimit:    500,
        throttlingBurstLimit:  1000,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['https://lavavps.ai', 'https://www.lavavps.ai', 'https://main.d2fwekdsfw5bt0.amplifyapp.com', 'http://localhost:3000'],
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      },
    });

    // Cognito authorizer for REST API
    const cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuth', {
      authorizerName:    'lavavps-cognito-auth',
      cognitoUserPools:  [props.userPool],
      identitySource:    'method.request.header.Authorization',
      resultsCacheTtl:   cdk.Duration.minutes(5),
    });

    // API routes: /agents/{agentId}/config
    const agentsResource = this.restApi.root.addResource('agents');
    const agentResource  = agentsResource.addResource('{agentId}');
    const configResource = agentResource.addResource('config');

    const lambdaIntegration = (fn: lambda.Function) =>
      new apigw.LambdaIntegration(fn, { proxy: true });

    const authOptions: apigw.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    configResource.addMethod('GET', lambdaIntegration(configHandlerFn), authOptions);
    configResource.addMethod('PUT', lambdaIntegration(configHandlerFn), authOptions);

    // GET/POST /agents
    agentsResource.addMethod('GET',  lambdaIntegration(agentHandlerFn), authOptions);
    agentsResource.addMethod('POST', lambdaIntegration(agentHandlerFn), authOptions);

    // GET/DELETE /agents/{agentId}
    agentResource.addMethod('GET',    lambdaIntegration(agentHandlerFn), authOptions);
    agentResource.addMethod('DELETE', lambdaIntegration(agentHandlerFn), authOptions);

    // POST/DELETE /agents/{agentId}/keys
    const keysResource = agentResource.addResource('keys');
    keysResource.addMethod('POST',   lambdaIntegration(keyHandlerFn), authOptions);
    keysResource.addMethod('DELETE', lambdaIntegration(keyHandlerFn), authOptions);

    // GET /agents/{agentId}/models
    const modelsResource = agentResource.addResource('models');
    modelsResource.addMethod('GET', lambdaIntegration(modelsHandlerFn), authOptions);

    // GET/POST /agents/{agentId}/status|start|stop
    const statusResource = agentResource.addResource('status');
    statusResource.addMethod('GET', lambdaIntegration(taskHandlerFn), authOptions);

    const actionResource = agentResource.addResource('{action}'); // start | stop
    actionResource.addMethod('POST', lambdaIntegration(taskHandlerFn), authOptions);

    // PUT /agents/{agentId}/channels
    // DELETE /agents/{agentId}/channels/{channelName}
    const channelsResource = agentResource.addResource('channels');
    channelsResource.addMethod('PUT', lambdaIntegration(channelHandlerFn), authOptions);
    const channelNameResource = channelsResource.addResource('{channelName}');
    channelNameResource.addMethod('DELETE', lambdaIntegration(channelHandlerFn), authOptions);

    // GET/POST /agents/{agentId}/files
    // GET/DELETE /agents/{agentId}/files/{fileKey+}
    const filesResource = agentResource.addResource('files');
    filesResource.addMethod('GET',  lambdaIntegration(fileHandlerFn), authOptions);
    filesResource.addMethod('POST', lambdaIntegration(fileHandlerFn), authOptions);
    const fileKeyResource = filesResource.addResource('{fileKey+}');
    fileKeyResource.addMethod('GET',    lambdaIntegration(fileHandlerFn), authOptions);
    fileKeyResource.addMethod('DELETE', lambdaIntegration(fileHandlerFn), authOptions);

    // GET/POST /agents/{agentId}/jobs
    // GET/DELETE /agents/{agentId}/jobs/{jobId}
    const jobsResource = agentResource.addResource('jobs');
    jobsResource.addMethod('GET',  lambdaIntegration(jobHandlerFn), authOptions);
    jobsResource.addMethod('POST', lambdaIntegration(jobHandlerFn), authOptions);
    const jobResource = jobsResource.addResource('{jobId}');
    jobResource.addMethod('GET',    lambdaIntegration(jobHandlerFn), authOptions);
    jobResource.addMethod('DELETE', lambdaIntegration(jobHandlerFn), authOptions);

    // /billing/checkout + /billing/portal
    const billingResource  = this.restApi.root.addResource('billing');
    const checkoutResource = billingResource.addResource('checkout');
    const portalResource   = billingResource.addResource('portal');
    checkoutResource.addMethod('POST', lambdaIntegration(billingHandlerFn), authOptions);
    portalResource.addMethod('POST',   lambdaIntegration(billingHandlerFn), authOptions);

    // ── Gateway responses with CORS headers ────────────────────────────────
    // Without this, API Gateway's own error responses (401, 403, 503, etc.)
    // are returned WITHOUT CORS headers, causing browsers to show "Failed to fetch"
    // instead of the actual error. This adds CORS headers to ALL error responses.
    const corsResponseHeaders = {
      'Access-Control-Allow-Origin':  "'*'",
      'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Amzn-Trace-Id'",
      'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'",
    };
    const gwResponses: Array<[string, apigw.ResponseType]> = [
      ['GwResp4xx',          apigw.ResponseType.DEFAULT_4XX],
      ['GwResp5xx',          apigw.ResponseType.DEFAULT_5XX],
      ['GwRespUnauthorized', apigw.ResponseType.UNAUTHORIZED],
      ['GwRespAccessDenied', apigw.ResponseType.ACCESS_DENIED],
      ['GwRespNotFound',     apigw.ResponseType.RESOURCE_NOT_FOUND],
      ['GwRespQuota',        apigw.ResponseType.QUOTA_EXCEEDED],
      ['GwRespThrottled',    apigw.ResponseType.THROTTLED],
    ];
    for (const [id, type] of gwResponses) {
      this.restApi.addGatewayResponse(id, { type, responseHeaders: corsResponseHeaders });
    }

    // ── WebSocket API (API Gateway v2) ────────────────────────────────────
    this.wsApi = new apigwv2.CfnApi(this, 'WsApi', {
      name:                       'lavavps-ws',
      protocolType:               'WEBSOCKET',
      routeSelectionExpression:   '$request.body.action',
      description:                'LavaVPS WebSocket API for real-time agent chat',
    });

    // WebSocket Lambda integration
    const wsIntegration = new apigwv2.CfnIntegration(this, 'WsIntegration', {
      apiId:             this.wsApi.ref,
      integrationType:   'AWS_PROXY',
      integrationUri:    `arn:aws:apigateway:${Config.region}:lambda:path/2015-03-31/functions/${wsHandlerFn.functionArn}/invocations`,
    });

    // WebSocket routes: $connect, $disconnect, $default
    for (const routeKey of ['$connect', '$disconnect', '$default']) {
      const route = new apigwv2.CfnRoute(this, `WsRoute${routeKey.replace('$', '')}`, {
        apiId:    this.wsApi.ref,
        routeKey,
        target:   `integrations/${wsIntegration.ref}`,
        authorizationType: 'NONE', // wsHandler validates JWT from query param ?token=
      });
      void route;
    }

    // Grant API Gateway permission to invoke wsHandler
    wsHandlerFn.addPermission('WsApiInvoke', {
      principal:   new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn:   `arn:aws:execute-api:${Config.region}:${Config.account}:${this.wsApi.ref}/*`,
    });

    // ── EventBridge: Task Watcher schedule ───────────────────────────────
    // taskWatcherLambda runs every 2 minutes to check idle timeouts and crash loops
    // Built in Phase 4 Part B — placeholder rule created now
    // ── taskStateChangeHandler — EventBridge ECS Task State Change ─────────────
    // Triggered by EventBridge when an ECS task in the lavavps-agents cluster
    // transitions to RUNNING or STOPPED. Updates DynamoDB and pushes agent_ready
    // or agent_stopped to the portal WebSocket — zero polling, event-driven.
    const taskStateChangeFn = new NodejsFunction(this, 'TaskStateChangeFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-task-state-change',
      description:  'ECS Task State Change → DynamoDB update + WebSocket push to portal',
      entry:        'lambdas/handlers/taskStateChangeHandler/index.ts',
      handler:      'handler',
      bundling:     nodejsBundling,
      timeout:      cdk.Duration.seconds(30),
      environment: {
        ...commonEnv,
        WS_ENDPOINT: `https://${Config.deployed.wsApiId}.execute-api.${Config.region}.amazonaws.com/prod`,
      },
    });
    taskStateChangeFn.addToRolePolicy(dynamoPolicy);
    taskStateChangeFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${Config.region}:${Config.account}:${Config.deployed.wsApiId}/*`],
    }));
    taskStateChangeFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['ecs:DescribeTasks'],
      resources: ['*'],
      conditions: { ArnLike: { 'ecs:cluster': Config.deployed.clusterArn } },
    }));

    // EventBridge rule: ECS Task State Change → RUNNING or STOPPED for lavavps-agents cluster
    const ecsTaskStateRule = new events.Rule(this, 'EcsTaskStateChangeRule', {
      ruleName:    'lavavps-ecs-task-state-change',
      description: 'Fires when an OpenClaw ECS task reaches RUNNING or STOPPED',
      eventPattern: {
        source:     ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [Config.deployed.clusterArn],
          lastStatus: ['RUNNING', 'STOPPED', 'DEPROVISIONING'],
        },
      },
    });
    ecsTaskStateRule.addTarget(
      new targets.LambdaFunction(taskStateChangeFn, { retryAttempts: 2 }),
    );

    // ── taskWatcher schedule ──────────────────────────────────────────────────
    const taskWatcherRule = new events.Rule(this, 'TaskWatcherRule', {
      ruleName:    'lavavps-task-watcher',
      description: 'Triggers taskWatcherLambda every 2 minutes',
      schedule:    events.Schedule.rate(cdk.Duration.minutes(2)),
      enabled:     true,
    });
    taskWatcherRule.addTarget(taskWatcherTarget);

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RestApiUrl', {
      value:      this.restApi.url,
      exportName: 'LavaVPS-RestApiUrl',
      description: 'REST API base URL',
    });

    new cdk.CfnOutput(this, 'RestApiId', {
      value:      this.restApi.restApiId,
      exportName: 'LavaVPS-RestApiId',
    });

    new cdk.CfnOutput(this, 'WsApiId', {
      value:      this.wsApi.ref,
      exportName: 'LavaVPS-WsApiId',
    });

    new cdk.CfnOutput(this, 'ConfigRendererArn', {
      value:      configRendererFn.functionArn,
      exportName: 'LavaVPS-ConfigRendererArn',
      description: 'configRenderer ARN - used by provisioningLambda (Phase 5)',
    });

    new cdk.CfnOutput(this, 'AuthorizerArn', {
      value:      authorizerFn.functionArn,
      exportName: 'LavaVPS-AuthorizerArn',
    });

    cdk.Tags.of(this).add('Stack', 'ControlPlane');
  }
}