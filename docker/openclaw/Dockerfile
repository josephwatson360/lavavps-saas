# ─────────────────────────────────────────────────────────────────────────────
# LavaVPS OpenClaw Agent Container
#
# Extends the official OpenClaw image with platform-specific configuration.
# Version is pinned — update Config.openclawVersion in infra/lib/config.ts
# and rebuild when upgrading.
#
# IMPORTANT: This image is built and pushed to ECR via scripts/push-openclaw.sh
# Never use :latest — always use exact version tags.
# ─────────────────────────────────────────────────────────────────────────────

ARG OPENCLAW_VERSION=2026.4.2
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

# ── Runtime user ──────────────────────────────────────────────────────────────
# OpenClaw runs as UID 1000 (node user) — matches EFS Access Point POSIX config.
# DO NOT change this. The EFS Access Point uid=1000 is locked in the CDK stack.
USER node

# ── Environment defaults ──────────────────────────────────────────────────────
# These are overridden at task definition level in ECS.
# Shown here for documentation purposes.
ENV NODE_ENV=production
ENV OPENCLAW_GATEWAY_BIND=lan
ENV OPENCLAW_GATEWAY_PORT=18789

# ── Health check ──────────────────────────────────────────────────────────────
# ECS uses /healthz for liveness. ALB uses /readyz for readiness.
# Both are built into OpenClaw — no additional configuration needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${OPENCLAW_GATEWAY_PORT}/healthz || exit 1

# ── No extra binaries needed for initial deployment ───────────────────────────
# WhatsApp integration uses Meta Cloud API (pure HTTP, no browser automation).
# Discord and Telegram are lightweight API clients built into OpenClaw.
#
# If future skills require additional binaries, add them here:
# RUN apt-get update && apt-get install -y <package> && rm -rf /var/lib/apt/lists/*
# ─────────────────────────────────────────────────────────────────────────────

# Entry point is inherited from base image.
# ECS task definition sets the command override:
#   ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
