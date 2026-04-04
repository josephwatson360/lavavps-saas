"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// preTokenGeneration
//
// Cognito Pre Token Generation trigger.
// Injects custom:tenant_id and custom:plan_code into every JWT so
// downstream Lambda authorizers can read them from payload claims.
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Read the user attributes Cognito already has
  const attrs = {};
  for (const attr of (event.request.userAttributes ? Object.entries(event.request.userAttributes) : [])) {
    attrs[attr[0]] = attr[1];
  }

  const tenantId = attrs["custom:tenant_id"] || "";
  const planCode  = attrs["custom:plan_code"]  || "starter";

  // Inject into both id token and access token claims
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        "custom:tenant_id": tenantId,
        "custom:plan_code":  planCode,
      },
    },
  };

  return event;
};
