#!/usr/bin/env bash
# Exports live sentiment snapshot and pushes to GitHub.
# Clients fetch from GitHub's raw CDN for synced signals.
# Called by the scheduler cron every 30 min during market hours.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# Export live sentiment from DB to JSON
npx tsx scripts/export-live-sentiment.ts

# Stage the file
git add data-feed/sentiment-live.json

# Check if anything changed
if git diff --cached --quiet; then
  echo "No sentiment changes, skipping push."
  exit 0
fi

# Commit and push
git commit -m "chore: update live sentiment $(date +%Y-%m-%dT%H:%M)"
git push

echo "Live sentiment pushed to GitHub."
