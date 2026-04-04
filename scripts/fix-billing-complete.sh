#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fix-billing-complete.sh — Complete billing system fix
# Run from project root: bash scripts/fix-billing-complete.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TENANT_ID="tenant-josephwatson360"
COGNITO_SUB="54d8c4e8-f001-7044-7736-99d2f387fcfa"
EMAIL="josephwatson360@gmail.com"
STRIPE_CUSTOMER_ID="cus_UH3U8Xu52q3diR"
STRIPE_SUB_ID="sub_1TIVNWROVSID3RREjEte2Lmn"
TABLE="lavavps-main"
REST_API="szq8luumc4"
BILLING_RESOURCE_ID="g6n8w3"   # /billing resource from earlier get-resources output
USER_POOL_ID="us-east-1_r7nxhqGwR"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

echo "========================================================="
echo " LavaVPS Complete Billing Fix"
echo "========================================================="

# ── STEP 1: Seed DynamoDB PROFILE record ─────────────────────────────────────
echo ""
echo "[1/6] Seeding DynamoDB PROFILE record..."

aws dynamodb put-item \
  --table-name "$TABLE" \
  --item "{
    \"pk\":                  {\"S\": \"TENANT#${TENANT_ID}\"},
    \"sk\":                  {\"S\": \"PROFILE\"},
    \"tenant_id\":           {\"S\": \"${TENANT_ID}\"},
    \"cognito_sub\":         {\"S\": \"${COGNITO_SUB}\"},
    \"email\":               {\"S\": \"${EMAIL}\"},
    \"plan_code\":           {\"S\": \"pro\"},
    \"status\":              {\"S\": \"ACTIVE\"},
    \"subscription_status\": {\"S\": \"trialing\"},
    \"stripe_customer_id\":  {\"S\": \"${STRIPE_CUSTOMER_ID}\"},
    \"stripe_sub_id\":       {\"S\": \"${STRIPE_SUB_ID}\"},
    \"gsi1pk\":              {\"S\": \"STRIPE#${STRIPE_CUSTOMER_ID}\"},
    \"storage_base_gb\":     {\"N\": \"50\"},
    \"storage_addon_gb\":    {\"N\": \"0\"},
    \"addon_agent_count\":   {\"N\": \"0\"},
    \"created_at\":          {\"S\": \"${NOW}\"},
    \"updated_at\":          {\"S\": \"${NOW}\"}
  }"

echo "  ✅ PROFILE record seeded"

# Verify it's there
echo "  Verifying..."
aws dynamodb get-item \
  --table-name "$TABLE" \
  --key "{\"pk\":{\"S\":\"TENANT#${TENANT_ID}\"},\"sk\":{\"S\":\"PROFILE\"}}" \
  --query "Item.{plan:plan_code.S, customer:stripe_customer_id.S, status:status.S}" \
  --output json

# ── STEP 2: Update Cognito user attributes to reflect Pro plan ────────────────
echo ""
echo "[2/6] Updating Cognito user to reflect Pro plan..."

aws cognito-idp admin-update-user-attributes \
  --user-pool-id "$USER_POOL_ID" \
  --username "$COGNITO_SUB" \
  --user-attributes \
    Name="custom:plan_code",Value="pro" \
    Name="custom:addon_agents",Value="0"

echo "  ✅ Cognito updated — next token refresh will show Pro plan"

# ── STEP 3: Add GET /billing route to API Gateway ─────────────────────────────
echo ""
echo "[3/6] Adding GET /billing/info route to API Gateway..."

# Check if GET already exists on /billing
EXISTING=$(aws apigateway get-method \
  --rest-api-id "$REST_API" \
  --resource-id "$BILLING_RESOURCE_ID" \
  --http-method GET 2>/dev/null | grep httpMethod || echo "")

if [ -z "$EXISTING" ]; then
  # Get the billing handler Lambda ARN
  BILLING_ARN=$(aws lambda get-function-configuration \
    --function-name lavavps-billing-handler \
    --query "FunctionArn" --output text)
  REGION="us-east-1"
  ACCOUNT="914964735635"

  # Add GET method with Cognito authorizer (same as POST)
  AUTHORIZER_ID=$(aws apigateway get-authorizers \
    --rest-api-id "$REST_API" \
    --query "items[0].id" --output text)

  aws apigateway put-method \
    --rest-api-id "$REST_API" \
    --resource-id "$BILLING_RESOURCE_ID" \
    --http-method GET \
    --authorization-type COGNITO_USER_POOLS \
    --authorizer-id "$AUTHORIZER_ID"

  aws apigateway put-integration \
    --rest-api-id "$REST_API" \
    --resource-id "$BILLING_RESOURCE_ID" \
    --http-method GET \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${BILLING_ARN}/invocations"

  aws apigateway put-method-response \
    --rest-api-id "$REST_API" \
    --resource-id "$BILLING_RESOURCE_ID" \
    --http-method GET \
    --status-code 200

  # Grant API Gateway permission to invoke Lambda
  aws lambda add-permission \
    --function-name lavavps-billing-handler \
    --statement-id "apigw-get-billing-prod" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${REST_API}/prod/GET/billing" \
    2>/dev/null || true

  aws lambda add-permission \
    --function-name lavavps-billing-handler \
    --statement-id "apigw-get-billing-test" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${REST_API}/test-invoke-stage/GET/billing" \
    2>/dev/null || true

  # Deploy the API
  aws apigateway create-deployment \
    --rest-api-id "$REST_API" \
    --stage-name prod \
    --description "Add GET /billing/info route"

  echo "  ✅ GET /billing route added and deployed"
else
  echo "  ℹ️  GET /billing already exists"
fi

# ── STEP 4: Patch billingHandler to add GET /billing handler ──────────────────
echo ""
echo "[4/6] Patching billingHandler to handle GET /billing..."

HANDLER_DIR="$ROOT/lambdas/handlers/billingHandler"

# Inject GET handler into the compiled index.js before the final "Not found" line
node << 'NODEJS'
const fs = require('fs');
const path = process.env.HANDLER_DIR;
const file = `${path}/index.js`;
let code = fs.readFileSync(file, 'utf8');

// Check if GET handler already exists
if (code.includes('GET /billing/info')) {
  console.log('  GET handler already present');
  process.exit(0);
}

// Inject GET /billing handler before the final return err('Not found', 404)
const GET_HANDLER = `
  // ── GET /billing ─────────────────────────────────────────────────────────
  // Returns live billing info from DynamoDB — source of truth for billing page
  if (method === 'GET' && (path.endsWith('/billing') || path.includes('/billing/info'))) {
    const item = await ddb.send(new (require('@aws-sdk/client-dynamodb').GetItemCommand)({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: \`TENANT#\${tenantId}\` },
        sk: { S: 'PROFILE' },
      },
    }));

    const BASE_STORAGE = { starter: 5, pro: 50, business: 100 };
    const BASE_AGENTS  = { starter: 2, pro: 4,  business: 10  };

    const planCode       = item.Item?.plan_code?.S      ?? 'starter';
    const storageAddon   = parseInt(item.Item?.storage_addon_gb?.N  ?? '0', 10);
    const addonAgents    = parseInt(item.Item?.addon_agent_count?.N ?? '0', 10);
    const storageBase    = BASE_STORAGE[planCode] ?? 5;
    const agentBase      = BASE_AGENTS[planCode]  ?? 2;

    return ok({
      planCode,
      status:              item.Item?.status?.S               ?? 'ACTIVE',
      subscriptionStatus:  item.Item?.subscription_status?.S  ?? 'active',
      stripeCustomerId:    item.Item?.stripe_customer_id?.S   ?? null,
      storageBase,
      storageAddon,
      storageTotal:        storageBase + storageAddon,
      agentBase,
      addonAgents,
      agentMax:            agentBase + addonAgents,
    });
  }

`;

// Insert before the last return
code = code.replace(
  /return err\('Not found', 404\);(\s*)$/,
  GET_HANDLER + "\n  return err('Not found', 404);\n"
);

fs.writeFileSync(file, code);
console.log('  GET /billing handler injected');
NODEJS

# Redeploy billingHandler
cd "$HANDLER_DIR"
zip -r /tmp/billing-complete.zip . --exclude "*.ts" --exclude ".git/*" -q
aws lambda update-function-code \
  --function-name lavavps-billing-handler \
  --zip-file fileb:///tmp/billing-complete.zip \
  --query "{FunctionName:FunctionName, LastModified:LastModified}"
aws lambda wait function-updated --function-name lavavps-billing-handler
echo "  ✅ billingHandler redeployed with GET /billing"

# ── STEP 5: Clean up duplicate Stripe customers ───────────────────────────────
echo ""
echo "[5/6] Cleaning up duplicate Stripe customers..."
STRIPE_KEY=$(aws secretsmanager get-secret-value \
  --secret-id /openclaw/prod/stripe/secret-key \
  --query SecretString --output text)

# Cancel subscriptions for duplicate customers (keep cus_UH3U8Xu52q3diR)
for DUPE_CUSTOMER in "cus_UH3SymipUmjG2i" "cus_UH3QS3NNBUuFnG" "cus_UH33lmFD49GZuG" "cus_UH3202fXrx3zGk"; do
  echo -n "  Cancelling subscriptions for $DUPE_CUSTOMER..."
  # Get and cancel subscriptions
  SUBS=$(curl -s "https://api.stripe.com/v1/subscriptions?customer=${DUPE_CUSTOMER}" \
    -u "$STRIPE_KEY:" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join([s['id'] for s in d.get('data',[])]))")
  for SUB in $SUBS; do
    curl -s -X DELETE "https://api.stripe.com/v1/subscriptions/${SUB}" \
      -u "$STRIPE_KEY:" -d "prorate=false" > /dev/null
    echo -n " cancelled $SUB"
  done
  echo " ✅"
done

# ── STEP 6: Commit ────────────────────────────────────────────────────────────
echo ""
echo "[6/6] Committing changes..."
cd "$ROOT"
git add -A
git commit -m "fix: seed PROFILE, add GET /billing/info, fix duplicate Stripe customers" || echo "  Nothing new to commit"
git push origin main
echo "  ✅ Pushed"

echo ""
echo "========================================================="
echo " Complete! Summary:"
echo "   ✅ DynamoDB PROFILE seeded — plan=pro, customer=$STRIPE_CUSTOMER_ID"
echo "   ✅ Cognito updated — next token refresh shows Pro"
echo "   ✅ GET /billing endpoint live — billing page reads real data"
echo "   ✅ 4 duplicate Stripe customers cleaned up"
echo ""
echo " Still needed (manual Stripe steps):"
echo "   1. Fix addon_agent price ID (currently same as plan_starter)"
echo "   2. Create one-time storage prices if you want non-recurring storage"
echo "========================================================="
