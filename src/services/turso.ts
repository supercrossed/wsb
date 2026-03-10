/**
 * Turso (libSQL) cloud database for syncing sentiment data across clients.
 *
 * Architecture:
 *   - Pi (writer): dual-writes sentiment to local SQLite + Turso
 *   - Clients (readers): read from Turso when local comment data is insufficient
 *
 * Turso is optional. If TURSO_DATABASE_URL is not set, all functions are no-ops.
 */

import { createClient, type Client } from "@libsql/client";
import { logger } from "../lib/logger";

let tursoClient: Client | null = null;

/**
 * Initializes the Turso client if env vars are configured.
 * Call at startup; safe to call multiple times.
 */
export function initTurso(): Client | null {
  if (tursoClient) return tursoClient;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    logger.debug("Turso not configured (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing)");
    return null;
  }

  tursoClient = createClient({ url, authToken });
  logger.info("Turso client initialized", { url: url.split("//")[1]?.split(".")[0] });
  return tursoClient;
}

/**
 * Returns the Turso client or null if not configured.
 */
export function getTurso(): Client | null {
  return tursoClient;
}

/**
 * Creates the remote tables if they don't exist.
 * Only the Pi (writer) needs to call this.
 */
export async function initTursoSchema(): Promise<void> {
  const client = getTurso();
  if (!client) return;

  try {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS daily_sentiment (
        date TEXT PRIMARY KEY,
        bullish_count INTEGER NOT NULL,
        bearish_count INTEGER NOT NULL,
        neutral_count INTEGER NOT NULL,
        total_comments INTEGER NOT NULL,
        raw_comment_count INTEGER NOT NULL DEFAULT 0,
        bullish_percent REAL NOT NULL,
        bearish_percent REAL NOT NULL,
        neutral_percent REAL NOT NULL,
        recommendation TEXT NOT NULL,
        thread_type TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS live_signal (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        updated_at TEXT NOT NULL,
        decayed_bullish REAL NOT NULL,
        decayed_bearish REAL NOT NULL,
        decayed_neutral REAL NOT NULL,
        raw_total INTEGER NOT NULL,
        bullish_percent REAL NOT NULL,
        bearish_percent REAL NOT NULL,
        wsb_signal TEXT NOT NULL,
        inverse_signal TEXT NOT NULL
      )`,
    ]);
    logger.info("Turso schema initialized");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Turso schema init failed", { error: message });
  }
}

/**
 * Writes daily sentiment to Turso (called by the Pi after each poll cycle).
 */
export async function syncDailySentimentToTurso(sentiment: {
  date: string;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  totalComments: number;
  rawCommentCount: number;
  bullishPercent: number;
  bearishPercent: number;
  neutralPercent: number;
  recommendation: string;
  threadType: string;
}): Promise<void> {
  const client = getTurso();
  if (!client) return;

  try {
    await client.execute({
      sql: `INSERT OR REPLACE INTO daily_sentiment
            (date, bullish_count, bearish_count, neutral_count, total_comments,
             raw_comment_count, bullish_percent, bearish_percent, neutral_percent,
             recommendation, thread_type, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        sentiment.date,
        sentiment.bullishCount,
        sentiment.bearishCount,
        sentiment.neutralCount,
        sentiment.totalComments,
        sentiment.rawCommentCount,
        sentiment.bullishPercent,
        sentiment.bearishPercent,
        sentiment.neutralPercent,
        sentiment.recommendation,
        sentiment.threadType,
      ],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Turso daily sentiment sync failed", { error: message });
  }
}

/**
 * Writes the live trade signal to Turso (called by the Pi after each poll cycle).
 */
export async function syncLiveSignalToTurso(signal: {
  decayedBullish: number;
  decayedBearish: number;
  decayedNeutral: number;
  rawTotal: number;
  bullishPercent: number;
  bearishPercent: number;
  wsbSignal: string;
  inverseSignal: string;
}): Promise<void> {
  const client = getTurso();
  if (!client) return;

  try {
    await client.execute({
      sql: `INSERT OR REPLACE INTO live_signal
            (id, updated_at, decayed_bullish, decayed_bearish, decayed_neutral,
             raw_total, bullish_percent, bearish_percent, wsb_signal, inverse_signal)
            VALUES (1, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        signal.decayedBullish,
        signal.decayedBearish,
        signal.decayedNeutral,
        signal.rawTotal,
        signal.bullishPercent,
        signal.bearishPercent,
        signal.wsbSignal,
        signal.inverseSignal,
      ],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Turso live signal sync failed", { error: message });
  }
}

/**
 * Reads the live trade signal from Turso (used by clients).
 */
export async function fetchLiveSignalFromTurso(): Promise<{
  updatedAt: string;
  decayedBullish: number;
  decayedBearish: number;
  decayedNeutral: number;
  rawTotal: number;
  bullishPercent: number;
  bearishPercent: number;
  wsbSignal: string;
  inverseSignal: string;
} | null> {
  const client = getTurso();
  if (!client) return null;

  try {
    const result = await client.execute("SELECT * FROM live_signal WHERE id = 1");
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      updatedAt: row.updated_at as string,
      decayedBullish: row.decayed_bullish as number,
      decayedBearish: row.decayed_bearish as number,
      decayedNeutral: row.decayed_neutral as number,
      rawTotal: row.raw_total as number,
      bullishPercent: row.bullish_percent as number,
      bearishPercent: row.bearish_percent as number,
      wsbSignal: row.wsb_signal as string,
      inverseSignal: row.inverse_signal as string,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Turso live signal fetch failed", { error: message });
    return null;
  }
}

/**
 * Reads daily sentiment history from Turso (used by clients for backfill).
 */
export async function fetchSentimentHistoryFromTurso(
  days: number,
): Promise<
  Array<{
    date: string;
    bullishCount: number;
    bearishCount: number;
    neutralCount: number;
    totalComments: number;
    bullishPercent: number;
    bearishPercent: number;
    recommendation: string;
    threadType: string;
  }>
> {
  const client = getTurso();
  if (!client) return [];

  try {
    const result = await client.execute({
      sql: `SELECT * FROM daily_sentiment ORDER BY date DESC LIMIT ?`,
      args: [days],
    });

    return result.rows.map((row) => ({
      date: row.date as string,
      bullishCount: row.bullish_count as number,
      bearishCount: row.bearish_count as number,
      neutralCount: row.neutral_count as number,
      totalComments: row.total_comments as number,
      bullishPercent: row.bullish_percent as number,
      bearishPercent: row.bearish_percent as number,
      recommendation: row.recommendation as string,
      threadType: row.thread_type as string,
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Turso sentiment history fetch failed", { error: message });
    return [];
  }
}
