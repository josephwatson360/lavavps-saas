#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack }  from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { StorageStack }  from '../lib/storage-stack';
import { DataStack }     from '../lib/data-stack';
import { AuthStack }     from '../lib/auth-stack';
import { Config } from '../lib/config';

// ─────────────────────────────────────────────────────────────────────────────
// LavaVPS CDK Application
//
// Stack deployment order (dependencies flow downward):
//
//   Phase 1:  NetworkStack, SecurityStack
//   Phase 2:  StorageStack, DataStack, AuthStack
//   Phase 3:  RuntimeStack          (ECR, ECS, Ollama, ALBs)
//   Phase 4:  ControlPlaneStack     (Lambda, API Gateway)
//   Phase 5:  BillingStack          (Stripe, Step Functions)
//   Phase 6:  PortalStack           (Amplify, CloudFront, Route 53)
//   Phase 8:  MonitoringStack       (CloudWatch, SNS)
//
// Deploy a single stack:  npx cdk deploy LavaVPS-Network
// Deploy through Phase 2: npx cdk deploy LavaVPS-Network LavaVPS-Security LavaVPS-Storage LavaVPS-Data LavaVPS-Auth
// Preview changes:        npx cdk diff
// ─────────────────────────────────────────────────────────────────────────────

const app = new cdk.App();

const env: cdk.Environment = {
  account: Config.account,
  region:  Config.region,
};

// ── Phase 1: Network & Security ───────────────────────────────────────────
const networkStack = new NetworkStack(app, `${Config.stackPrefix}-Network`, { env });

const securityStack = new SecurityStack(app, `${Config.stackPrefix}-Security`, {
  env,
  vpc: networkStack.vpc,
});

// ── Phase 2: Data Layer ───────────────────────────────────────────────────
// Phases 2a, 2b, 2c can deploy in parallel - no dependencies between them.

const storageStack = new StorageStack(app, `${Config.stackPrefix}-Storage`, {
  env,
  vpc:        networkStack.vpc,
  cmk:        securityStack.cmk,
  fargateSg:  networkStack.fargateSg,
  lambdaSg:   networkStack.lambdaSg,
});

const dataStack = new DataStack(app, `${Config.stackPrefix}-Data`, {
  env,
  cmk: securityStack.cmk,
});

const authStack = new AuthStack(app, `${Config.stackPrefix}-Auth`, { env });

// ── Phase 3+: Coming next sessions ───────────────────────────────────────
// RuntimeStack, ControlPlaneStack, BillingStack, PortalStack, MonitoringStack

// ── Explicit dependency declarations ─────────────────────────────────────
// CDK infers most deps from cross-stack references but explicit deps
// ensure correct deploy ordering when running --all.
storageStack.addDependency(securityStack);
dataStack.addDependency(securityStack);
// authStack has no dependencies on other stacks

// ── Global Tags ───────────────────────────────────────────────────────────
const allStacks = [networkStack, securityStack, storageStack, dataStack, authStack];
allStacks.forEach(stack => {
  Object.entries(Config.tags).forEach(([key, value]) => {
    cdk.Tags.of(stack).add(key, value);
  });
});

app.synth();
