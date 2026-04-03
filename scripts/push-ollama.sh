#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# push-ollama.sh
#
# Builds a custom Ollama image with llama3.2:1b baked in (no cold-start
# model download) and pushes it to LavaVPS ECR.
#
# Run this once after RuntimeStack deploys, before Ollama ECS service starts.
# The image is large (~2GB) - this will take 5-10 minutes on first push.
#
# Usage:
#   ./scripts/push-ollama.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ACCOUNT="914964735635"
REGION="us-east-1"
ECR_REPO="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/lavavps-ollama"
TAG="latest-llama3"

echo "-> Building Ollama image with pre-baked llama3.2:1b..."
echo "   ECR: ${ECR_REPO}:${TAG}"
echo "   This takes 5-10 minutes (model download + layer push)"
echo ""

# Authenticate to ECR
echo "-> Authenticating to ECR..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

# Build image with model baked in
echo "-> Building image..."
docker build \
  --platform linux/amd64 \
  -t "${ECR_REPO}:${TAG}" \
  -f docker/ollama/Dockerfile \
  docker/ollama/

# Push to ECR
echo "-> Pushing to ECR (~2GB, please wait)..."
docker push "${ECR_REPO}:${TAG}"

echo ""
echo "Done: ${ECR_REPO}:${TAG}"
echo ""
echo "Next: The Ollama ECS service will pull this image automatically."
echo "      Monitor: aws ecs describe-services --cluster lavavps-agents --services lavavps-ollama"
