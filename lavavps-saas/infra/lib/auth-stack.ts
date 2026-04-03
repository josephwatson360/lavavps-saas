import * as cdk     from 'aws-cdk-lib';
import * as cognito  from 'aws-cdk-lib/aws-cognito';
import * as ssm      from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// ─────────────────────────────────────────────────────────────────────────────
// AuthStack
//
// Cognito User Pool — authentication and identity for the LavaVPS portal.
//
// JWT claims structure (tenant_id and plan_code in every token):
//   sub             Cognito user ID (maps to our tenant_id on first login)
//   email           User email address
//   custom:tenant_id  Immutable — set once at registration by provisioningLambda
//   custom:plan_code  Mutable  — updated by billingHandler on plan change
//   custom:role     Mutable  — owner | member (multi-user, future)
//
// Lambda triggers (wired in ControlPlaneStack after Lambda functions exist):
//   postConfirmation    → creates DynamoDB tenant record on first email verify
//   preTokenGeneration  → injects custom attributes into JWT access token
//
// Security:
//   - Email verification required before any API access
//   - MFA optional (TOTP) — can be made mandatory for Business+ in future
//   - Password min 12 chars, all character classes required
//   - Account recovery via email only (no SMS cost)
//   - RETAIN policy — never recreate User Pool in prod (all users would be lost)
//
// Exports: userPool, userPoolClient, userPoolId, userPoolClientId
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthStackProps extends cdk.StackProps {}

export class AuthStack extends cdk.Stack {
  public readonly userPool:       cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: AuthStackProps) {
    super(scope, id, props);

    // ── User Pool ──────────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName:    'lavavps-users',
      selfSignUpEnabled: true,

      // Email is the username — no separate username field
      signInAliases:   { email: true, username: false, phone: false },
      autoVerify:      { email: true },

      // Required standard attributes
      standardAttributes: {
        email: { required: true, mutable: true },
      },

      // Custom attributes — these appear as custom:* in JWT claims.
      // tenant_id: immutable — set once at provisioning, cannot be changed by user.
      // plan_code: mutable  — updated by billingHandler on subscription events.
      // role:      mutable  — owner initially; future multi-user support.
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: false, minLen: 1, maxLen: 64 }),
        plan_code: new cognito.StringAttribute({ mutable: true,  minLen: 1, maxLen: 20 }),
        role:      new cognito.StringAttribute({ mutable: true,  minLen: 1, maxLen: 20 }),
      },

      // Password policy — strong but not unusable
      passwordPolicy: {
        minLength:          12,
        requireLowercase:   true,
        requireUppercase:   true,
        requireDigits:      true,
        requireSymbols:     true,
        tempPasswordValidity: cdk.Duration.days(7),
      },

      // MFA — optional TOTP (no SMS cost, no phone number required)
      mfa:             cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },

      // Recovery via email only
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Email configuration — Cognito default sender for now.
      // Switch to SES with custom domain (no-reply@lavavps.ai) before launch.
      email: cognito.UserPoolEmail.withCognito(),

      // User account settings
      userVerification: {
        emailSubject: 'Verify your LavaVPS account',
        emailBody:    'Your LavaVPS verification code is {####}',
        emailStyle:   cognito.VerificationEmailStyle.CODE,
      },

      userInvitation: {
        emailSubject: 'You have been invited to LavaVPS',
        emailBody:    'Your username is {username} and your temporary password is {####}',
      },

      // Deletion protection — losing all users in prod is catastrophic
      deletionProtection: true,
      removalPolicy:      cdk.RemovalPolicy.RETAIN,
    });

    // ── User Pool Domain ───────────────────────────────────────────────────
    // Cognito-hosted UI domain. Used for OAuth flows and hosted sign-in page.
    // Format: https://lavavps-auth.auth.us-east-1.amazoncognito.com
    this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: { domainPrefix: 'lavavps-auth' },
    });

    // ── User Pool Client ───────────────────────────────────────────────────
    // The React portal SPA uses this client to authenticate.
    // No client secret — SPA is a public client (cannot securely store secrets).
    this.userPoolClient = this.userPool.addClient('PortalClient', {
      userPoolClientName: 'lavavps-portal',
      generateSecret:     false,  // Public client — SPA cannot store secrets

      // Auth flows — SRP is secure; USER_PASSWORD_AUTH for migration scenarios
      authFlows: {
        userSrp:       true,   // Secure Remote Password — primary flow
        userPassword:  false,  // Disable plain password auth
        custom:        false,
        adminUserPassword: false,
      },

      // Token validity
      accessTokenValidity:  cdk.Duration.hours(1),
      idTokenValidity:      cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),

      // Prevent token reuse after refresh
      enableTokenRevocation: true,

      // OAuth2 scopes available to this client
      oAuth: {
        flows:    { authorizationCodeGrant: true },
        scopes:   [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          'https://lavavps.ai/auth/callback',
          'https://www.lavavps.ai/auth/callback',
          'http://localhost:3000/auth/callback',  // Local dev only — remove before launch
        ],
        logoutUrls: [
          'https://lavavps.ai',
          'http://localhost:3000',
        ],
      },

      // Suppress the default Cognito attributes from the token — our
      // preTokenGeneration trigger injects only what we need
      readAttributes:  new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes('tenant_id', 'plan_code', 'role'),
      writeAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true }),
    });

    // ── SSM Parameters ─────────────────────────────────────────────────────
    // Lambda functions and the portal build read these at deploy time.
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: '/lavavps/config/user-pool-id',
      stringValue:   this.userPool.userPoolId,
      description:   'Cognito User Pool ID',
    });

    new ssm.StringParameter(this, 'UserPoolClientIdParam', {
      parameterName: '/lavavps/config/user-pool-client-id',
      stringValue:   this.userPoolClient.userPoolClientId,
      description:   'Cognito User Pool Client ID — safe to expose in portal bundle',
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', {
      value:      this.userPool.userPoolId,
      exportName: 'LavaVPS-UserPoolId',
      description: 'Cognito User Pool ID — used in API Gateway authorizer config',
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value:      this.userPool.userPoolArn,
      exportName: 'LavaVPS-UserPoolArn',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value:      this.userPoolClient.userPoolClientId,
      exportName: 'LavaVPS-UserPoolClientId',
      description: 'Portal client ID — safe to include in React app bundle',
    });

    new cdk.CfnOutput(this, 'CognitoLoginUrl', {
      value:      `https://lavavps-auth.auth.us-east-1.amazoncognito.com/login?client_id=${this.userPoolClient.userPoolClientId}&response_type=code&scope=email+openid+profile&redirect_uri=https://lavavps.ai/auth/callback`,
      description: 'Hosted UI login URL — for testing auth flow',
    });

    new cdk.CfnOutput(this, 'LambdaTriggersNote', {
      value:      'postConfirmation and preTokenGeneration triggers added in ControlPlaneStack (Phase 4) after Lambda functions exist.',
      description: 'Lambda trigger wiring deferred to ControlPlaneStack',
    });

    cdk.Tags.of(this).add('Stack', 'Auth');
  }
}
