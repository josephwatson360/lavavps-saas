#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap.sh
#
# One-time setup for the LavaVPS AWS environment.
# Run this ONCE before your first `cdk deploy`.
#
# What it does:
#   1. CDK bootstrap (creates CDKToolkit stack in us-east-1)
#   2. Verifies AWS credentials
#   3. Requests ACM wildcard certificate for *.lavavps.ai and *.lavavps.com
#   4. Prints next steps
#
# Prerequisites:
#   - AWS CLI configured (aws sts get-caller-identity should work)
#   - Node.js 22+ and CDK installed (cdk --version)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ACCOUNT="914964735635"
REGION="us-east-1"

echo "╔══════════════════════════════════════════════════════╗"
echo "║         LavaVPS Environment Bootstrap                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Verify credentials ───────────────────────────────────────────────────────
echo "→ Verifying AWS credentials..."
CALLER=$(aws sts get-caller-identity --output json)
ACTUAL_ACCOUNT=$(echo "${CALLER}" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")

if [ "${ACTUAL_ACCOUNT}" != "${ACCOUNT}" ]; then
  echo "✗ Wrong account! Expected ${ACCOUNT}, got ${ACTUAL_ACCOUNT}"
  echo "  Run: aws configure  or  export AWS_PROFILE=your-profile"
  exit 1
fi
echo "✓ Authenticated to account ${ACTUAL_ACCOUNT}"
echo ""

# ── CDK Bootstrap ────────────────────────────────────────────────────────────
echo "→ Bootstrapping CDK in ${ACCOUNT}/${REGION}..."
echo "  (This creates the CDKToolkit CloudFormation stack — safe to re-run)"
npx cdk bootstrap "aws://${ACCOUNT}/${REGION}" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
echo "✓ CDK bootstrap complete"
echo ""

# ── Install npm dependencies ─────────────────────────────────────────────────
echo "→ Installing npm dependencies..."
npm install
echo "✓ Dependencies installed"
echo ""

# ── Request ACM Certificates ─────────────────────────────────────────────────
echo "→ Requesting ACM wildcard certificates..."
echo "  Certificate for *.lavavps.ai and lavavps.ai"

CERT_AI=$(aws acm request-certificate \
  --domain-name "lavavps.ai" \
  --subject-alternative-names "*.lavavps.ai" \
  --validation-method DNS \
  --region "${REGION}" \
  --output text \
  --query CertificateArn \
  2>/dev/null || echo "ALREADY_EXISTS")

if [ "${CERT_AI}" = "ALREADY_EXISTS" ]; then
  echo "  ℹ lavavps.ai certificate may already exist — check ACM console"
else
  echo "  ✓ lavavps.ai cert requested: ${CERT_AI}"
fi

CERT_COM=$(aws acm request-certificate \
  --domain-name "lavavps.com" \
  --subject-alternative-names "*.lavavps.com" \
  --validation-method DNS \
  --region "${REGION}" \
  --output text \
  --query CertificateArn \
  2>/dev/null || echo "ALREADY_EXISTS")

if [ "${CERT_COM}" = "ALREADY_EXISTS" ]; then
  echo "  ℹ lavavps.com certificate may already exist — check ACM console"
else
  echo "  ✓ lavavps.com cert requested: ${CERT_COM}"
fi
echo ""

# ── Synth check ──────────────────────────────────────────────────────────────
echo "→ Running cdk synth to verify stacks compile..."
npx cdk synth --quiet
echo "✓ CDK synth successful — stacks are valid"
echo ""

echo "╔══════════════════════════════════════════════════════╗"
echo "║                   Next Steps                         ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  1. VALIDATE ACM CERTIFICATES (required before ALB)  ║"
echo "║     → AWS Console → ACM → Certificates              ║"
echo "║     → Click each certificate → Add DNS records       ║"
echo "║     → Route 53 will auto-validate (5–30 minutes)    ║"
echo "║                                                      ║"
echo "║  2. DEPLOY PHASE 1 STACKS                           ║"
echo "║     npm run deploy:network                           ║"
echo "║     npm run deploy:security                          ║"
echo "║                                                      ║"
echo "║  3. NOTE YOUR NAT GATEWAY IP                        ║"
echo "║     AWS Console → EC2 → Elastic IPs                 ║"
echo "║     Save this IP for Discord/Telegram allowlisting  ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
