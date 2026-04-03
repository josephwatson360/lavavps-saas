# LavaVPS — AI Agent SaaS Platform

OpenClaw AI Agent hosting on AWS. Multi-tenant, BYOK, ECS Fargate.

## Quick Start

### Prerequisites
- Node.js 22+ · AWS CLI configured · Docker running
- AWS Account: `914964735635` · Region: `us-east-1`

### First-time setup
```bash
git clone https://github.com/josephwatson360/lavavps-saas
cd lavavps-saas
chmod +x scripts/*.sh
./scripts/bootstrap.sh
```

The bootstrap script will:
1. CDK bootstrap your AWS account
2. Install all npm dependencies
3. Request ACM wildcard certificates for `*.lavavps.ai` and `*.lavavps.com`
4. Run `cdk synth` to verify everything compiles

> **After bootstrap:** Go to AWS Console → ACM → add the DNS validation records
> for both certificates. Route 53 auto-validates in 5–30 minutes.

### Deploy Phase 1

```bash
npm run deploy:network    # VPC, subnets, security groups
npm run deploy:security   # KMS CMK, CloudTrail, WAF
```

## Project Structure

```
lavavps-saas/
├── infra/              CDK TypeScript stacks (10 stacks total)
│   ├── bin/app.ts      CDK app entry point
│   └── lib/
│       ├── config.ts            Platform constants
│       ├── network-stack.ts     Phase 1: VPC & networking
│       ├── security-stack.ts    Phase 1: KMS, CloudTrail, WAF
│       ├── storage-stack.ts     Phase 2: EFS (IT), S3
│       ├── data-stack.ts        Phase 2: DynamoDB, Secrets Manager
│       ├── auth-stack.ts        Phase 2: Cognito
│       ├── runtime-stack.ts     Phase 3: ECR, ECS, Ollama, ALBs
│       ├── control-plane-stack.ts  Phase 4: Lambda, API Gateway
│       ├── billing-stack.ts     Phase 5: Stripe, Step Functions
│       ├── portal-stack.ts      Phase 6: Amplify, CloudFront
│       └── monitoring-stack.ts  Phase 8: CloudWatch, SNS
├── lambdas/            Lambda function handlers
│   ├── layer/src/      Shared utilities (logger, response)
│   └── handlers/       Individual Lambda functions
├── docker/openclaw/    OpenClaw container Dockerfile
├── scripts/            Bootstrap, image push, utilities
└── .github/workflows/  CI/CD pipelines
```

## CDK Stack Reference

| Stack | Command | Phase |
|-------|---------|-------|
| NetworkStack | `npm run deploy:network` | 1 |
| SecurityStack | `npm run deploy:security` | 1 |
| StorageStack | `npx cdk deploy LavaVPS-Storage` | 2 |
| DataStack | `npx cdk deploy LavaVPS-Data` | 2 |
| AuthStack | `npx cdk deploy LavaVPS-Auth` | 2 |
| RuntimeStack | `npx cdk deploy LavaVPS-Runtime` | 3 |
| ControlPlaneStack | `npx cdk deploy LavaVPS-ControlPlane` | 4 |
| BillingStack | `npx cdk deploy LavaVPS-Billing` | 5 |
| PortalStack | `npx cdk deploy LavaVPS-Portal` | 6 |
| MonitoringStack | `npx cdk deploy LavaVPS-Monitoring` | 8 |

## Key Architecture Decisions

- **OpenClaw v2026.3.24** — pinned in `infra/lib/config.ts`
- **VPC CIDR**: `10.100.0.0/16` — single NAT Gateway for fixed egress IP
- **Auth**: ALB Cognito auth → OpenClaw `trusted-proxy` mode (no gateway token in WS payloads)
- **Heartbeat**: Shared Ollama ECS service (llama3.2:1b) — zero customer API token consumption
- **EFS**: Intelligent Tiering mandatory — enabled at filesystem creation, cannot add retroactively
- **No Nginx** — OpenClaw's built-in HTTP on port 18789, ALB handles TLS

## Documentation

See the `/docs` folder in the project for:
- Architecture Plan v2 (25 pages)
- Enhanced Application Architecture (11 pages)  
- Implementation Plan (31 pages)
