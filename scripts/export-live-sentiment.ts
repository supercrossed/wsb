/**
 * Exports live sentiment snapshot for client sync.
 *
 * Produces data-feed/sentiment-live.json containing:
 *   - Time-decayed sentiment counts (what the trade engine uses)
 *   - Trade signals for both WSB and inverse modes
 *   - Current daily sentiment summary
 *   - Timestamp for freshness checking
 *
 * Run on a cron from the Pi every 30 minutes during market hours,
 * then pushed to GitHub so all clients can fetch it.
 *
 * Usage: npx tsx scripts/export-live-sentiment.ts
 */

import path from "path";
import fs from "fs";
import { initDatabase, getDb, getTimeDecayedSentiment } from "../src/services/database";
import { getInverseRecommendation } from "../src/services/sentiment";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(PROJECT_ROOT, "data", "wsb.db");
const FEED_PATH = path.join(PROJECT_ROOT, "data-feed", "sentiment-live.json");

interface LiveSentimentFeed {
  updated_at: string;
  /** Time-decayed weighted counts (same algo as trade engine) */
  decayed: {
    bullish: number;
    bearish: number;
    neutral: number;
    rawTotal: number;
    bullishPercent: number;
    bearishPercent: number;
  };
  /** Trade signals derived from decayed sentiment */
  signals: {
    wsb: "CALLS" | "PUTS" | "HOLD";
    inverse: "CALLS" | "PUTS" | "HOLD";
  };
  /** Current day's raw (non-decayed) daily sentiment from DB */
  daily: {
    date: string;
    bullishCount: number;
    bearishCount: number;
    neutralCount: number;
    totalComments: number;
    bullishPercent: number;
    bearishPercent: number;
    recommendation: string;
    threadType: string;
  } | null;
}

function getWsbSignal(bullishPct: number, bearishPct: number): "CALLS" | "PUTS" | "HOLD" {
  const directional = bullishPct + bearishPct;
  if (directional === 0) return "HOLD";
  const bullRatio = (bullishPct / directional) * 100;
  const bearRatio = (bearishPct / directional) * 100;
  const spread = Math.abs(bullRatio - bearRatio);
  if (spread < 5) return "HOLD";
  return bullRatio > bearRatio ? "CALLS" : "PUTS";
}

function exportLiveSentiment(): void {
  initDatabase(DB_PATH);

  // Time-decayed sentiment (same 48h lookback as trade engine)
  const lookbackUtc = Math.floor(Date.now() / 1000) - 48 * 3600;
  const counts = getTimeDecayedSentiment(lookbackUtc);

  const total = counts.bullish + counts.bearish + counts.neutral;
  const bullishPercent = total > 0
    ? Math.round((counts.bullish / total) * 10000) / 100
    : 0;
  const bearishPercent = total > 0
    ? Math.round((counts.bearish / total) * 10000) / 100
    : 0;

  // Generate signals for both modes
  const inverseSignal = getInverseRecommendation(bullishPercent, bearishPercent);
  const wsbSignal = getWsbSignal(bullishPercent, bearishPercent);

  // Get today's raw daily sentiment
  const today = new Date().toISOString().slice(0, 10);
  const dailyRow = getDb()
    .prepare(
      `SELECT date, bullish_count, bearish_count, neutral_count, total_comments,
              bullish_percent, bearish_percent, recommendation, thread_type
       FROM daily_sentiment WHERE date = ?`,
    )
    .get(today) as {
      date: string;
      bullish_count: number;
      bearish_count: number;
      neutral_count: number;
      total_comments: number;
      bullish_percent: number;
      bearish_percent: number;
      recommendation: string;
      thread_type: string;
    } | undefined;

  const feed: LiveSentimentFeed = {
    updated_at: new Date().toISOString(),
    decayed: {
      bullish: Math.round(counts.bullish * 100) / 100,
      bearish: Math.round(counts.bearish * 100) / 100,
      neutral: Math.round(counts.neutral * 100) / 100,
      rawTotal: counts.rawTotal,
      bullishPercent,
      bearishPercent,
    },
    signals: {
      wsb: wsbSignal,
      inverse: inverseSignal,
    },
    daily: dailyRow
      ? {
          date: dailyRow.date,
          bullishCount: dailyRow.bullish_count,
          bearishCount: dailyRow.bearish_count,
          neutralCount: dailyRow.neutral_count,
          totalComments: dailyRow.total_comments,
          bullishPercent: dailyRow.bullish_percent,
          bearishPercent: dailyRow.bearish_percent,
          recommendation: dailyRow.recommendation,
          threadType: dailyRow.thread_type,
        }
      : null,
  };

  fs.mkdirSync(path.dirname(FEED_PATH), { recursive: true });
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));

  console.log(
    `Live sentiment exported: bull=${bullishPercent}% bear=${bearishPercent}% wsb=${wsbSignal} inverse=${inverseSignal} comments=${counts.rawTotal}`,
  );
}

exportLiveSentiment();
