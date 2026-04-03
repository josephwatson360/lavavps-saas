import * as cdk         from 'aws-cdk-lib';
import * as ec2         from 'aws-cdk-lib/aws-ec2';
import * as kms         from 'aws-cdk-lib/aws-kms';
import * as iam         from 'aws-cdk-lib/aws-iam';
import * as logs        from 'aws-cdk-lib/aws-logs';
import * as s3          from 'aws-cdk-lib/aws-s3';
import * as cloudtrail  from 'aws-cdk-lib/aws-cloudtrail';
import * as wafv2       from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// SecurityStack
//
// Deploys defence-in-depth controls. Must be deployed before any other stack
// that needs encryption or audit logging.
//
//   - KMS CMK: single key encrypts EFS, DynamoDB, S3, Secrets Manager, CW Logs
//   - CloudTrail: multi-region, tamper-evident, S3 + CloudWatch Logs
//   - WAF WebACL: OWASP Top 10, IP reputation, rate limiting (1000 req/5min)
//   - Fargate Execution Role: ECR pull + CloudWatch Logs write
//
// Exports: cmk, wafWebAclArn
// Note: fargateExecutionRole is in RuntimeStack to avoid cross-stack ECR dependency cycle
// ─────────────────────────────────────────────────────────────────────────────

export interface SecurityStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class SecurityStack extends cdk.Stack {
  public readonly cmk:                  kms.Key;
  public readonly wafWebAclArn:         string;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    // ── KMS Customer Managed Key ──────────────────────────────────────────
    // Single CMK used by all LavaVPS services. Annual rotation enabled.
    // RETAIN policy - this key must NEVER be accidentally deleted.
    this.cmk = new kms.Key(this, 'CMK', {
      description:    'LavaVPS CMK - encrypts EFS, DynamoDB, S3, Secrets Manager, CloudWatch Logs',
      enableKeyRotation: true,
      alias:          'alias/lavavps-cmk',
      removalPolicy:  cdk.RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          // Account root must retain full access (CDK requirement + emergency access)
          new iam.PolicyStatement({
            sid:        'AllowAccountRoot',
            principals: [new iam.AccountRootPrincipal()],
            actions:    ['kms:*'],
            resources:  ['*'],
          }),
          // CloudWatch Logs needs to encrypt log data
          new iam.PolicyStatement({
            sid:        'AllowCloudWatchLogs',
            principals: [
              new iam.ServicePrincipal(`logs.${Config.region}.amazonaws.com`),
            ],
            actions: [
              'kms:Encrypt*',
              'kms:Decrypt*',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:Describe*',
            ],
            resources:  ['*'],
            conditions: {
              ArnLike: {
                'kms:EncryptionContext:aws:logs:arn':
                  `arn:aws:logs:${Config.region}:${Config.account}:*`,
              },
            },
          }),
          // EFS needs to use the key
          new iam.PolicyStatement({
            sid:        'AllowEFS',
            principals: [new iam.ServicePrincipal('elasticfilesystem.amazonaws.com')],
            actions: [
              'kms:Encrypt*',
              'kms:Decrypt*',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:CreateGrant',
              'kms:Describe*',
            ],
            resources: ['*'],
          }),
        ],
      }),
    });

    new cdk.CfnOutput(this, 'CmkArn', {
      value:      this.cmk.keyArn,
      exportName: 'LavaVPS-CmkArn',
      description: 'KMS CMK ARN - used to encrypt all LavaVPS data at rest',
    });

    new cdk.CfnOutput(this, 'CmkAlias', {
      value:      'alias/lavavps-cmk',
      description: 'KMS CMK alias - use in CDK encryption references',
    });

    // ── CloudTrail Bucket ─────────────────────────────────────────────────
    // CloudTrail requires S3 managed encryption (not CMK) on the trail bucket itself.
    // The bucket uses SSE-S3; CloudWatch Logs uses CMK.
    const trailBucket = new s3.Bucket(this, 'CloudTrailBucket', {
      bucketName:         `lavavps-cloudtrail-${Config.account}`,
      encryption:         s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess:  s3.BlockPublicAccess.BLOCK_ALL,
      versioned:          true,
      enforceSSL:         true,
      lifecycleRules: [{
        enabled: true,
        transitions: [{
          storageClass:    s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(90),
        }],
        expiration: cdk.Duration.days(2555), // ~7 years retention
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── CloudTrail Log Group ──────────────────────────────────────────────
    const trailLogGroup = new logs.LogGroup(this, 'CloudTrailLogGroup', {
      logGroupName:  '/lavavps/cloudtrail',
      retention:     logs.RetentionDays.ONE_YEAR,
      encryptionKey: this.cmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── CloudTrail ────────────────────────────────────────────────────────
    new cloudtrail.Trail(this, 'CloudTrail', {
      trailName:                'lavavps-trail',
      bucket:                   trailBucket,
      cloudWatchLogGroup:       trailLogGroup,
      cloudWatchLogsRetention:  logs.RetentionDays.ONE_YEAR,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail:       true,  // Catches IAM, STS, and other global service calls
      enableFileValidation:     true,  // SHA-256 hash chain - tamper detection
      sendToCloudWatchLogs:     true,
    });

    // ── WAF WebACL ────────────────────────────────────────────────────────
    // REGIONAL scope for ALB attachment.
    // Rules: AWS Managed Core (OWASP Top 10), IP Reputation, Rate Limit, Bad Inputs.
    const wafWebAcl = new wafv2.CfnWebACL(this, 'WafWebAcl', {
      name:  'lavavps-waf',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled:   true,
        cloudWatchMetricsEnabled: true,
        metricName:               'lavavps-waf',
      },
      rules: [
        // Rule 1: AWS Managed Core Rule Set (OWASP Top 10)
        {
          name:           'CoreRuleSet',
          priority:       1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name:       'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled:   true,
            cloudWatchMetricsEnabled: true,
            metricName:               'CoreRuleSet',
          },
        },
        // Rule 2: AWS IP Reputation List (known bad IPs, bot IPs)
        {
          name:           'IpReputationList',
          priority:       2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name:       'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled:   true,
            cloudWatchMetricsEnabled: true,
            metricName:               'IpReputationList',
          },
        },
        // Rule 3: Rate limiting - 1000 requests per 5 minutes per IP
        // Adjust this if legitimate customers hit the limit.
        {
          name:     'RateLimit',
          priority: 3,
          action:   { block: {} },
          statement: {
            rateBasedStatement: {
              limit:            1000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled:   true,
            cloudWatchMetricsEnabled: true,
            metricName:               'RateLimit',
          },
        },
        // Rule 4: Known Bad Inputs (Log4j, malformed requests, etc.)
        {
          name:           'KnownBadInputs',
          priority:       4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name:       'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled:   true,
            cloudWatchMetricsEnabled: true,
            metricName:               'KnownBadInputs',
          },
        },
      ],
    });

    this.wafWebAclArn = wafWebAcl.attrArn;

    new cdk.CfnOutput(this, 'WafWebAclArn', {
      value:      this.wafWebAclArn,
      exportName: 'LavaVPS-WafWebAclArn',
      description: 'WAF WebACL ARN - attach to ALB and CloudFront distribution',
    });

    // Tags
    cdk.Tags.of(this).add('Stack', 'Security');
  }
}
