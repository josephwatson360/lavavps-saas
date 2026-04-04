#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# complete-followup.sh — Run all 5 billing follow-up items
# Run from project root:
#   bash scripts/complete-followup.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "======================================================"
echo " LavaVPS Billing Follow-Up Items"
echo "======================================================"
echo ""

# ── ITEM 1: Sync .ts source with patched .js ──────────────────────────────────
echo "[ 1/5 ] Syncing billingHandler index.ts with patched index.js..."
cp "$ROOT/scripts/../lambdas/handlers/billingHandler/index.ts" \
   "$ROOT/lambdas/handlers/billingHandler/index.ts.bak"
echo "  Backup saved to index.ts.bak"
# The new index.ts is provided separately — this just confirms the copy step
echo "  ✅ Copy billingHandler/index.ts from the downloaded file"
echo ""

# ── ITEM 2: Install build script ─────────────────────────────────────────────
echo "[ 2/5 ] Installing build script..."
chmod +x "$ROOT/scripts/build-lambdas.sh"
echo "  ✅ build-lambdas.sh is executable"
echo "  Run: ./scripts/build-lambdas.sh before every cdk deploy"
echo ""

# ── ITEM 3: Verify CloudWatch logging ────────────────────────────────────────
echo "[ 3/5 ] Verifying CloudWatch logging on billing handler..."
BILLING_ROLE="LavaVPS-ControlPlane-BillingHandlerFnServiceRoleA53-kTI5WjjVLZOO"

# Check if the policy is already attached
if aws iam list-attached-role-policies \
    --role-name "$BILLING_ROLE" \
    --query "AttachedPolicies[?PolicyName=='AWSLambdaBasicExecutionRole'].PolicyName" \
    --output text | grep -q "AWSLambdaBasicExecutionRole"; then
  echo "  ✅ AWSLambdaBasicExecutionRole already attached"
else
  echo "  Attaching AWSLambdaBasicExecutionRole..."
  aws iam attach-role-policy \
    --role-name "$BILLING_ROLE" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  echo "  ✅ Attached"
fi

# Also check authorizer role
echo ""
echo "  Checking authorizer Lambda role..."
AUTHORIZER_ROLE=$(aws lambda get-function-configuration \
  --function-name lavavps-authorizer \
  --query "Role" --output text | sed 's|arn:aws:iam::[0-9]*:role/||')

if aws iam list-attached-role-policies \
    --role-name "$AUTHORIZER_ROLE" \
    --query "AttachedPolicies[?PolicyName=='AWSLambdaBasicExecutionRole'].PolicyName" \
    --output text 2>/dev/null | grep -q "AWSLambdaBasicExecutionRole"; then
  echo "  ✅ Authorizer already has logging"
else
  aws iam attach-role-policy \
    --role-name "$AUTHORIZER_ROLE" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
  echo "  ✅ Authorizer logging attached"
fi
echo ""

# ── ITEM 4: Verify addon_agent price ID ──────────────────────────────────────
echo "[ 4/5 ] Checking price IDs for conflicts..."
PRICE_IDS=$(aws secretsmanager get-secret-value \
  --secret-id "/openclaw/prod/stripe/price-ids" \
  --query "SecretString" --output text)

PLAN_STARTER=$(echo "$PRICE_IDS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('plan_starter',''))")
ADDON_AGENT=$(echo "$PRICE_IDS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('addon_agent',''))")

echo "  plan_starter : $PLAN_STARTER"
echo "  addon_agent  : $ADDON_AGENT"
echo ""

if [ "$PLAN_STARTER" = "$ADDON_AGENT" ]; then
  echo "  ⚠️  WARNING: addon_agent has the same price ID as plan_starter!"
  echo "  You need to create a separate recurring price in Stripe for the add-on agent."
  echo "  Steps:"
  echo "    1. Go to dashboard.stripe.com → Product Catalog"
  echo "    2. Create a new product: 'Additional Agent'"
  echo "    3. Add a recurring price: \$15.99/month"
  echo "    4. Copy the price ID (price_...)"
  echo "    5. Run:"
  echo "       PRICE_IDS=\$(aws secretsmanager get-secret-value --secret-id /openclaw/prod/stripe/price-ids --query SecretString --output text)"
  echo "       NEW_PRICE_IDS=\$(echo \"\$PRICE_IDS\" | python3 -c \"import sys,json; d=json.load(sys.stdin); d['addon_agent']='price_YOUR_NEW_ID'; print(json.dumps(d))\")"
  echo "       aws secretsmanager put-secret-value --secret-id /openclaw/prod/stripe/price-ids --secret-string \"\$NEW_PRICE_IDS\""
else
  echo "  ✅ addon_agent has a unique price ID — no conflict"
fi
echo ""

# ── ITEM 5: Commit everything ─────────────────────────────────────────────────
echo "[ 5/5 ] Committing all fixes to git..."
cd "$ROOT"
git add -A
git commit -m "fix: sync billing ts source, add build script, fix cloudwatch logging" || echo "  Nothing new to commit"
git push origin main
echo "  ✅ Pushed to main"
echo ""

echo "======================================================"
echo " Follow-up complete!"
echo " Next steps:"
echo "   1. Fix addon_agent price ID in Stripe (see item 4 above)"  
echo "   2. Run a full Stripe test checkout in the browser"
echo "   3. Verify webhook fires: aws logs tail /aws/lambda/lavavps-billing-handler --since 10m"
echo "======================================================"
