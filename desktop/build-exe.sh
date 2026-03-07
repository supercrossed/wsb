#!/usr/bin/env bash
# Build standalone .exe for WSB Inverse Sentiment Tracker
# Run from the project root: bash desktop/build-exe.sh
#
# Prerequisites:
#   npm install (with devDependencies)
#
# The native better-sqlite3.node binding is compiled against your current
# Node.js version. The pkg target must match (latest-win-x64 uses the same
# major version as your local Node).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/desktop/dist"

echo "=== Building WSB Standalone Executable ==="

# 1. Clean previous build
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# 2. Compile TypeScript (includes desktop/launcher.ts via tsconfig.desktop.json)
echo "Compiling TypeScript..."
npx tsc -p "$PROJECT_ROOT/desktop/tsconfig.desktop.json"

# 3. Package with pkg (uses latest Node version matching local install)
echo "Packaging executable..."
npx @yao-pkg/pkg "$OUT_DIR/build/desktop/launcher.js" \
  --targets latest-win-x64 \
  --output "$OUT_DIR/wsb-tracker.exe" \
  --config "$PROJECT_ROOT/desktop/pkg.json"

# 4. Copy public/ folder next to exe (Express serves static files from here)
echo "Copying public assets..."
cp -r "$PROJECT_ROOT/public" "$OUT_DIR/public"

# 5. Copy native better-sqlite3 binding next to exe
echo "Copying native SQLite binding..."
NATIVE_BINDING=$(find "$PROJECT_ROOT/node_modules/better-sqlite3/build/Release" -name "better_sqlite3.node" 2>/dev/null | head -1)
if [ -n "$NATIVE_BINDING" ]; then
  cp "$NATIVE_BINDING" "$OUT_DIR/better_sqlite3.node"
  echo "  Copied: $NATIVE_BINDING"
else
  echo "ERROR: Could not find better_sqlite3.node — the exe will not work!"
  exit 1
fi

# 6. Clean up intermediate build artifacts
rm -rf "$OUT_DIR/build"

# 7. Create a .env template
cat > "$OUT_DIR/.env.example" << 'ENVEOF'
# WSB Inverse Sentiment Tracker - Configuration
# Copy this to .env and fill in values if needed

# Server port (default: 3000)
# PORT=3000

# Reddit user agent (default: wsb-sentiment-bot/1.0.0)
# REDDIT_USER_AGENT=wsb-sentiment-bot/1.0.0
ENVEOF

echo ""
echo "=== Build Complete ==="
echo "Output: $OUT_DIR/"
echo ""
echo "  wsb-tracker.exe    - Main executable"
echo "  better_sqlite3.node - Native SQLite binding (must stay next to exe)"
echo "  public/            - Dashboard frontend"
echo "  .env.example       - Configuration template"
echo ""
echo "To distribute: zip the entire desktop/dist/ folder."
echo "Users extract and double-click wsb-tracker.exe — browser opens automatically."
