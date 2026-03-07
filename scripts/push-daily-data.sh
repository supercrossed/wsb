#!/usr/bin/env bash
# Exports historical data and pushes to GitHub so exe users can import it.
# Called by the scheduler cron or manually: bash scripts/push-daily-data.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# Export data from DB to JSON
npx tsx scripts/export-daily-data.ts

# Check if anything changed
if git diff --quiet data-feed/historical.json 2>/dev/null; then
  echo "No changes to historical data, skipping push."
  exit 0
fi

# Commit and push
git add data-feed/historical.json
git commit -m "chore: update daily historical data feed $(date +%Y-%m-%d)"
git push

echo "Daily data feed pushed to GitHub."
