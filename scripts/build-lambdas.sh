#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-lambdas.sh — Compile TypeScript Lambda handlers to JavaScript
#
# Run this BEFORE every `cdk deploy` to ensure compiled .js matches .ts source.
# Usage: ./scripts/build-lambdas.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

HANDLERS_DIR="$(cd "$(dirname "$0")/.." && pwd)/lambdas/handlers"
FAILED=()

echo "Building Lambda handlers..."
echo "Handlers dir: $HANDLERS_DIR"
echo ""

for handler_dir in "$HANDLERS_DIR"/*/; do
  handler_name=$(basename "$handler_dir")

  # Skip if no index.ts present
  if [ ! -f "$handler_dir/index.ts" ]; then
    echo "  ⏭  $handler_name — no index.ts, skipping"
    continue
  fi

  echo -n "  🔨 $handler_name ... "

  # If handler has its own tsconfig, use it; else use root tsconfig
  if [ -f "$handler_dir/tsconfig.json" ]; then
    tsconfig="$handler_dir/tsconfig.json"
  else
    tsconfig="$(cd "$(dirname "$0")/.." && pwd)/tsconfig.json"
  fi

  # Compile TypeScript to JavaScript in-place
  if npx tsc \
    --project "$tsconfig" \
    --rootDir "$handler_dir" \
    --outDir "$handler_dir" \
    --module commonjs \
    --target es2020 \
    --esModuleInterop true \
    --skipLibCheck true \
    --noEmit false \
    "$handler_dir/index.ts" 2>/dev/null; then
    echo "✅"
  else
    echo "❌ FAILED"
    FAILED+=("$handler_name")
  fi
done

echo ""

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "❌ Build failed for: ${FAILED[*]}"
  echo "   Fix TypeScript errors before deploying."
  exit 1
else
  echo "✅ All handlers compiled successfully."
  echo "   Safe to run: npx cdk deploy"
fi
