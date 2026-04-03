import * as cdk  from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import * as efs  from 'aws-cdk-lib/aws-efs';
import * as kms  from 'aws-cdk-lib/aws-kms';
import * as s3   from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// StorageStack
//
// All persistent storage for LavaVPS.
//
//   EFS - agent config + workspace for every tenant/agent
//     CRITICAL: Intelligent Tiering enabled at creation - cannot be added later.
//     Inactive files (30+ days) move to IA tier: $0.025/GB vs Standard $0.30/GB.
//     Savings per tenant: Starter $1.10/mo · Pro $11/mo · Business $22/mo.
//     Access Points (one per agent, uid=1000) created at provisioning time.
//
//   S3 config-artifacts - rendered openclaw.json snapshots per agent
//     Versioned: every config change preserved for rollback (last 10 kept).
//
//   S3 chat-history - archived conversation history
//     Intelligent-Tiering storage class + Glacier after 180 days.
//
// Exports: filesystem, efsSg, configBucket, chatBucket
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageStackProps extends cdk.StackProps {
  readonly vpc:       ec2.Vpc;
  readonly cmk:       kms.Key;
  readonly fargateSg: ec2.SecurityGroup;
  readonly lambdaSg:  ec2.SecurityGroup;
}

export class StorageStack extends cdk.Stack {
  public readonly filesystem:   efs.FileSystem;
  public readonly efsSg:             ec2.SecurityGroup;
  public readonly configBucket:      s3.Bucket;
  public readonly chatBucket:        s3.Bucket;
  public readonly bootstrapperApId:  string;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // ── EFS Security Group ─────────────────────────────────────────────────
    this.efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc:               props.vpc,
      securityGroupName: 'lavavps-efs',
      description:       'LavaVPS EFS - NFS inbound from Fargate tasks and Lambda only',
      allowAllOutbound:  false,
    });
    this.efsSg.addIngressRule(
      props.fargateSg, ec2.Port.tcp(2049),
      'NFS from Fargate tasks (agent config + workspace read/write)',
    );
    this.efsSg.addIngressRule(
      props.lambdaSg, ec2.Port.tcp(2049),
      'NFS from Lambda (bootstrapperLambda writes initial openclaw.json)',
    );

    // ── EFS Filesystem ─────────────────────────────────────────────────────
    // MUST use ELASTIC throughput - auto-scales for multi-tenant bursty I/O.
    // MUST enable Intelligent Tiering NOW - cannot be added retroactively.
    this.filesystem = new efs.FileSystem(this, 'EFS', {
      fileSystemName: 'lavavps-agents',
      vpc:            props.vpc,
      vpcSubnets:     { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup:  this.efsSg,
      throughputMode: efs.ThroughputMode.ELASTIC,
      // Intelligent Tiering: inactive 30d → IA; any access → back to Standard
      // NOTE: CDK L2 uses singular props (not an array) for these lifecycle policies
      lifecyclePolicy:             efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      encrypted:     true,
      kmsKey:        props.cmk,
      // RETAIN: customer agent data must never be accidentally deleted
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── S3 - Config Artifacts ──────────────────────────────────────────────
    // Stores rendered openclaw.json for each tenant/agent.
    // configRenderer writes here; bootstrapperLambda copies to EFS.
    // Object prefix: {tenant_id}/{agent_id}/openclaw.json
    this.configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName:        `lavavps-configs-${Config.account}`,
      encryption:        s3.BucketEncryption.KMS,
      encryptionKey:     props.cmk,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:        true,
      versioned:         true,    // Every config change is preserved for rollback
      lifecycleRules: [
        {
          // Keep only 10 non-current versions per object (config history)
          noncurrentVersionExpiration: cdk.Duration.days(1),
          noncurrentVersionsToRetain: 10,
          enabled: true,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── S3 - Chat History ──────────────────────────────────────────────────
    // Archived conversation history by plan tier:
    //   Starter: 30-day retention  → Glacier
    //   Pro:     90-day retention  → Glacier
    //   Business: 365-day retention → Glacier
    // Retention is enforced by the chatHandler Lambda, not here.
    // This bucket stores the raw JSONL files.
    this.chatBucket = new s3.Bucket(this, 'ChatBucket', {
      bucketName:        `lavavps-chat-history-${Config.account}`,
      encryption:        s3.BucketEncryption.KMS,
      encryptionKey:     props.cmk,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:        true,
      intelligentTieringConfigurations: [
        {
          name: 'lavavps-chat-tiering',
          archiveAccessTierTime:        cdk.Duration.days(90),
          deepArchiveAccessTierTime:    cdk.Duration.days(180),
        },
      ],
      lifecycleRules: [
        {
          // Move to Glacier after 180 days regardless of access tier
          transitions: [
            {
              storageClass:    s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(180),
            },
          ],
          enabled: true,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── EFS Access Point for bootstrapperLambda ──────────────────────────
    // Created here (in StorageStack) to avoid cross-stack CDK dependency cycles.
    // ControlPlaneStack references this by ID via fromAccessPointId().
    const bootstrapperAp = this.filesystem.addAccessPoint('BootstrapperAP', {
      path:      '/',
      posixUser: { uid: '1000', gid: '1000' },
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
    });

    this.bootstrapperApId = bootstrapperAp.accessPointId;

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'EfsId', {
      value:      this.filesystem.fileSystemId,
      exportName: 'LavaVPS-EfsId',
      description: 'EFS Filesystem ID - used by provisioning Lambda to create Access Points',
    });

    new cdk.CfnOutput(this, 'EfsArn', {
      value:      this.filesystem.fileSystemArn,
      exportName: 'LavaVPS-EfsArn',
    });

    new cdk.CfnOutput(this, 'EfsSgId', {
      value:      this.efsSg.securityGroupId,
      exportName: 'LavaVPS-EfsSgId',
    });

    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value:      this.configBucket.bucketName,
      exportName: 'LavaVPS-ConfigBucketName',
      description: 'S3 bucket for rendered openclaw.json artifacts',
    });

    new cdk.CfnOutput(this, 'ChatBucketName', {
      value:      this.chatBucket.bucketName,
      exportName: 'LavaVPS-ChatBucketName',
    });

    new cdk.CfnOutput(this, 'BootstrapperApId', {
      value:      bootstrapperAp.accessPointId,
      exportName: 'LavaVPS-BootstrapperApId',
      description: 'EFS Access Point ID for bootstrapperLambda',
    });

    new cdk.CfnOutput(this, 'EfsIntelligentTieringNote', {
      value:      'CONFIRMED: EFS Intelligent Tiering active. Files inactive 30+ days move to IA ($0.025/GB vs $0.30/GB Standard). Cannot be changed retroactively.',
      description: 'EFS IT confirmation - do not modify lifecycle policies',
    });

    cdk.Tags.of(this).add('Stack', 'Storage');
  }
}
