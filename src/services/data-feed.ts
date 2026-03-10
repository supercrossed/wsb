import { logger } from "../lib/logger";
import { getDb } from "./database";

const FEED_URL =
  "https://raw.githubusercontent.com/supercrossed/wsb/master/data-feed/historical.json";

const LIVE_FEED_URL =
  "https://raw.githubusercontent.com/supercrossed/wsb/master/data-feed/sentiment-live.json";

interface FeedEntry {
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

interface FeedData {
  updated_at: string;
  entries: FeedEntry[];
  sentiment?: SentimentEntry[];
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

      if (feed.sentiment && feed.sentiment.length > 0) {
        // Only backfill past sentiment — never overwrite current/future dates
        // which are actively being computed from live comment data
        const sentimentStmt = getDb().prepare(`
          INSERT INTO daily_sentiment (date, bullish_count, bearish_count, neutral_count, total_comments,
            bullish_percent, bearish_percent, neutral_percent, recommendation, thread_type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(date) DO NOTHING
        `);

        for (const s of feed.sentiment) {
          sentimentStmt.run(
            s.date,
            s.bullish_count,
            s.bearish_count,
            s.neutral_count,
            s.total_comments,
            s.bullish_percent,
            s.bearish_percent,
            s.neutral_percent,
            s.recommendation,
            s.thread_type,
          );
        }
      }
    });
    transaction();

    logger.info("Data feed imported", {
      historical: feed.entries.length,
      sentiment: feed.sentiment?.length ?? 0,
      updatedAt: feed.updated_at,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Data feed import failed", { error: message });
  }
}

interface LiveSentimentFeed {
  updated_at: string;
  decayed: {
    bullish: number;
    bearish: number;
    neutral: number;
    rawTotal: number;
    bullishPercent: number;
    bearishPercent: number;
  };
  signals: {
    wsb: "CALLS" | "PUTS" | "HOLD";
    inverse: "CALLS" | "PUTS" | "HOLD";
  };
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

/**
 * Fetches the live sentiment snapshot from GitHub.
 * Clients use this to get synced trade signals without collecting
 * their own Reddit comments.
 */
export async function importLiveSentiment(): Promise<LiveSentimentFeed | null> {
  try {
    const response = await fetch(LIVE_FEED_URL);

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug("No live sentiment feed available yet on GitHub");
        return null;
      }
      throw new Error(`Live feed fetch failed: ${response.status}`);
    }

    const feed = (await response.json()) as LiveSentimentFeed;

    // Backfill daily sentiment if we have it and our DB doesn't
    if (feed.daily) {
      const existing = getDb()
        .prepare("SELECT 1 FROM daily_sentiment WHERE date = ?")
        .get(feed.daily.date);

      if (!existing) {
        getDb()
          .prepare(
            `INSERT INTO daily_sentiment (date, bullish_count, bearish_count, neutral_count, total_comments,
              bullish_percent, bearish_percent, neutral_percent, recommendation, thread_type, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          )
          .run(
            feed.daily.date,
            feed.daily.bullishCount,
            feed.daily.bearishCount,
            feed.daily.neutralCount,
            feed.daily.totalComments,
            feed.daily.bullishPercent,
            feed.daily.bearishPercent,
            feed.daily.recommendation,
            feed.daily.threadType,
          );
      }
    }

    logger.info("Live sentiment imported", {
      wsbSignal: feed.signals.wsb,
      inverseSignal: feed.signals.inverse,
      rawComments: feed.decayed.rawTotal,
      updatedAt: feed.updated_at,
    });

    return feed;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Live sentiment import failed", { error: message });
    return null;
  }
}
