import { logger } from "../lib/logger";
import { getDb } from "./database";

const FEED_URL =
  "https://raw.githubusercontent.com/supercrossed/wsb/master/data-feed/historical.json";

interface FeedEntry {
  date: string;
  wsb_sentiment: string;
  inverse_recommendation: string;
  spy_open: number | null;
  spy_close: number | null;
  spy_change: number | null;
  inverse_correct: number | null;
}

interface FeedData {
  updated_at: string;
  entries: FeedEntry[];
}

/**
 * Fetches the historical data feed from GitHub and imports any missing
 * or updated entries into the local SQLite database.
 */
export async function importDataFeed(): Promise<void> {
  try {
    const response = await fetch(FEED_URL);

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug("No data feed available yet on GitHub");
        return;
      }
      throw new Error(`Data feed fetch failed: ${response.status}`);
    }

    const feed = (await response.json()) as FeedData;

    if (!feed.entries || feed.entries.length === 0) {
      logger.debug("Data feed is empty");
      return;
    }

    const stmt = getDb().prepare(`
      INSERT INTO historical (date, wsb_sentiment, inverse_recommendation, spy_open, spy_close, spy_change, inverse_correct)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        wsb_sentiment = CASE WHEN excluded.wsb_sentiment != 'unknown' THEN excluded.wsb_sentiment ELSE historical.wsb_sentiment END,
        inverse_recommendation = CASE WHEN excluded.inverse_recommendation != 'HOLD' THEN excluded.inverse_recommendation ELSE historical.inverse_recommendation END,
        spy_open = COALESCE(excluded.spy_open, historical.spy_open),
        spy_close = COALESCE(excluded.spy_close, historical.spy_close),
        spy_change = COALESCE(excluded.spy_change, historical.spy_change),
        inverse_correct = COALESCE(excluded.inverse_correct, historical.inverse_correct)
    `);

    const transaction = getDb().transaction(() => {
      for (const entry of feed.entries) {
        stmt.run(
          entry.date,
          entry.wsb_sentiment,
          entry.inverse_recommendation,
          entry.spy_open,
          entry.spy_close,
          entry.spy_change,
          entry.inverse_correct,
        );
      }
    });
    transaction();

    logger.info("Data feed imported", {
      entries: feed.entries.length,
      updatedAt: feed.updated_at,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Data feed import failed", { error: message });
  }
}
