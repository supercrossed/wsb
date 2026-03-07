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

interface FeedEntry {
  date: string;
  wsb_sentiment: string;
  inverse_recommendation: string;
  spy_open: number | null;
  spy_close: number | null;
  spy_change: number | null;
  inverse_correct: number | null;
}

function exportData(): void {
  initDatabase(DB_PATH);

  const rows = getDb()
    .prepare(
      `SELECT date, wsb_sentiment, inverse_recommendation, spy_open, spy_close, spy_change, inverse_correct
       FROM historical
       WHERE wsb_sentiment != 'unknown'
       ORDER BY date ASC`,
    )
    .all() as FeedEntry[];

  const feed = {
    updated_at: new Date().toISOString(),
    entries: rows,
  };

  fs.mkdirSync(path.dirname(FEED_PATH), { recursive: true });
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));

  console.log(`Exported ${rows.length} historical entries to ${FEED_PATH}`);
}

exportData();
