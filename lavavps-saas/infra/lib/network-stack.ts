import * as cdk   from 'aws-cdk-lib';
import * as ec2   from 'aws-cdk-lib/aws-ec2';
import * as logs  from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// NetworkStack
//
// Deploys the complete VPC topology for LavaVPS:
//   - VPC 10.100.0.0/16 across 2 AZs
//   - Public subnets  → ALB + NAT Gateway (one fixed egress IP)
//   - Private subnets → ECS Fargate tasks, Ollama service, Lambda functions
//   - VPC Endpoints   → S3, DynamoDB (gateway); Secrets Manager, ECR, CW Logs (interface)
//   - Security Groups → ALB, Fargate, Ollama, Lambda (least-privilege)
//   - VPC Flow Logs   → CloudWatch Logs
//
// Exports: vpc, albSg, fargateSg, ollamaSg, lambdaSg
// ─────────────────────────────────────────────────────────────────────────────

export interface NetworkStackProps extends cdk.StackProps {}

export class NetworkStack extends cdk.Stack {
  // ── Public exports consumed by downstream stacks ──────────────────────────
  public readonly vpc:        ec2.Vpc;
  public readonly albSg:      ec2.SecurityGroup;
  public readonly fargateSg:  ec2.SecurityGroup;
  public readonly ollamaSg:   ec2.SecurityGroup;
  public readonly lambdaSg:   ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: NetworkStackProps) {
    super(scope, id, props);

    // ── VPC Flow Logs log group ───────────────────────────────────────────
    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogs', {
      logGroupName:  `/lavavps/vpc/flow-logs`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── VPC ───────────────────────────────────────────────────────────────
    // CDK allocates subnets automatically within 10.100.0.0/16.
    // Public subnets get the first /24 blocks; private subnets get the next.
    // Exact CIDRs are in CloudFormation outputs after `cdk synth`.
    this.vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses:   ec2.IpAddresses.cidr(Config.vpcCidr),
      maxAzs:        2,
      natGateways:   1, // Single NAT GW → single fixed Elastic IP for channel allowlisting
      subnetConfiguration: [
        {
          name:          'Public',
          subnetType:    ec2.SubnetType.PUBLIC,
          cidrMask:      24,
          mapPublicIpOnLaunch: false,
        },
        {
          name:          'Private',
          subnetType:    ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask:      24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport:   true,
      flowLogs: {
        'FlowLog': {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    // ── VPC Endpoints — Gateway (free, no hourly charge) ──────────────────
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // ── VPC Endpoints — Interface (small hourly cost; saves NAT + latency) ─
    const privateSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcsEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.ECS,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcsAgentEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcsTelemetryEndpoint', {
      service:          ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      subnets:          privateSubnets,
      privateDnsEnabled: true,
    });

    // ── Security Groups ───────────────────────────────────────────────────

    // ── ALB Security Group ────────────────────────────────────────────────
    // Accepts HTTPS from internet. Sends to Fargate tasks on OpenClaw port.
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc:              this.vpc,
      securityGroupName: 'lavavps-alb',
      description:      'LavaVPS external ALB — inbound HTTPS from internet',
      allowAllOutbound: false,
    });
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet (IPv4)');
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS from internet (IPv6)');
    // ALB egress: forward to OpenClaw containers
    this.albSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(Config.openclawPort),
      `Forward to OpenClaw port ${Config.openclawPort}`);
    // ALB health checks (/healthz and /readyz)
    this.albSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(Config.openclawPort),
      'ALB health checks to OpenClaw /healthz /readyz');

    // ── Fargate Security Group ────────────────────────────────────────────
    // Accepts OpenClaw port from ALB only.
    // Egress: HTTPS to internet (LLM provider APIs, channel webhooks via NAT).
    // Egress: Ollama port within VPC (heartbeat to internal Ollama service).
    this.fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc:              this.vpc,
      securityGroupName: 'lavavps-fargate',
      description:      'LavaVPS Fargate tasks — OpenClaw agent runtime',
      allowAllOutbound: false,
    });
    this.fargateSg.addIngressRule(
      this.albSg, ec2.Port.tcp(Config.openclawPort),
      'OpenClaw gateway from ALB');
    this.fargateSg.addEgressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443),
      'HTTPS to LLM provider APIs and channel webhooks via NAT');
    // Ollama heartbeat (to internal Ollama ALB within VPC)
    this.fargateSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(Config.ollamaPort),
      'Ollama heartbeat to internal service via VPC');
    // EFS NFS (for config/workspace mounts)
    this.fargateSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(2049),
      'EFS NFS mount');
    // DNS resolution
    this.fargateSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.udp(53), 'DNS');
    this.fargateSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(53), 'DNS TCP');

    // ── Ollama Security Group ─────────────────────────────────────────────
    // Accepts Ollama API port from Fargate tasks only.
    // Egress HTTPS for potential future model updates (currently model is baked in).
    this.ollamaSg = new ec2.SecurityGroup(this, 'OllamaSg', {
      vpc:              this.vpc,
      securityGroupName: 'lavavps-ollama',
      description:      'LavaVPS shared Ollama heartbeat service',
      allowAllOutbound: false,
    });
    this.ollamaSg.addIngressRule(
      this.fargateSg, ec2.Port.tcp(Config.ollamaPort),
      'Ollama API from Fargate tasks');
    this.ollamaSg.addEgressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443),
      'HTTPS egress for model layer updates');
    this.ollamaSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.udp(53), 'DNS');

    // ── Lambda Security Group ─────────────────────────────────────────────
    // VPC-bound Lambda functions (configRenderer, bootstrapperLambda, taskWatcher).
    // Egress HTTPS to VPC endpoints + internet via NAT for Stripe/provider APIs.
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc:              this.vpc,
      securityGroupName: 'lavavps-lambda',
      description:      'LavaVPS Lambda functions running in VPC',
      allowAllOutbound: false,
    });
    this.lambdaSg.addEgressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443),
      'HTTPS to VPC endpoints and external APIs via NAT');
    this.lambdaSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(2049),
      'EFS NFS for bootstrapperLambda to write config');
    this.lambdaSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.udp(53), 'DNS');
    this.lambdaSg.addEgressRule(
      ec2.Peer.ipv4(Config.vpcCidr), ec2.Port.tcp(53), 'DNS TCP');

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', {
      value:      this.vpc.vpcId,
      exportName: 'LavaVPS-VpcId',
      description: 'VPC ID for cross-stack references',
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value:      Config.vpcCidr,
      description: 'VPC CIDR block — all internal traffic is within this range',
    });

    this.vpc.publicSubnets.forEach((subnet: ec2.ISubnet, i: number) => {
      new cdk.CfnOutput(this, `PublicSubnet${i + 1}Id`, {
        value:      subnet.subnetId,
        exportName: `LavaVPS-PublicSubnet${i + 1}`,
        description: `Public subnet ${i + 1} — ALB node and NAT Gateway`,
      });
      new cdk.CfnOutput(this, `PublicSubnet${i + 1}Cidr`, {
        value:       (subnet as ec2.Subnet).ipv4CidrBlock,
        description: `Public subnet ${i + 1} CIDR — add to OpenClaw trustedProxies`,
      });
    });

    this.vpc.privateSubnets.forEach((subnet: ec2.ISubnet, i: number) => {
      new cdk.CfnOutput(this, `PrivateSubnet${i + 1}Id`, {
        value:      subnet.subnetId,
        exportName: `LavaVPS-PrivateSubnet${i + 1}`,
        description: `Private subnet ${i + 1} — ECS tasks and Lambda functions`,
      });
    });

    new cdk.CfnOutput(this, 'AlbSgId', {
      value:      this.albSg.securityGroupId,
      exportName: 'LavaVPS-AlbSgId',
    });

    new cdk.CfnOutput(this, 'FargateSgId', {
      value:      this.fargateSg.securityGroupId,
      exportName: 'LavaVPS-FargateSgId',
    });

    new cdk.CfnOutput(this, 'OllamaSgId', {
      value:      this.ollamaSg.securityGroupId,
      exportName: 'LavaVPS-OllamaSgId',
    });

    new cdk.CfnOutput(this, 'LambdaSgId', {
      value:      this.lambdaSg.securityGroupId,
      exportName: 'LavaVPS-LambdaSgId',
    });

    new cdk.CfnOutput(this, 'NatGatewayNote', {
      value:      'Check EC2 → Elastic IPs in console for the fixed NAT Gateway IP. Add this to Discord/Telegram/WhatsApp API allowlists.',
      description: 'NAT Gateway fixed egress IP — needed for channel API allowlisting',
    });

    // Tags
    cdk.Tags.of(this).add('Stack', 'Network');
  }
}
