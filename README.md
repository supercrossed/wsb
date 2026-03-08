# WSB Inverse Sentiment Tracker

A real-time sentiment analysis tool that monitors r/wallstreetbets and recommends the **inverse** of whatever WSB is feeling. Because WSB is (almost) always wrong.

Runs on an Orange Pi Zero 2 and serves a dashboard on your local network.

![Dashboard](docs/dashboard.png)

## How It Works

1. **Polls Reddit every 60 seconds** — fetches comments from the active WSB discussion thread (daily, overnight, or weekend) plus the top 10 hot posts and their comments
2. **Analyzes sentiment** using a seven-layer system:
   - `sentiment` NLP library for full-sentence analysis
   - 60+ WSB-specific phrase patterns (context-aware, e.g. "my puts about to rip" = bearish, "bers r fuk" = bullish)
   - WSB degen slang: bers/bols/buls misspellings, thundercock, joever, cooked, mocking patterns
   - Emoji scoring (rocket, bear, diamond hands, etc.)
   - Sarcasm detection (16 patterns like "what could go wrong", "this is fine", "/s" — inverts weak signals, discards ambiguous ones)
   - Temporal awareness (10 past-tense patterns like "expired worthless" — discounts by 70%)
   - Question-form detection (dampens questions that aren't directional opinions)
   - Financial relevance gating (non-financial NLP-only comments discarded to avoid noise)
3. **Tracks SPY prices** — fetches daily SPY data from Yahoo Finance, overlays on sentiment charts, and computes inverse strategy accuracy
4. **Recommends the inverse** — if WSB is bullish, it says PUTS. If bearish, CALLS. With entertaining taglines.

## Dashboard

- Real-time bullish vs bearish doughnut chart (neutral excluded)
- Animated sentiment bar with green-to-red gradient
- CALLS / PUTS / HOLD recommendation with glowing neon UI and WSB-style taglines
- Live SPY price ticker with daily change
- 90-day historical sentiment trend with SPY price overlay
- Inverse strategy accuracy tracking with cumulative win rate

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sentiment/today` | GET | Today's aggregated sentiment and recommendation |
| `/api/sentiment/history?days=90` | GET | Rolling sentiment history |
| `/api/historical?days=90` | GET | Historical entries with SPY outcomes |
| `/api/live-counts` | GET | Real-time bullish/bearish/neutral counts |
| `/api/top-posts` | GET | Today's top 10 WSB posts with sentiment |
| `/api/spy/today` | GET | Current SPY price and daily change |
| `/api/spy/history?days=90` | GET | SPY prices from historical table |
| `/api/status` | GET | App status and config info |
| `/api/poll` | POST | Manually trigger a poll cycle |

## Tech Stack

- **Runtime:** Node.js 20+ with TypeScript
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Web:** Express 5 serving a Chart.js dashboard
- **Reddit:** Public JSON API (no auth required)
- **Sentiment:** `sentiment` npm library + custom WSB lexicon + emoji scoring + sarcasm detection + temporal awareness + upvote weighting
- **Market Data:** Yahoo Finance public chart API (no auth required)

## Standalone Desktop App (Windows)

No Node.js or coding required. Just download and run.

1. Download the latest release zip from [Releases](https://github.com/supercrossed/wsb/releases)
2. Extract to any folder
3. Double-click `wsb-tracker.exe`
4. Dashboard opens automatically at `http://localhost:3000`

**What's in the zip:**
```
wsb-tracker.exe          # Main executable
better_sqlite3.node      # Native SQLite binding (keep next to exe)
public/                  # Dashboard frontend files
.env.example             # Optional configuration
```

The app creates a `data/` folder next to the exe for the SQLite database. All data is stored locally. To configure, copy `.env.example` to `.env`.

## Prerequisites (Developer Setup)

- Node.js 20+
- npm
- Git

## Installation

```bash
# Clone the repo
git clone https://github.com/supercrossed/wsb.git
cd wsb

# Install dependencies
npm install

# Build
npm run build

# Run
npm start
```

The dashboard will be available at `http://localhost:3000`.

## Development

```bash
# Run in dev mode with hot reload
npm run dev

# Type check
npm run typecheck
```

## Deploy to Orange Pi

SSH into your Pi and run:

```bash
# Clone the repo
git clone https://github.com/supercrossed/wsb.git
cd wsb

# Install dependencies
npm install --omit=dev

# Build
npm run build

# Run the setup script (creates systemd service + auto-updater)
bash scripts/setup-pi.sh
```

This will:
- Create a `wsb` systemd service that auto-starts on boot
- Create a timer that checks GitHub for updates every 5 minutes
- Auto-rebuild and restart the service when new commits are pushed

### Useful Commands

```bash
# Check service status
sudo systemctl status wsb

# View live logs
journalctl -u wsb -f

# Check updater timer
sudo systemctl list-timers wsb-updater.timer

# Manually restart
sudo systemctl restart wsb
```

## Building the Standalone Exe

To build the Windows exe from source (requires Node.js + npm on Windows):

```bash
npm install
bash desktop/build-exe.sh
```

Output goes to `desktop/dist/`. Zip that folder for distribution. The native `better_sqlite3.node` binding is compiled against your local Node.js version — the exe targets the same version automatically.

## Project Structure

```
src/
  api/routes.ts          # Express API endpoints
  config/index.ts        # Environment config
  lib/                   # Logger, error classes
  services/
    database.ts          # SQLite schema, queries, purge logic
    reddit.ts            # Reddit public API fetching
    scheduler.ts         # 60s poll loop, top posts, SPY backfill, sentiment aggregation
    sentiment.ts         # NLP + emoji + WSB phrase + sarcasm + temporal analysis
    spy.ts               # Yahoo Finance SPY price fetching
  types/index.ts         # TypeScript interfaces
  server.ts              # Express server
  index.ts               # Entry point
public/
  index.html             # Dashboard UI
scripts/
  setup-pi.sh            # Orange Pi deployment script
desktop/
  launcher.ts            # Standalone exe entry point
  build-exe.sh           # Build script for Windows exe
  tsconfig.desktop.json  # TypeScript config for exe build
  pkg.json               # pkg bundler config
```

## Data Retention

- **Comments:** 2 days (enough for overnight thread analysis)
- **Daily sentiment:** 90 days (dashboard history)
- **Historical records:** Forever (inverse strategy accuracy tracking + SPY prices)
- **Top posts:** 2 days

## Thread Schedule (EST)

| Thread | Active Period |
|--------|--------------|
| Daily Discussion | 7:00 AM - 3:59 PM weekdays |
| What Are Your Moves Tomorrow | 4:00 PM - 6:59 AM weekdays |
| Weekend Discussion | Friday 4:00 PM - Sunday 3:59 PM |

**Sunday transition:** At 4 PM EST on Sunday, the "What Are Your Moves Tomorrow" thread drops. The scheduler switches to overnight mode and dual-polls both the weekend and overnight threads until Monday 7 AM. All comments feed into the trade engine's 48-hour time-decay lookback.

## SPY Integration

- **Backfill:** On startup, fetches 90 days of SPY daily prices from Yahoo Finance
- **Daily update:** Cron job at 5 PM EST (after market close) refreshes prices
- **Accuracy tracking:** Each day's inverse recommendation is compared against actual SPY movement to compute a running accuracy score
- **Dashboard overlay:** SPY close prices shown as a dashed yellow line on the 90-day history chart

## Sentiment Weighting

Comments are **upvote-weighted** — a comment with 50 upvotes counts 50x more than one with 1. This lets the community's own voting amplify signal and suppress noise. The dashboard shows both the raw comment count and the weighted score.

## Debug & Testing Commands

Test the sentiment engine on any comment directly:

```bash
# Test a comment through the sentiment engine
node -e "const { analyzeSentiment } = require('./dist/services/sentiment'); console.log(JSON.stringify(analyzeSentiment('bers r fuk we mooning'), null, 2));"

# Test a multi-line comment
node -e "const { analyzeSentiment } = require('./dist/services/sentiment'); console.log(JSON.stringify(analyzeSentiment('I am permabull but we might correct soon\nwe r fuk'), null, 2));"
```

Check which thread the scheduler is polling:

```bash
# View live logs (shows thread type, comment counts, polling status)
journalctl -u wsb -f

# Check current thread detection
node -e "const { getActiveThreadType, getSecondaryThreadTypes } = require('./dist/services/reddit'); console.log('Primary:', getActiveThreadType(), 'Secondary:', getSecondaryThreadTypes());"
```

Query the database directly:

```bash
# Comment counts by thread type
node -e "const db = require('better-sqlite3')('data/wsb.db'); console.log(db.prepare('SELECT thread_type, COUNT(*) as count FROM comments GROUP BY thread_type').all());"

# Latest 20 comments with sentiment
node -e "const db = require('better-sqlite3')('data/wsb.db'); db.prepare('SELECT body, sentiment, confidence FROM comments ORDER BY created_utc DESC LIMIT 20').all().forEach(r => console.log(r.sentiment.padEnd(8), (r.confidence).toFixed(2), r.body.substring(0,80)));"

# Today's sentiment summary
node -e "const db = require('better-sqlite3')('data/wsb.db'); console.log(db.prepare('SELECT * FROM daily_sentiment ORDER BY date DESC LIMIT 1').get());"

# Check app version
node -e "console.log(require('./package.json').version);"
```

## Future

- Multi-ticker sentiment tracking beyond SPY
