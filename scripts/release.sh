#!/usr/bin/env bash
# =============================================================================
# WSB Release Script
# =============================================================================
#
# Usage:
#   bash scripts/release.sh <version> "<changelog message>"
#
# Example:
#   bash scripts/release.sh 1.1.0 "Added ticker heatmap, fixed weekend thread detection"
#
# What this script does:
#   1. Validates inputs and checks for clean git state
#   2. Builds the standalone Windows exe
#   3. Zips the distributable files
#   4. Updates CHANGELOG.md with the new version entry
#   5. Bumps version in package.json
#   6. Commits, tags, and pushes
#   7. Creates a GitHub release with the zip attached
#
# Prerequisites:
#   - npm install (with devDependencies)
#   - gh CLI installed and authenticated (gh auth login)
# =============================================================================

set -euo pipefail

GH_CLI="/c/Program Files/GitHub CLI/gh.exe"

# --- Validate inputs ---
if [ $# -lt 2 ]; then
  echo "Usage: bash scripts/release.sh <version> \"<changelog message>\""
  echo "Example: bash scripts/release.sh 1.1.0 \"Added ticker heatmap, fixed weekend thread\""
  exit 1
fi

VERSION="$1"
CHANGELOG_MSG="$2"
TAG="v${VERSION}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/desktop/dist"
ZIP_NAME="wsb-tracker-${TAG}-win-x64.zip"
ZIP_PATH="$PROJECT_ROOT/desktop/${ZIP_NAME}"

# --- Preflight checks ---
echo "=== WSB Release ${TAG} ==="
echo ""

# Check gh CLI
if [ ! -f "$GH_CLI" ]; then
  echo "ERROR: GitHub CLI not found at $GH_CLI"
  echo "Install from: https://cli.github.com/"
  exit 1
fi

# Check gh auth
if ! "$GH_CLI" auth status &>/dev/null; then
  echo "ERROR: Not logged into GitHub CLI. Run: gh auth login"
  exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: You have uncommitted changes. Commit or stash them first."
  git status --short
  exit 1
fi

# Check tag doesn't already exist
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "ERROR: Tag $TAG already exists. Choose a different version."
  exit 1
fi

echo "Version:   ${VERSION}"
echo "Tag:       ${TAG}"
echo "Changelog: ${CHANGELOG_MSG}"
echo ""

# --- Step 1: Build the exe ---
echo "=== Step 1/6: Building standalone exe ==="
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Compile TypeScript
npx tsc -p "$PROJECT_ROOT/desktop/tsconfig.desktop.json"

# Package with pkg
npx @yao-pkg/pkg "$OUT_DIR/build/desktop/launcher.js" \
  --targets latest-win-x64 \
  --output "$OUT_DIR/wsb-tracker.exe" \
  --config "$PROJECT_ROOT/desktop/pkg.json"

# Copy public assets
cp -r "$PROJECT_ROOT/public" "$OUT_DIR/public"

# Copy native SQLite binding
NATIVE_BINDING=$(find "$PROJECT_ROOT/node_modules/better-sqlite3/build/Release" -name "better_sqlite3.node" 2>/dev/null | head -1)
if [ -z "$NATIVE_BINDING" ]; then
  echo "ERROR: Could not find better_sqlite3.node"
  exit 1
fi
cp "$NATIVE_BINDING" "$OUT_DIR/better_sqlite3.node"

# Create .env.example
cat > "$OUT_DIR/.env.example" << 'ENVEOF'
# WSB Inverse Sentiment Tracker - Configuration
# Copy this to .env and fill in values if needed

# Server port (default: 3000)
# PORT=3000

# Reddit user agent (default: wsb-sentiment-bot/1.0.0)
# REDDIT_USER_AGENT=wsb-sentiment-bot/1.0.0
ENVEOF

# Clean up build artifacts
rm -rf "$OUT_DIR/build"

echo "  Exe built successfully"

# --- Step 2: Create zip ---
echo "=== Step 2/6: Creating release zip ==="
rm -f "$ZIP_PATH"
cd "$OUT_DIR"
powershell.exe -Command "Compress-Archive -Path './*' -DestinationPath '$(cygpath -w "$ZIP_PATH")' -Force"
cd "$PROJECT_ROOT"
echo "  Created: ${ZIP_NAME} ($(du -h "$ZIP_PATH" | cut -f1))"

# --- Step 3: Update CHANGELOG.md ---
echo "=== Step 3/6: Updating CHANGELOG.md ==="
RELEASE_DATE=$(date +%Y-%m-%d)

if [ ! -f "$PROJECT_ROOT/CHANGELOG.md" ]; then
  cat > "$PROJECT_ROOT/CHANGELOG.md" << 'HEADER'
# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

HEADER
fi

# Insert new entry after the header
ENTRY="## [${VERSION}] - ${RELEASE_DATE}\n\n${CHANGELOG_MSG}\n"

# Use sed to insert after the last blank line following the header
sed -i "/^Format based on/a\\
\\
${ENTRY}" "$PROJECT_ROOT/CHANGELOG.md"

echo "  Added ${TAG} entry to CHANGELOG.md"

# --- Step 4: Bump version in package.json ---
echo "=== Step 4/6: Bumping version to ${VERSION} ==="
cd "$PROJECT_ROOT"
npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null
echo "  package.json version set to ${VERSION}"

# --- Step 5: Commit, tag, and push ---
echo "=== Step 5/6: Committing and pushing ==="
git add package.json package-lock.json CHANGELOG.md
git commit -m "$(cat <<EOF
chore: release ${TAG}

${CHANGELOG_MSG}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
git tag "$TAG"
git push
git push origin "$TAG"
echo "  Pushed commit and tag ${TAG}"

# --- Step 6: Create GitHub release ---
echo "=== Step 6/6: Creating GitHub release ==="
"$GH_CLI" release create "$TAG" \
  "$ZIP_PATH" \
  --title "${TAG} — WSB Inverse Sentiment Tracker" \
  --notes "$(cat <<EOF
## Changes

${CHANGELOG_MSG}

## Download

Download \`${ZIP_NAME}\`, extract to any folder, and double-click \`wsb-tracker.exe\`.
Dashboard opens automatically at http://localhost:3000.

**Contents:**
- \`wsb-tracker.exe\` — Main executable (includes Node.js runtime)
- \`better_sqlite3.node\` — Native SQLite binding (keep next to exe)
- \`public/\` — Dashboard frontend files
- \`.env.example\` — Optional configuration
EOF
)"

echo ""
echo "=== Release ${TAG} complete! ==="
echo "  GitHub: https://github.com/supercrossed/wsb/releases/tag/${TAG}"
echo "  Zip:    ${ZIP_NAME}"
