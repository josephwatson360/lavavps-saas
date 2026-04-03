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
  // Subnets are CDK-managed within the VPC CIDR.
  // Actual CIDRs will be auto-assigned by CDK starting at 10.100.0.0/24.
  // Run `cdk synth` and check CloudFormation outputs for the actual CIDR assignments.

  // ── OpenClaw Runtime ──────────────────────────────────────────────────────
  openclawVersion: '2026.3.24',
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
      memoryMiB:     1024,  // 1 GB — minimum for Node.js + OpenClaw in production
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
    memoryMiB:    4096, // 4 GB — llama3.2:1b fits in ~2GB; headroom for concurrency
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
