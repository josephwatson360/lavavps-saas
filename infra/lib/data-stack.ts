import * as cdk        from 'aws-cdk-lib';
import * as dynamodb   from 'aws-cdk-lib/aws-dynamodb';
import * as kms        from 'aws-cdk-lib/aws-kms';
import * as events     from 'aws-cdk-lib/aws-events';
import * as ssm        from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Config } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// DataStack
//
// All control-plane data storage.
//
//   DynamoDB - single-table design
//     PK / SK pattern: entity type prefix + ID
//
//     Entity patterns:
//       Tenant:       PK=TENANT#{id}   SK=TENANT#{id}
//       Agent:        PK=TENANT#{id}   SK=AGENT#{agent_id}
//       Subscription: PK=TENANT#{id}   SK=SUB#{stripe_sub_id}
//       AgentConfig:  PK=TENANT#{id}   SK=CONFIG#{agent_id}#{version}
//       Job:          PK=TENANT#{id}   SK=JOB#{agent_id}#{job_id}
//       WsConnection: PK=TENANT#{id}   SK=WS#{connection_id}
//
//     GSI-1 (byStripeCustomer):
//       PK=gsi1pk (STRIPE#{stripe_customer_id})
//       SK=gsi1sk (TENANT#{id})
//       Use: billing webhook looks up tenant from Stripe event
//
//     GSI-2 (byAgentStatus):
//       PK=gsi2pk (STATUS#{RUNNING|STOPPED|SUSPENDED})
//       SK=gsi2sk (updated_at ISO timestamp)
//       Use: Task Watcher Lambda finds all running/idle tasks
//
//   EventBridge custom bus - platform event routing
//     ECS task state changes → Task Watcher Lambda
//     Provisioning events → SNS notifications
//
// Exports: table, eventBus
// ─────────────────────────────────────────────────────────────────────────────

export interface DataStackProps extends cdk.StackProps {
  readonly cmk: kms.Key;
}

export class DataStack extends cdk.Stack {
  public readonly table:    dynamodb.Table;
  public readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // ── DynamoDB Single Table ──────────────────────────────────────────────
    this.table = new dynamodb.Table(this, 'MainTable', {
      tableName:        'lavavps-main',
      partitionKey:     { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey:          { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode:      dynamodb.BillingMode.PAY_PER_REQUEST,  // On-demand: scales to any load
      encryption:       dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey:    props.cmk,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },  // restore to any second in last 35 days
      deletionProtection:  true,   // Cannot delete without disabling this first
      timeToLiveAttribute: 'ttl',  // Used for temporary records (WS connections, model cache)
      removalPolicy:    cdk.RemovalPolicy.RETAIN,
      // Enable Kinesis streaming for audit log capability (Phase 4+)
      // stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // ── GSI-1: byStripeCustomer ────────────────────────────────────────────
    // Used by stripeWebhookHandler to find a tenant from a Stripe customer ID.
    // Sparse index - only tenant records have gsi1pk populated.
    this.table.addGlobalSecondaryIndex({
      indexName:    'byStripeCustomer',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── GSI-2: byAgentStatus ───────────────────────────────────────────────
    // Used by taskWatcherLambda to scan for RUNNING tasks past their idle timeout.
    // Also used by provisioningLambda to check concurrent task counts.
    // Sparse index - only agent records have gsi2pk populated.
    this.table.addGlobalSecondaryIndex({
      indexName:    'byAgentStatus',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        'tenant_id', 'agent_id', 'plan_code',
        'task_arn',  'last_activity_at', 'idle_timeout_min',
      ],
    });

    // ── EventBridge Custom Bus ─────────────────────────────────────────────
    // Platform event bus for ECS task state changes and provisioning events.
    // Rules (added in ControlPlaneStack when Lambda functions exist):
    //   - ECS task state change STOPPED → Task Watcher crash loop detection
    //   - Provisioning complete → SNS notification to customer
    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: 'lavavps-events',
    });

    // Archive all events on this custom bus for 90 days - replay window for debugging
    this.eventBus.archive('EventArchive', {
      archiveName:  'lavavps-events-archive',
      description:  'LavaVPS platform events - 90-day replay window',
      eventPattern: {},   // matches all events on this custom bus
      retention:    cdk.Duration.days(90),
    });

    // ── SSM Parameters (non-secret config consumed by Lambda env vars) ─────
    // Lambda functions read these at cold start to avoid hardcoding.
    new ssm.StringParameter(this, 'TableNameParam', {
      parameterName: '/lavavps/config/table-name',
      stringValue:   this.table.tableName,
      description:   'LavaVPS DynamoDB table name',
    });

    new ssm.StringParameter(this, 'EventBusNameParam', {
      parameterName: '/lavavps/config/event-bus-name',
      stringValue:   this.eventBus.eventBusName,
      description:   'LavaVPS EventBridge custom bus name',
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'TableName', {
      value:      this.table.tableName,
      exportName: 'LavaVPS-TableName',
      description: 'DynamoDB single table - all LavaVPS control plane data',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value:      this.table.tableArn,
      exportName: 'LavaVPS-TableArn',
    });

    new cdk.CfnOutput(this, 'EventBusArn', {
      value:      this.eventBus.eventBusArn,
      exportName: 'LavaVPS-EventBusArn',
      description: 'EventBridge custom bus - ECS state changes and provisioning events',
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value:      this.eventBus.eventBusName,
      exportName: 'LavaVPS-EventBusName',
    });

    new cdk.CfnOutput(this, 'SingleTableDesignNote', {
      value:      'pk/sk + GSI-1(byStripeCustomer) + GSI-2(byAgentStatus). See data-stack.ts for full entity patterns.',
      description: 'DynamoDB access pattern reference',
    });

    cdk.Tags.of(this).add('Stack', 'Data');
  }
}
