import * as cdk     from 'aws-cdk-lib';
import * as ec2     from 'aws-cdk-lib/aws-ec2';
import * as ecr     from 'aws-cdk-lib/aws-ecr';
import * as ecs     from 'aws-cdk-lib/aws-ecs';
import * as efs     from 'aws-cdk-lib/aws-efs';
import * as iam     from 'aws-cdk-lib/aws-iam';
import * as kms     from 'aws-cdk-lib/aws-kms';
import * as logs    from 'aws-cdk-lib/aws-logs';
import * as elbv2   from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm     from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2   from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeStack
//
// All shared runtime infrastructure. Tenant ECS tasks are launched by the
// provisioningLambda at tenant signup time - not defined here.
//
//   ECR Repos:        openclaw (immutable tags), ollama (immutable tags)
//   ECS Cluster:      Container Insights enabled
//   Ollama Service:   2-task internal service, internal ALB, llama3.2:1b
//   External ALB:     WSS + HTTPS, Cognito auth action, WAF, sticky sessions
//   Task Definitions: Starter / Pro / Business (OpenClaw per plan)
//
// Exports: cluster, openclawRepo, ollamaRepo, externalAlb, ollamaAlbDnsName,
//          taskDefs, ollamaServiceUrl
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeStackProps extends cdk.StackProps {
  readonly vpc:                ec2.Vpc;
  readonly cmk:                kms.Key;
  readonly albSg:              ec2.SecurityGroup;
  readonly fargateSg:          ec2.SecurityGroup;
  readonly ollamaSg:           ec2.SecurityGroup;
  readonly efsSg:              ec2.SecurityGroup;
  readonly filesystem:         efs.FileSystem;
  readonly userPool:           cognito.UserPool;
  readonly userPoolClient:     cognito.UserPoolClient;
  readonly wafWebAclArn:       string;
}

export class RuntimeStack extends cdk.Stack {
  public readonly cluster:          ecs.Cluster;
  public readonly openclawRepo:     ecr.Repository;
  public readonly ollamaRepo:       ecr.Repository;
  public readonly externalAlb:      elbv2.ApplicationLoadBalancer;
  public readonly ollamaAlbDnsName: string;
  public readonly taskDefs: {
    starter:  ecs.FargateTaskDefinition;
    pro:      ecs.FargateTaskDefinition;
    business: ecs.FargateTaskDefinition;
  };

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    // ── ECR Repository: OpenClaw ───────────────────────────────────────────
    // Immutable tags: prevents overwriting a deployed version accidentally.
    // Lifecycle: keep last 5 tagged images; expire untagged after 7 days.
    this.openclawRepo = new ecr.Repository(this, 'OpenClawRepo', {
      repositoryName:     'lavavps-openclaw',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush:    true,
      encryptionKey:      props.cmk,
      lifecycleRules: [
        {
          rulePriority: 1,
          description:  'Keep last 5 tagged releases',
          tagStatus:    ecr.TagStatus.TAGGED,
          tagPrefixList: ['20'],   // matches 2026.x.x version tags
          maxImageCount: 5,
        },
        {
          rulePriority: 2,
          description:  'Expire untagged images after 7 days',
          tagStatus:    ecr.TagStatus.UNTAGGED,
          maxImageAge:  cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── ECR Repository: Ollama ─────────────────────────────────────────────
    this.ollamaRepo = new ecr.Repository(this, 'OllamaRepo', {
      repositoryName:     'lavavps-ollama',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush:    true,
      encryptionKey:      props.cmk,
      lifecycleRules: [
        {
          rulePriority: 1,
          description:  'Keep last 3 tagged releases',
          tagStatus:    ecr.TagStatus.TAGGED,
          tagPrefixList: ['0'],
          maxImageCount: 3,
        },
        {
          rulePriority: 2,
          description:  'Expire untagged images after 7 days',
          tagStatus:    ecr.TagStatus.UNTAGGED,
          maxImageAge:  cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Fargate Execution Role (lives here to avoid cross-stack ECR cycle) ───
    // Created in RuntimeStack so CDK's automatic grantPull (triggered by
    // ContainerImage.fromEcrRepository) stays within this stack.
    // The KMS key ARN is the only cross-stack reference needed here.
    const fargateExecutionRole = new iam.Role(this, 'FargateExecutionRole', {
      roleName:    'lavavps-fargate-execution-role',
      description: 'ECS task execution - ECR image pull and CloudWatch Logs',
      assumedBy:   new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    fargateExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CloudWatchLogsWrite',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${Config.region}:${Config.account}:log-group:/openclaw/*`],
    }));

    fargateExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SecretsManagerRead',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${Config.region}:${Config.account}:secret:/openclaw/*`],
    }));

    // KMS decrypt - this is the only cross-stack reference in this role
    fargateExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'KmsDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.cmk.keyArn],
    }));

    new cdk.CfnOutput(this, 'FargateExecutionRoleArn', {
      value:      fargateExecutionRole.roleArn,
      exportName: 'LavaVPS-FargateExecutionRoleArn',
      description: 'ECS execution role - ECR pull + CloudWatch Logs',
    });

    // ── ECS Cluster ────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName:         'lavavps-agents',
      vpc:                 props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    // ── CloudWatch Log Groups for OpenClaw tasks ───────────────────────────
    const logGroup = new logs.LogGroup(this, 'OpenClawLogGroup', {
      logGroupName:  '/openclaw/agents',
      retention:     logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.cmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ollamaLogGroup = new logs.LogGroup(this, 'OllamaLogGroup', {
      logGroupName:  '/openclaw/ollama',
      retention:     logs.RetentionDays.ONE_WEEK,
      encryptionKey: props.cmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── EFS Volume config (shared across all task definitions) ────────────
    // Each tenant gets their own EFS Access Point (created at provisioning).
    // The volume config here just references the shared filesystem.
    const efsVolumeConfig: ecs.Volume = {
      name: 'openclaw-data',
      efsVolumeConfiguration: {
        fileSystemId:      props.filesystem.fileSystemId,
        transitEncryption: 'ENABLED',
        // Access Point ID is set per-task at provisioning time via task override
        // authorizationConfig is omitted here; set in per-tenant task definition
      },
    };

    // ── Helper: create OpenClaw task definition per plan ──────────────────
    const makeOpenClawTaskDef = (
      planCode:      string,
      cpu:           number,
      mem:           number,
      ollamaAlbDns:  string,
    ): ecs.FargateTaskDefinition => {

      // Per-tenant task role is created at provisioning time.
      // This execution role is the shared platform role for ECR + CloudWatch.
      const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef${planCode}`, {
        family:           `lavavps-openclaw-${planCode}`,
        cpu,
        memoryLimitMiB:   mem,
        executionRole:    fargateExecutionRole,
        // taskRole is set per-tenant at ECS RunTask time (not here)
        volumes:          [efsVolumeConfig],
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture:       ecs.CpuArchitecture.X86_64,
        },
      });

      // OpenClaw container
      const container = taskDef.addContainer('openclaw', {
        // Image reference: actual image resolved at ECS RunTask time
        // using the ECR URI from openclawRepo + version tag from Config
        image: ecs.ContainerImage.fromEcrRepository(
          this.openclawRepo,
          Config.openclawVersion,
        ),
        essential:   true,
        portMappings: [{
          containerPort: Config.openclawPort,
          protocol:      ecs.Protocol.TCP,
          name:          'openclaw-http',
        }],
        environment: {
          NODE_ENV:               'production',
          OPENCLAW_GATEWAY_BIND:  'lan',
          OPENCLAW_GATEWAY_PORT:  String(Config.openclawPort),
          OLLAMA_HOST: `http://${ollamaAlbDns}:${Config.ollamaPort}`,
        },
        // OPENCLAW_GATEWAY_TOKEN is NOT set here.
        // Auth mode = trusted-proxy; ALB Cognito auth is the gate.
        // No gateway token is needed or used.
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `openclaw-${planCode}`,
          logGroup,
        }),
        healthCheck: {
          command:     ['CMD-SHELL', `curl -fsS http://localhost:${Config.openclawPort}/healthz || exit 1`],
          interval:    cdk.Duration.seconds(30),
          timeout:     cdk.Duration.seconds(5),
          retries:     3,
          startPeriod: cdk.Duration.seconds(60),
        },
        // Run as UID 1000 (node user) - matches EFS Access Point POSIX config
        user: '1000',
      });

      // Mount EFS volume - Access Point ID set at ECS RunTask time per tenant
      container.addMountPoints({
        containerPath: '/home/node/.openclaw',
        sourceVolume:  'openclaw-data',
        readOnly:      false,
      });

      return taskDef;
    };

    // ── OpenClaw Task Definitions (one per plan tier) ──────────────────────
    // Created AFTER ollamaAlb so we can pass the real ALB DNS as OLLAMA_HOST
    // (populated below after Internal ALB creation)

    // ── Ollama Task Definition ─────────────────────────────────────────────
    const ollamaTaskDef = new ecs.FargateTaskDefinition(this, 'OllamaTaskDef', {
      family:         'lavavps-ollama',
      cpu:            Config.ollama.vCpu,
      memoryLimitMiB: Config.ollama.memoryMiB,
      executionRole:  fargateExecutionRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture:       ecs.CpuArchitecture.X86_64,
      },
    });

    ollamaTaskDef.addContainer('ollama', {
      image: ecs.ContainerImage.fromEcrRepository(
        this.ollamaRepo,
        'latest-llama3',  // custom tag for our pre-baked llama3.2:1b image
      ),
      essential: true,
      portMappings: [{
        containerPort: Config.ollamaPort,
        protocol:      ecs.Protocol.TCP,
        name:          'ollama-api',
      }],
      environment: {
        OLLAMA_HOST: '0.0.0.0',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ollama',
        logGroup:     ollamaLogGroup,
      }),
      healthCheck: {
        command:     ['CMD-SHELL', `curl -fsS http://localhost:${Config.ollamaPort}/api/tags || exit 1`],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(10),
        retries:     3,
        startPeriod: cdk.Duration.seconds(120), // model loading takes time
      },
    });

    // ── Internal ALB for Ollama ────────────────────────────────────────────
    // Scheme = internal: never reachable from internet.
    // All OpenClaw Fargate tasks resolve Ollama via this ALB.
    const ollamaAlb = new elbv2.ApplicationLoadBalancer(this, 'OllamaAlb', {
      loadBalancerName: 'lavavps-ollama-internal',
      vpc:              props.vpc,
      internetFacing:   false,
      securityGroup:    props.ollamaSg,
      vpcSubnets:       { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const ollamaTg = new elbv2.ApplicationTargetGroup(this, 'OllamaTg', {
      targetGroupName: 'lavavps-ollama',
      vpc:             props.vpc,
      port:            Config.ollamaPort,
      protocol:        elbv2.ApplicationProtocol.HTTP,
      targetType:      elbv2.TargetType.IP,
      healthCheck: {
        path:                '/api/tags',
        healthyHttpCodes:    '200',
        interval:            cdk.Duration.seconds(30),
        timeout:             cdk.Duration.seconds(10),
        healthyThresholdCount:   2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    ollamaAlb.addListener('OllamaListener', {
      port:            Config.ollamaPort,
      protocol:        elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [ollamaTg],
    });

    this.ollamaAlbDnsName = ollamaAlb.loadBalancerDnsName;

    // ── Ollama ECS Service ─────────────────────────────────────────────────
    // Always-on service: min 2 tasks (one per AZ), auto-scale to 8.
    // Rolling update: never drop below 1 healthy task during deploy.
    const ollamaService = new ecs.FargateService(this, 'OllamaService', {
      serviceName:         'lavavps-ollama',
      cluster:             this.cluster,
      taskDefinition:      ollamaTaskDef,
      // Start at 0 - scale up to Config.ollama.minCount after pushing the Ollama image.
      // Avoids deployment circuit breaker triggering before image exists in ECR.
      // After image push run: aws ecs update-service --cluster lavavps-agents
      //   --service lavavps-ollama --desired-count 2
      desiredCount:        0,
      securityGroups:      [props.ollamaSg],
      vpcSubnets:          { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp:      false,
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE', weight: 1, base: Config.ollama.minCount },
      ],
      deploymentController: { type: ecs.DeploymentControllerType.ECS },
      minHealthyPercent:   50,
      maxHealthyPercent:   200,
      circuitBreaker:      { rollback: true },
      enableECSManagedTags: true,
      // No Service Connect - OpenClaw tasks use Ollama ALB DNS directly (see OLLAMA_HOST env var below)
    });

    ollamaService.attachToApplicationTargetGroup(ollamaTg);

    // Auto-scaling for Ollama
    const ollamaScaling = ollamaService.autoScaleTaskCount({
      minCapacity: Config.ollama.minCount,
      maxCapacity: Config.ollama.maxCount,
    });
    ollamaScaling.scaleOnCpuUtilization('OllamaCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown:  cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // ── OpenClaw Task Definitions (created after Ollama ALB exists) ─────────
    this.taskDefs = {
      starter:  makeOpenClawTaskDef('starter',  Config.plans.starter.vCpu,  Config.plans.starter.memoryMiB,  ollamaAlb.loadBalancerDnsName),
      pro:      makeOpenClawTaskDef('pro',       Config.plans.pro.vCpu,      Config.plans.pro.memoryMiB,      ollamaAlb.loadBalancerDnsName),
      business: makeOpenClawTaskDef('business',  Config.plans.business.vCpu, Config.plans.business.memoryMiB, ollamaAlb.loadBalancerDnsName),
    };

    // ── External ALB ───────────────────────────────────────────────────────
    // Handles all customer-facing traffic: HTTPS + WSS.
    // Cognito auth action: validates JWT before any request reaches OpenClaw.
    // WAF attached: OWASP rules + rate limiting.
    // Sticky sessions: required for WebSocket connection affinity.
    this.externalAlb = new elbv2.ApplicationLoadBalancer(this, 'ExternalAlb', {
      loadBalancerName: 'lavavps-external',
      vpc:              props.vpc,
      internetFacing:   true,
      securityGroup:    props.albSg,
      vpcSubnets:       { subnetType: ec2.SubnetType.PUBLIC },
      // ALB idle timeout must exceed Business plan idle timeout (60 min)
      // to prevent mid-conversation WebSocket disconnects
      idleTimeout:      cdk.Duration.seconds(3610),
    });

    // Attach WAF to external ALB
    new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: this.externalAlb.loadBalancerArn,
      webAclArn:   props.wafWebAclArn,
    });

    // HTTP -> HTTPS redirect (port 80)
    this.externalAlb.addRedirect({
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      sourcePort:     80,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      targetPort:     443,
    });

    // ACM certificate (wildcard *.lavavps.ai - ISSUED)
    const cert = acm.Certificate.fromCertificateArn(
      this, 'Cert',
      Config.deployed.certArnAi,
    );

    // HTTPS listener with Cognito authentication action.
    // Every request must have a valid Cognito JWT before reaching OpenClaw.
    // This is the outer auth gate. OpenClaw trusted-proxy mode then reads
    // the x-amzn-oidc-identity header the ALB injects after auth.
    const httpsListener = this.externalAlb.addListener('HttpsListener', {
      port:         443,
      protocol:     elbv2.ApplicationProtocol.HTTPS,
      certificates: [cert],
      sslPolicy:    elbv2.SslPolicy.RECOMMENDED_TLS,
      // Default action: authenticate via Cognito, then return 404.
      // Per-tenant listener rules (added at provisioning time) forward
      // authenticated requests to the correct tenant target group.
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Agent not found',
      }),
    });

    // Cognito authentication action applied to the listener level.
    // This creates the auth flow: ALB -> Cognito hosted UI -> redirect back.
    // After auth, ALB injects x-amzn-oidc-identity and forwards to target.
    //
    // NOTE: Per-tenant listener rules are added by provisioningLambda at
    // runtime using the ELBv2 API. Each rule:
    //   - Matches path prefix /agent/{tenant_id}/
    //   - Has Cognito authenticate action (same user pool)
    //   - Forwards to tenant-specific target group (single Fargate task IP)
    //   - Has sticky session enabled (duration-based, 3600s)
    new cdk.CfnOutput(this, 'HttpsListenerArn', {
      value:      httpsListener.listenerArn,
      exportName: 'LavaVPS-HttpsListenerArn',
      description: 'External ALB HTTPS listener ARN - used by provisioningLambda to add per-tenant rules',
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ClusterArn', {
      value:      this.cluster.clusterArn,
      exportName: 'LavaVPS-ClusterArn',
      description: 'ECS cluster ARN',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value:      this.cluster.clusterName,
      exportName: 'LavaVPS-ClusterName',
    });

    new cdk.CfnOutput(this, 'OpenClawRepoUri', {
      value:      this.openclawRepo.repositoryUri,
      exportName: 'LavaVPS-OpenClawRepoUri',
      description: 'ECR URI for OpenClaw image - use in push-openclaw.sh',
    });

    new cdk.CfnOutput(this, 'OllamaRepoUri', {
      value:      this.ollamaRepo.repositoryUri,
      exportName: 'LavaVPS-OllamaRepoUri',
      description: 'ECR URI for Ollama image',
    });

    new cdk.CfnOutput(this, 'ExternalAlbDns', {
      value:      this.externalAlb.loadBalancerDnsName,
      exportName: 'LavaVPS-ExternalAlbDns',
      description: 'External ALB DNS - create Route 53 ALIAS record pointing lavavps.ai here',
    });

    new cdk.CfnOutput(this, 'OllamaAlbDns', {
      value:      ollamaAlb.loadBalancerDnsName,
      exportName: 'LavaVPS-OllamaAlbDns',
      description: 'Internal Ollama ALB DNS (only reachable within VPC)',
    });

    new cdk.CfnOutput(this, 'StarterTaskDefArn', {
      value:      this.taskDefs.starter.taskDefinitionArn,
      exportName: 'LavaVPS-StarterTaskDefArn',
    });

    new cdk.CfnOutput(this, 'ProTaskDefArn', {
      value:      this.taskDefs.pro.taskDefinitionArn,
      exportName: 'LavaVPS-ProTaskDefArn',
    });

    new cdk.CfnOutput(this, 'BusinessTaskDefArn', {
      value:      this.taskDefs.business.taskDefinitionArn,
      exportName: 'LavaVPS-BusinessTaskDefArn',
    });

    new cdk.CfnOutput(this, 'OllamaHostNote', {
      value:      `OpenClaw tasks reach Ollama via http://${ollamaAlb.loadBalancerDnsName}:${Config.ollamaPort} (internal ALB DNS)`,
      description: 'Ollama internal ALB DNS - set as OLLAMA_HOST in OpenClaw task definitions',
    });

    new cdk.CfnOutput(this, 'NextSteps', {
      value:      '1) Push OpenClaw image: ./scripts/push-openclaw.sh  2) Push Ollama image: ./scripts/push-ollama.sh  3) Verify Ollama service healthy: aws ecs describe-services --cluster lavavps-agents --services lavavps-ollama',
      description: 'Post-deploy steps before Phase 4',
    });

    cdk.Tags.of(this).add('Stack', 'Runtime');
  }
}
