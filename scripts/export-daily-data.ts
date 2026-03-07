/**
 * Exports historical data from the SQLite database to a JSON file
 * in data-feed/ for desktop exe users to import on startup.
 *
 * Run from the Pi after market close (scheduled by the scheduler cron).
 * Usage: npx tsx scripts/export-daily-data.ts
 */

import path from "path";
import fs from "fs";
import { initDatabase, getDb } from "../src/services/database";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(PROJECT_ROOT, "data", "wsb.db");
const FEED_PATH = path.join(PROJECT_ROOT, "data-feed", "historical.json");

interface HistoricalEntry {
  date: string;
  wsb_sentiment: string;
  inverse_recommendation: string;
  spy_open: number | null;
  spy_close: number | null;
  spy_change: number | null;
  inverse_correct: number | null;
}

interface SentimentEntry {
  date: string;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
  total_comments: number;
  bullish_percent: number;
  bearish_percent: number;
  neutral_percent: number;
  recommendation: string;
  thread_type: string;
}

function exportData(): void {
  initDatabase(DB_PATH);

  const historical = getDb()
    .prepare(
      `SELECT date, wsb_sentiment, inverse_recommendation, spy_open, spy_close, spy_change, inverse_correct
       FROM historical
       WHERE wsb_sentiment != 'unknown'
       ORDER BY date ASC`,
    )
    .all() as HistoricalEntry[];

  const sentiment = getDb()
    .prepare(
      `SELECT date, bullish_count, bearish_count, neutral_count, total_comments,
              bullish_percent, bearish_percent, neutral_percent, recommendation, thread_type
       FROM daily_sentiment
       ORDER BY date ASC`,
    )
    .all() as SentimentEntry[];

  const feed = {
    updated_at: new Date().toISOString(),
    entries: historical,
    sentiment,
  };

  fs.mkdirSync(path.dirname(FEED_PATH), { recursive: true });
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));

  console.log(`Exported ${historical.length} historical + ${sentiment.length} sentiment entries to ${FEED_PATH}`);
}

exportData();
