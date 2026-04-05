import { PreTokenGenerationTriggerHandler } from 'aws-lambda';
import { createLogger } from '../../layer/src/logger';

// ─────────────────────────────────────────────────────────────────────────────
// preTokenGenerationHandler
//
// Cognito Pre Token Generation V2 trigger.
//
// Injects custom:tenant_id and custom:plan_code into the JWT at login time.
// This is the ONLY mechanism that puts tenant context into the token —
// all downstream Lambda authorizers depend on these claims being present
// in the JWT payload.
//
// Trigger: Cognito User Pool → Pre Token Generation Config (V2)
// Fires:   On every sign-in, token refresh, and hosted UI callback.
// ─────────────────────────────────────────────────────────────────────────────

const logger = createLogger('preTokenGenerationHandler');

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const attrs = event.request.userAttributes;

  const tenantId = attrs['custom:tenant_id'] ?? '';
  const planCode  = attrs['custom:plan_code']  ?? 'starter';

  if (!tenantId) {
    logger.warn('preTokenGeneration: custom:tenant_id missing from user attributes', {
      username: event.userName,
      userPoolId: event.userPoolId,
    });
  }

  // Inject into the ID token claims.
  // claimsToAddOrOverride merges into the token payload — does not replace it.
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:tenant_id': tenantId,
        'custom:plan_code':  planCode,
      },
    },
  };

  return event;
};
