import * as cdk     from 'aws-cdk-lib';
import * as ec2     from 'aws-cdk-lib/aws-ec2';
import * as efs     from 'aws-cdk-lib/aws-efs';
import * as iam     from 'aws-cdk-lib/aws-iam';
import * as kms     from 'aws-cdk-lib/aws-kms';
import * as lambda  from 'aws-cdk-lib/aws-lambda';
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
      actions:   ['secretsmanager:CreateSecret', 'secretsmanager:GetSecretValue',
                  'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret'],
      resources: [`arn:aws:secretsmanager:${Config.region}:${Config.account}:secret:/openclaw/*`],
    });

    const ecsPolicy = new iam.PolicyStatement({
      actions:   ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks',
                  'ecs:DescribeServices', 'ecs:UpdateService'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'ecs:cluster': Config.deployed.clusterArn,
        },
      },
    });

    const iamPassRolePolicy = new iam.PolicyStatement({
      actions:   ['iam:PassRole'],
      resources: [`arn:aws:iam::${Config.account}:role/lavavps-*`],
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
    const configRendererFn = new lambda.Function(this, 'ConfigRendererFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-config-renderer',
      description:  'Renders locked openclaw.json from tenant DynamoDB values, validates, writes to S3/EFS',
      code:         lambda.Code.fromAsset('lambdas/handlers/configRenderer'),
      handler:      'index.handler',
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
    const configHandlerFn = new lambda.Function(this, 'ConfigHandlerFn', {
      ...baseLambdaProps as lambda.FunctionProps,
      functionName: 'lavavps-config-handler',
      description:  'Allowlist validates config fields, writes to DynamoDB, invokes configRenderer',
      code:         lambda.Code.fromAsset('lambdas/handlers/configHandler'),
      handler:      'index.handler',
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
        allowOrigins: ['https://lavavps.ai', 'https://www.lavavps.ai', 'http://localhost:3000'],
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

    // ── WebSocket API (API Gateway v2) ────────────────────────────────────
    // Phase 4 Part B: full wsHandler Lambda wired to $connect/$default/$disconnect
    // WebSocket API created here, routes added in next session
    this.wsApi = new apigwv2.CfnApi(this, 'WsApi', {
      name:                       'lavavps-ws',
      protocolType:               'WEBSOCKET',
      routeSelectionExpression:   '$request.body.action',
      description:                'LavaVPS WebSocket API for real-time agent chat',
    });

    // ── EventBridge: Task Watcher schedule ───────────────────────────────
    // taskWatcherLambda runs every 2 minutes to check idle timeouts and crash loops
    // Built in Phase 4 Part B — placeholder rule created now
    new events.Rule(this, 'TaskWatcherRule', {
      ruleName:    'lavavps-task-watcher',
      description: 'Triggers taskWatcherLambda every 2 minutes',
      schedule:    events.Schedule.rate(cdk.Duration.minutes(2)),
      // NOTE: Scheduled rules always use the default event bus - do not specify eventBus
      enabled:     true,
    });

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
