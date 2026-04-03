// ─────────────────────────────────────────────────────────────────────────────
// LavaVPS Platform Configuration
// All environment-specific constants live here.
// Update this file when adding regions, accounts, or changing platform settings.
// ─────────────────────────────────────────────────────────────────────────────

export const Config = {
  // ── AWS Account & Region ──────────────────────────────────────────────────
  account: '914964735635',
  region:  'us-east-1',

  // ── Naming ────────────────────────────────────────────────────────────────
  prefix: 'lavavps',   // used for resource names: lavavps-vpc, lavavps-cmk, etc.
  stackPrefix: 'LavaVPS', // used for CDK stack names

  // ── Networking ────────────────────────────────────────────────────────────
  vpcCidr: '10.100.0.0/16',
  // Actual subnet CIDRs - set after NetworkStack deploy on 2026-04-03
  // Public subnets (ALB nodes live here) - used in OpenClaw trustedProxies
  publicSubnetCidrs: ['10.100.0.0/24', '10.100.1.0/24'],
  // Private subnets (Fargate tasks, Lambda functions)
  privateSubnetIds:  ['subnet-0e0e8c333f6ad7be5', 'subnet-06d8e8ed33a7ba36d'],
  // Security Group IDs - set after NetworkStack deploy
  sgIds: {
    alb:     'sg-09cbe75b279868f71',
    fargate: 'sg-08c42e0b033c1222d',
    ollama:  'sg-00c7a484e49ed29e7',
    lambda:  'sg-0710cb22c903db5e3',
  },

  // ── Deployed Resource ARNs (set after Phase 1 deploy 2026-04-03) ─────────
  deployed: {
    natGatewayIp:          '3.234.120.188',
    cmkArn:                'arn:aws:kms:us-east-1:914964735635:key/b1121ef0-9c7e-4e61-b643-0df20cda67e6',
    cmkAlias:              'alias/lavavps-cmk',
    wafWebAclArn:          'arn:aws:wafv2:us-east-1:914964735635:regional/webacl/lavavps-waf/37ef6a53-aa2d-43a0-b434-402ac8d29a9b',
    // trustedProxies: public subnet CIDRs for OpenClaw gateway config (locked in configRenderer)
    trustedProxies:        ['10.100.0.0/24', '10.100.1.0/24'],
    // Phase 2 - Storage
    efsId:                 'fs-0ff44f0429f833ca5',
    efsArn:                'arn:aws:elasticfilesystem:us-east-1:914964735635:file-system/fs-0ff44f0429f833ca5',
    efsSgId:               'sg-028baa0ca7995fffa',
    configBucket:          'lavavps-configs-914964735635',
    chatBucket:            'lavavps-chat-history-914964735635',
    // Phase 2 - Data
    dynamoTableName:       'lavavps-main',
    dynamoTableArn:        'arn:aws:dynamodb:us-east-1:914964735635:table/lavavps-main',
    eventBusName:          'lavavps-events',
    eventBusArn:           'arn:aws:events:us-east-1:914964735635:event-bus/lavavps-events',
    // Phase 2 - Auth
    userPoolId:            'us-east-1_r7nxhqGwR',
    userPoolArn:           'arn:aws:cognito-idp:us-east-1:914964735635:userpool/us-east-1_r7nxhqGwR',
    userPoolClientId:      '47atk0mdhjraugv76fioc0lh2h',
    cognitoDomain:         'lavavps-auth.auth.us-east-1.amazoncognito.com',
    // ACM Certificates (wildcard, ISSUED, validated 2026-04-03)
    certArnAi:  'arn:aws:acm:us-east-1:914964735635:certificate/b75a309c-cacf-4f0b-86e9-9c4a17edacbd',
    certArnCom: 'arn:aws:acm:us-east-1:914964735635:certificate/84ff8648-287e-46f9-99b5-381ad776ef42',
    // Phase 3 - Runtime (deployed 2026-04-03)
    clusterArn:            'arn:aws:ecs:us-east-1:914964735635:cluster/lavavps-agents',
    clusterName:           'lavavps-agents',
    openclawEcrUri:        '914964735635.dkr.ecr.us-east-1.amazonaws.com/lavavps-openclaw',
    ollamaEcrUri:          '914964735635.dkr.ecr.us-east-1.amazonaws.com/lavavps-ollama',
    externalAlbDns:        'lavavps-external-2118291816.us-east-1.elb.amazonaws.com',
    ollamaAlbDns:          'internal-lavavps-ollama-internal-1242782243.us-east-1.elb.amazonaws.com',
    httpsListenerArn:      'arn:aws:elasticloadbalancing:us-east-1:914964735635:listener/app/lavavps-external/7827c0238878ddd0/25ecc425aef4c1e4',
    fargateExecutionRole:  'arn:aws:iam::914964735635:role/lavavps-fargate-execution-role',
    taskDefStarter:        'arn:aws:ecs:us-east-1:914964735635:task-definition/lavavps-openclaw-starter:3',
    taskDefPro:            'arn:aws:ecs:us-east-1:914964735635:task-definition/lavavps-openclaw-pro:3',
    taskDefBusiness:       'arn:aws:ecs:us-east-1:914964735635:task-definition/lavavps-openclaw-business:3',
  },


  openclawVersion: '2026.4.2',
  openclawPort: 18789,

  // ── Ollama Heartbeat Service ──────────────────────────────────────────────
  ollamaPort: 11434,
  ollamaModel: 'llama3.2:1b',
  // IMPORTANT: heartbeat.every=1h and heartbeat.target=none are LOCKED in the
  // configRenderer base template. Tenants cannot change these values.

  // ── Domains ───────────────────────────────────────────────────────────────
  domains: {
    portal: 'lavavps.ai',       // customer-facing portal
    api:    'api.lavavps.ai',   // REST + WebSocket API
    www:    'www.lavavps.ai',
  },

  // ── Plan Definitions ──────────────────────────────────────────────────────
  plans: {
    starter: {
      code:          'starter',
      vCpu:          256,   // Fargate units: 256 = 0.25 vCPU
      memoryMiB:     1024,  // 1 GB - minimum for Node.js + OpenClaw in production
      agentsIncluded: 1,
      storageGb:     5,
      idleTimeoutMin: 15,
      capacityProvider: 'FARGATE_SPOT', // primary; FARGATE is fallback
    },
    pro: {
      code:          'pro',
      vCpu:          512,   // 0.5 vCPU
      memoryMiB:     1024,
      agentsIncluded: 5,
      storageGb:     50,
      idleTimeoutMin: 30,
      capacityProvider: 'FARGATE',
    },
    business: {
      code:          'business',
      vCpu:          1024,  // 1 vCPU
      memoryMiB:     2048,  // 2 GB
      agentsIncluded: 10,
      storageGb:     100,
      idleTimeoutMin: 60,
      capacityProvider: 'FARGATE',
    },
  },

  // ── Ollama Service Sizing ─────────────────────────────────────────────────
  ollama: {
    vCpu:         2048, // 2 vCPU for CPU inference
    memoryMiB:    4096, // 4 GB - llama3.2:1b fits in ~2GB; headroom for concurrency
    minCount:     2,    // Always run 2 for HA (one per AZ)
    maxCount:     8,    // Scale out under load
  },

  // ── Tags applied to all resources ────────────────────────────────────────
  tags: {
    Project:     'LavaVPS',
    ManagedBy:   'CDK',
    Repository:  'josephwatson360/lavavps-saas',
  },
} as const;

export type PlanCode = keyof typeof Config.plans;
export type PlanConfig = typeof Config.plans[PlanCode];
