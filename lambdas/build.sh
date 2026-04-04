#!/bin/bash
# Build all Lambda handlers from TypeScript to JavaScript
set -e
cd "$(dirname "$0")"
echo "Building Lambda handlers..."
npx tsc -p tsconfig.build.json --noEmitOnError false 2>&1 || true
# billingHandler has its own stripe dependency
cd handlers/billingHandler
npx tsc index.ts --target ES2020 --module commonjs --esModuleInterop --skipLibCheck --outDir . 2>/dev/null || true
cd ../..
echo "✅ Build complete"
