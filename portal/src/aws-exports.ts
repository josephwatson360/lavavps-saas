// LavaVPS — AWS Amplify Configuration
// These values point to the deployed production resources.
// For local dev, copy .env.example to .env.local and override as needed.

const awsExports = {
  // Cognito
  aws_project_region:                     import.meta.env.VITE_AWS_REGION    ?? 'us-east-1',
  aws_cognito_region:                     import.meta.env.VITE_AWS_REGION    ?? 'us-east-1',
  aws_user_pools_id:                      import.meta.env.VITE_USER_POOL_ID  ?? 'us-east-1_r7nxhqGwR',
  aws_user_pools_web_client_id:           import.meta.env.VITE_CLIENT_ID     ?? '47atk0mdhjraugv76fioc0lh2h',
  oauth: {
    domain:             'lavavps-auth.auth.us-east-1.amazoncognito.com',
    scope:              ['email', 'openid', 'profile'],
    redirectSignIn:     import.meta.env.VITE_REDIRECT_URI ?? 'https://lavavps.ai/auth/callback',
    redirectSignOut:    import.meta.env.VITE_REDIRECT_SIGN_OUT ?? 'https://lavavps.ai',
    responseType:       'code',
  },
  // API Gateway
  API: {
    endpoints: [{
      name:     'lavavps-api',
      endpoint: import.meta.env.VITE_API_URL ?? 'https://szq8luumc4.execute-api.us-east-1.amazonaws.com/prod',
      region:   import.meta.env.VITE_AWS_REGION ?? 'us-east-1',
    }],
  },
};

export default awsExports;

// WebSocket endpoint
export const WS_ENDPOINT = import.meta.env.VITE_WS_URL
  ?? 'wss://v7obiyukqj.execute-api.us-east-1.amazonaws.com/prod';

// REST API base URL
export const API_BASE = import.meta.env.VITE_API_URL
  ?? 'https://szq8luumc4.execute-api.us-east-1.amazonaws.com/prod';
