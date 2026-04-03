#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# push-openclaw.sh
#
# Pulls the official OpenClaw image from GitHub Container Registry,
# re-tags it, and pushes it to LavaVPS ECR.
#
# Run this once during Phase 3 (RuntimeStack deployment) and again
# whenever you upgrade the OpenClaw version.
#
# Usage:
#   ./scripts/push-openclaw.sh                    # uses version from script
#   OPENCLAW_VERSION=2026.4.1 ./scripts/push-openclaw.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ACCOUNT="914964735635"
REGION="us-east-1"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.4.2}"
ECR_REPO="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/lavavps-openclaw"

echo "→ OpenClaw version: ${OPENCLAW_VERSION}"
echo "→ ECR repository:   ${ECR_REPO}"
echo ""

# Authenticate Docker to ECR
echo "→ Authenticating to ECR..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

# Pull official image from GitHub Container Registry
echo "→ Pulling ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}..."
docker pull "ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}"

# Build our custom image (adds health check and platform defaults)
echo "→ Building LavaVPS image..."
docker build \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
  --platform linux/amd64 \
  -t "${ECR_REPO}:${OPENCLAW_VERSION}" \
  -f docker/openclaw/Dockerfile \
  .

# Push to ECR
echo "→ Pushing to ECR..."
docker push "${ECR_REPO}:${OPENCLAW_VERSION}"

echo ""
echo "✓ Successfully pushed: ${ECR_REPO}:${OPENCLAW_VERSION}"
echo ""
echo "Next step: Update infra/lib/config.ts openclawVersion and deploy RuntimeStack."
