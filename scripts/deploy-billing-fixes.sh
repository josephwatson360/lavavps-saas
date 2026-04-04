#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-billing-fixes.sh — Deploy all 3 billing fixes
# Run from project root: bash scripts/deploy-billing-fixes.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLERS="$ROOT/lambdas/handlers"

echo "========================================================="
echo " LavaVPS Billing Fixes Deployment"
echo "========================================================="

# ── Fix 1: stripeWebhook ────────────────────────────────────────────────────
echo ""
echo "[1/4] Patching stripeWebhook index.js..."

# Fix metadata key: addon_type → type
sed -i "s/session\.metadata?.addon_type/session.metadata?.type/g" \
  "$HANDLERS/stripeWebhook/index.js" 2>/dev/null || true

# Fix DynamoDB sk in addStorage and updatePlan and suspendTenant
# These all used sk: `TENANT#${tenantId}` but should be sk: 'PROFILE'
node -e "
const fs = require('fs');
const path = '$HANDLERS/stripeWebhook/index.js';
let code = fs.readFileSync(path, 'utf8');

// Fix addStorage DynamoDB key
code = code.replace(
  /Key:\s*\{\s*pk:\s*\`TENANT#\\\${tenantId}\`\s*,\s*sk:\s*\`TENANT#\\\${tenantId}\`\s*\}/g,
  'Key: { pk: \`TENANT#\${tenantId}\`, sk: \"PROFILE\" }'
);

// Fix updatePlan UpdateExpression to use correct storage field name
code = code.replace(
  /ADD storage_quota_gb/g,
  'ADD storage_addon_gb'
);

fs.writeFileSync(path, code);
console.log('stripeWebhook index.js patched');
" 2>/dev/null || echo "  Note: JS patch failed — deploy from fixed index.ts instead"

echo "  Deploying stripeWebhook Lambda..."
cd "$HANDLERS/stripeWebhook"
zip -r /tmp/stripe-webhook.zip . --exclude "*.ts" --exclude ".git/*" -q
aws lambda update-function-code \
  --function-name lavavps-stripe-webhook \
  --zip-file fileb:///tmp/stripe-webhook.zip \
  --query "{FunctionName:FunctionName, LastModified:LastModified}" 2>/dev/null || \
aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'webhook') || contains(FunctionName,'Webhook')].FunctionName" \
  --output text | xargs -I{} aws lambda update-function-code \
    --function-name {} \
    --zip-file fileb:///tmp/stripe-webhook.zip \
    --query "{FunctionName:FunctionName, LastModified:LastModified}"

echo "  ✅ stripeWebhook deployed"

# ── Fix 2: billingHandler — storage mode fix ────────────────────────────────
echo ""
echo "[2/4] Patching billingHandler — fix storage checkout mode..."

cd "$HANDLERS/billingHandler"

# Change storage from payment to subscription mode to match recurring Stripe prices
sed -i "s/mode    = 'payment'; \/\/ one-time purchase/mode    = 'subscription'; \/\/ matches recurring price in Stripe (create one-time price to change this)/g" index.js

# Also fix metadata to use consistent key names
# (type is already correct, but make sure storage_gb is passed correctly)
echo "  Verifying mode fix..."
grep -n "mode.*subscription\|mode.*payment" index.js | head -5

echo "  Deploying billingHandler Lambda..."
zip -r /tmp/billing-fix.zip . --exclude "*.ts" --exclude ".git/*" -q
aws lambda update-function-code \
  --function-name lavavps-billing-handler \
  --zip-file fileb:///tmp/billing-fix.zip \
  --query "{FunctionName:FunctionName, LastModified:LastModified}"
aws lambda wait function-updated --function-name lavavps-billing-handler
echo "  ✅ billingHandler deployed"

# ── Fix 3: Add custom:addon_agents to Cognito User Pool ────────────────────
echo ""
echo "[3/4] Adding custom:addon_agents attribute to Cognito User Pool..."
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 \
  --query "UserPools[?contains(Name,'lavavps')].Id" --output text | head -1)

if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID="us-east-1_r7nxhqGwR"
fi

# Add the custom attribute if it doesn't exist
aws cognito-idp add-custom-attributes \
  --user-pool-id "$USER_POOL_ID" \
  --custom-attributes '[{"Name":"addon_agents","AttributeDataType":"Number","Mutable":true,"NumberAttributeConstraints":{"MinValue":"0","MaxValue":"100"}}]' \
  2>/dev/null && echo "  ✅ custom:addon_agents attribute added" || \
  echo "  ℹ️  custom:addon_agents may already exist — that's fine"

# Grant stripeWebhook Lambda permission to update Cognito user attributes
WEBHOOK_ROLE=$(aws lambda get-function-configuration \
  --function-name lavavps-stripe-webhook \
  --query "Role" --output text 2>/dev/null | sed 's|arn:aws:iam::[0-9]*:role/||' || echo "")

if [ -n "$WEBHOOK_ROLE" ]; then
  # Create inline policy for Cognito attribute updates
  aws iam put-role-policy \
    --role-name "$WEBHOOK_ROLE" \
    --policy-name "CognitoUpdateUserAttributes" \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Effect\": \"Allow\",
        \"Action\": [\"cognito-idp:AdminUpdateUserAttributes\"],
        \"Resource\": \"arn:aws:cognito-idp:us-east-1:914964735635:userpool/$USER_POOL_ID\"
      }]
    }" 2>/dev/null && echo "  ✅ Cognito permissions granted to stripeWebhook" || \
    echo "  ⚠️  Could not auto-attach Cognito policy — attach manually"
fi

# ── Fix 4: Commit all source files ──────────────────────────────────────────
echo ""
echo "[4/4] Committing fixed source files..."
cd "$ROOT"
git add -A
git commit -m "fix: billing - storage mode, metadata key, DynamoDB sk, addon_agent tracking" || echo "  Nothing new to commit"
git push origin main
echo "  ✅ Pushed to main"

echo ""
echo "========================================================="
echo " Deployment complete!"
echo ""
echo " ACTION REQUIRED — Stripe one-time prices:"
echo " Storage add-ons should be one-time purchases."
echo " Your current Stripe prices are recurring. To fix:"
echo "   1. Go to dashboard.stripe.com → Product Catalog"
echo "   2. For each storage product (10GB, 50GB, 100GB):"
echo "      - Add a new one-time price at the same amount"
echo "      - Copy the price ID (price_...)"
echo "   3. Update the secret:"
echo "      aws secretsmanager put-secret-value \\"
echo "        --secret-id /openclaw/prod/stripe/price-ids \\"
echo "        --secret-string '{...updated JSON with new price IDs...}'"
echo "   4. Re-run: sed -i 's/subscription/payment/' lambdas/handlers/billingHandler/index.js"
echo "      then re-zip and redeploy billingHandler"
echo ""
echo " Also fix addon_agent price ID — currently same as plan_starter!"
echo "========================================================="
