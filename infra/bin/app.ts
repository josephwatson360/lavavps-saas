#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack }      from '../lib/network-stack';
import { SecurityStack }     from '../lib/security-stack';
import { StorageStack }      from '../lib/storage-stack';
import { DataStack }         from '../lib/data-stack';
import { AuthStack }         from '../lib/auth-stack';
import { RuntimeStack }      from '../lib/runtime-stack';
import { ControlPlaneStack } from '../lib/control-plane-stack';
import { Config } from '../lib/config';

const app = new cdk.App();
const env: cdk.Environment = { account: Config.account, region: Config.region };

// Phase 1
const networkStack  = new NetworkStack(app,  `${Config.stackPrefix}-Network`,  { env });
const securityStack = new SecurityStack(app, `${Config.stackPrefix}-Security`, {
  env, vpc: networkStack.vpc,
});

// Phase 2
const storageStack = new StorageStack(app, `${Config.stackPrefix}-Storage`, {
  env,
  vpc:       networkStack.vpc,
  cmk:       securityStack.cmk,
  fargateSg: networkStack.fargateSg,
  lambdaSg:  networkStack.lambdaSg,
});
const dataStack = new DataStack(app, `${Config.stackPrefix}-Data`, {
  env, cmk: securityStack.cmk,
});
const authStack = new AuthStack(app, `${Config.stackPrefix}-Auth`, { env });

// Phase 3
const runtimeStack = new RuntimeStack(app, `${Config.stackPrefix}-Runtime`, {
  env,
  vpc:          networkStack.vpc,
  cmk:          securityStack.cmk,
  albSg:        networkStack.albSg,
  fargateSg:    networkStack.fargateSg,
  ollamaSg:     networkStack.ollamaSg,
  efsSg:        storageStack.efsSg,
  filesystem:   storageStack.filesystem,
  userPool:     authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  wafWebAclArn: securityStack.wafWebAclArn,
});

// Phase 4
const controlPlaneStack = new ControlPlaneStack(app, `${Config.stackPrefix}-ControlPlane`, {
  env,
  vpc:             networkStack.vpc,
  cmk:             securityStack.cmk,
  lambdaSg:        networkStack.lambdaSg,
  configBucket:       storageStack.configBucket,
  bootstrapperApId:   storageStack.bootstrapperApId,
  userPool:        authStack.userPool,
  userPoolClient:  authStack.userPoolClient,
  eventBus:        dataStack.eventBus,
});

// Dependency declarations
storageStack.addDependency(securityStack);
dataStack.addDependency(securityStack);
runtimeStack.addDependency(networkStack);
runtimeStack.addDependency(storageStack);
runtimeStack.addDependency(authStack);
controlPlaneStack.addDependency(runtimeStack);
controlPlaneStack.addDependency(dataStack);

// Global tags
const allStacks = [networkStack, securityStack, storageStack, dataStack,
                   authStack, runtimeStack, controlPlaneStack];
allStacks.forEach(stack =>
  Object.entries(Config.tags).forEach(([k, v]) => cdk.Tags.of(stack).add(k, v))
);

app.synth();
