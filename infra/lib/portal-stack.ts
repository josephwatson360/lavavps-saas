import * as cdk     from 'aws-cdk-lib';
import * as amplify  from '@aws-cdk/aws-amplify-alpha';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam      from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Config }    from './config';

// ─────────────────────────────────────────────────────────────────────────────
// PortalStack
//
// AWS Amplify hosting for the LavaVPS React SPA.
// Connected to the GitHub repository with auto-deploy on push to main.
//
// The Amplify app uses the amplify.yml build spec at the repo root.
// Environment variables are injected from CDK config (no secrets in Amplify env).
//
// Domains: lavavps.ai and www.lavavps.ai are connected as custom domains.
// ─────────────────────────────────────────────────────────────────────────────

export interface PortalStackProps extends cdk.StackProps {
  readonly githubOwner:    string;
  readonly githubRepo:     string;
  readonly githubToken:    string;   // GitHub personal access token (from Secrets Manager in prod)
}

export class PortalStack extends cdk.Stack {
  public readonly amplifyAppId: string;
  public readonly appUrl:       string;

  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props);

    // ── Amplify App ──────────────────────────────────────────────────────────
    const app = new amplify.App(this, 'PortalApp', {
      appName:     'lavavps-portal',
      description: 'LavaVPS customer portal — React SPA',

      // GitHub source
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        owner:     props.githubOwner,
        repository: props.githubRepo,
        oauthToken: cdk.SecretValue.unsafePlainText(props.githubToken),
      }),

      // Build spec is in amplify.yml at repo root
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: '1.0',
        frontend: {
          phases: {
            preBuild:  { commands: ['cd portal', 'npm ci'] },
            build:     { commands: ['npm run build'] },
          },
          artifacts: { baseDirectory: 'portal/dist', files: ['**/*'] },
          cache:     { paths: ['portal/node_modules/**/*'] },
        },
      }),

      // SPA routing — all paths go to index.html
      customRules: [
        {
          source:  '</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|ttf|map|json)$)([^.]+$)/>',
          target:  '/index.html',
          status:  amplify.RedirectStatus.REWRITE,
        },
      ],

      // Environment variables (non-secret portal config)
      environmentVariables: {
        VITE_AWS_REGION:       Config.region,
        VITE_USER_POOL_ID:     Config.deployed.userPoolId,
        VITE_CLIENT_ID:        Config.deployed.userPoolClientId,
        VITE_API_URL:          Config.deployed.restApiUrl,
        VITE_WS_URL:           `wss://${Config.deployed.wsApiId}.execute-api.${Config.region}.amazonaws.com/prod`,
        VITE_REDIRECT_URI:     'https://lavavps.ai/auth/callback',
        VITE_REDIRECT_SIGN_OUT: 'https://lavavps.ai',
      },
    });

    // ── Main branch — auto-deploy on push to main ────────────────────────────
    const mainBranch = app.addBranch('main', {
      autoBuild:     true,
      description:   'Production — deploys on every push to main',
      stage:         'PRODUCTION',
      environmentVariables: {
        NODE_ENV: 'production',
      },
    });

    // ── Custom domains ───────────────────────────────────────────────────────
    // Note: Amplify manages its own CloudFront distribution.
    // Route 53 CNAME records must point to the Amplify CloudFront domain.
    // The Amplify console verifies domain ownership via DNS.
    //
    // After deploy, go to:
    //   AWS Console → Amplify → lavavps-portal → Domain Management
    //   → Add domain → lavavps.ai → Configure subdomains
    //
    // Subdomain mapping:
    //   lavavps.ai     → main branch (portal root)
    //   www.lavavps.ai → main branch (portal root)
    //   api.lavavps.ai → POINTS TO EXTERNAL ALB (not Amplify)
    //
    // Note: api.lavavps.ai Route 53 record was already created pointing to
    //       the external ALB in Phase 3. Do not add it to Amplify custom domains.

    this.amplifyAppId = app.appId;
    this.appUrl       = `https://main.${app.defaultDomain}`;

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value:       app.appId,
      exportName:  'LavaVPS-AmplifyAppId',
      description: 'Amplify app ID — view in Amplify console',
    });

    new cdk.CfnOutput(this, 'AmplifyDefaultDomain', {
      value:       app.defaultDomain,
      exportName:  'LavaVPS-AmplifyDomain',
      description: 'Default Amplify domain (use for testing before custom domain is set up)',
    });

    new cdk.CfnOutput(this, 'PortalUrl', {
      value:       this.appUrl,
      description: 'Portal URL (main branch) — switch to https://lavavps.ai after domain setup',
    });

    new cdk.CfnOutput(this, 'NextStep', {
      value:       'After deploy: Go to Amplify Console → lavavps-portal → Domain Management → Add lavavps.ai',
      description: 'Manual step required to connect custom domain',
    });

    cdk.Tags.of(this).add('Stack', 'Portal');
  }
}
