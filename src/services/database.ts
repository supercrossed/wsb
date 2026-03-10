import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

import { logger } from "../lib/logger";
import { encrypt, decrypt, isEncrypted } from "../lib/crypto";
import type {
  CommentSentiment,
  CramerPick,
  DailySentiment,
  HistoricalEntry,
  RiskLevel,
  ThreadType,
  TopPost,
  TradeType,
  TradeBotConfig,
  TradeBotMode,
  TradeLog,
  TradeRound,
  TradePerformance,
  EquitySnapshot,
} from "../types";

let db: Database.Database;

export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_utc INTEGER NOT NULL,
      score INTEGER NOT NULL DEFAULT 1,
      thread_id TEXT NOT NULL,
      thread_type TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      confidence REAL NOT NULL,
      tickers TEXT NOT NULL DEFAULT '[]',
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_utc);
    CREATE INDEX IF NOT EXISTS idx_comments_thread_type ON comments(thread_type);

    CREATE TABLE IF NOT EXISTS daily_sentiment (
      date TEXT PRIMARY KEY,
      bullish_count INTEGER NOT NULL,
      bearish_count INTEGER NOT NULL,
      neutral_count INTEGER NOT NULL,
      total_comments INTEGER NOT NULL,
      bullish_percent REAL NOT NULL,
      bearish_percent REAL NOT NULL,
      neutral_percent REAL NOT NULL,
      recommendation TEXT NOT NULL,
      thread_type TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS top_posts (
      id TEXT NOT NULL,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      score INTEGER NOT NULL,
      num_comments INTEGER NOT NULL,
      created_utc INTEGER NOT NULL,
      permalink TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      confidence REAL NOT NULL,
      tickers TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_top_posts_date ON top_posts(date);

    CREATE TABLE IF NOT EXISTS historical (
      date TEXT PRIMARY KEY,
      wsb_sentiment TEXT NOT NULL,
      inverse_recommendation TEXT NOT NULL,
      spy_open REAL,
      spy_close REAL,
      spy_change REAL,
      inverse_correct INTEGER
    );

    CREATE TABLE IF NOT EXISTS cramer_picks (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      direction TEXT NOT NULL,
      raw_direction TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ticker, date, source)
    );

    CREATE INDEX IF NOT EXISTS idx_cramer_picks_date ON cramer_picks(date);

    CREATE TABLE IF NOT EXISTS tradebot_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL CHECK(mode IN ('wsb', 'inverse')),
      api_key_id TEXT NOT NULL,
      api_secret_key TEXT NOT NULL,
      paper_trading INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'safe' CHECK(risk_level IN ('safe', 'degen', 'yolo')),
      trade_type TEXT NOT NULL DEFAULT '0dte' CHECK(trade_type IN ('0dte', 'swing')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mode, paper_trading)
    );

    CREATE TABLE IF NOT EXISTS trade_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      price REAL,
      order_id TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      message TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_trade_log_timestamp ON trade_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_trade_log_mode ON trade_log(mode);

    CREATE TABLE IF NOT EXISTS trade_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      paper_trading INTEGER NOT NULL,
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      qty REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      entry_time TEXT NOT NULL,
      exit_time TEXT,
      entry_log_id INTEGER NOT NULL,
      exit_log_id INTEGER,
      exit_reason TEXT,
      pnl_dollars REAL,
      pnl_percent REAL,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE INDEX IF NOT EXISTS idx_trade_rounds_date ON trade_rounds(trade_date);
    CREATE INDEX IF NOT EXISTS idx_trade_rounds_mode ON trade_rounds(mode, paper_trading);

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      paper_trading INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      UNIQUE(mode, paper_trading, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_equity_snapshots_lookup ON equity_snapshots(mode, paper_trading, snapshot_date);
  `);

  // Migrate tradebot_config: change UNIQUE(mode) to UNIQUE(mode, paper_trading)
  // Check if old constraint exists by trying to insert a test — just inspect schema instead
  const tableInfo = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tradebot_config'",
    )
    .get() as { sql: string } | undefined;
  if (
    tableInfo &&
    tableInfo.sql.includes("UNIQUE(mode)") &&
    !tableInfo.sql.includes("UNIQUE(mode, paper_trading)")
  ) {
    logger.info(
      "Migrating tradebot_config: UNIQUE(mode) -> UNIQUE(mode, paper_trading)",
    );
    db.exec(`
      ALTER TABLE tradebot_config RENAME TO tradebot_config_old;
      CREATE TABLE tradebot_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL CHECK(mode IN ('wsb', 'inverse')),
        api_key_id TEXT NOT NULL,
        api_secret_key TEXT NOT NULL,
        paper_trading INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(mode, paper_trading)
      );
      INSERT INTO tradebot_config (id, mode, api_key_id, api_secret_key, paper_trading, enabled, created_at, updated_at)
        SELECT id, mode, api_key_id, api_secret_key, paper_trading, enabled, created_at, updated_at FROM tradebot_config_old;
      DROP TABLE tradebot_config_old;
    `);
  }

  // Migrate tradebot_config: add risk_level and trade_type columns if missing
  const colInfo = db.prepare("PRAGMA table_info(tradebot_config)").all() as {
    name: string;
  }[];
  const colNames = new Set(colInfo.map((c) => c.name));
  if (!colNames.has("risk_level")) {
    db.exec(
      "ALTER TABLE tradebot_config ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'safe' CHECK(risk_level IN ('safe', 'degen', 'yolo'))",
    );
    logger.info("Migrated tradebot_config: added risk_level column");
  }
  if (!colNames.has("trade_type")) {
    db.exec(
      "ALTER TABLE tradebot_config ADD COLUMN trade_type TEXT NOT NULL DEFAULT '0dte' CHECK(trade_type IN ('0dte', 'swing'))",
    );
    logger.info("Migrated tradebot_config: added trade_type column");
  }

  // Migrate comments: add score column if missing
  const commentColInfo = db
    .prepare("PRAGMA table_info(comments)")
    .all() as { name: string }[];
  const commentColNames = new Set(commentColInfo.map((c) => c.name));
  if (!commentColNames.has("score")) {
    db.exec(
      "ALTER TABLE comments ADD COLUMN score INTEGER NOT NULL DEFAULT 1",
    );
    logger.info("Migrated comments: added score column");
  }

  // Migrate daily_sentiment: add raw_comment_count column if missing
  const sentimentColInfo = db
    .prepare("PRAGMA table_info(daily_sentiment)")
    .all() as { name: string }[];
  const sentimentColNames = new Set(sentimentColInfo.map((c) => c.name));
  if (!sentimentColNames.has("raw_comment_count")) {
    db.exec(
      "ALTER TABLE daily_sentiment ADD COLUMN raw_comment_count INTEGER NOT NULL DEFAULT 0",
    );
    logger.info("Migrated daily_sentiment: added raw_comment_count column");
  }

  logger.info("Database initialized", { path: dbPath });
  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase first.");
  }
  return db;
}

export function saveCommentSentiment(comment: CommentSentiment): void {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO comments (id, body, author, created_utc, thread_id, thread_type, sentiment, confidence, tickers)
    VALUES (?, '', '', ?, '', ?, ?, ?, ?)
  `);
  stmt.run(
    comment.commentId,
    comment.createdUtc,
    comment.threadType,
    comment.sentiment,
    comment.confidence,
    JSON.stringify(comment.tickers),
  );
}

export function saveFullComment(
  id: string,
  body: string,
  author: string,
  createdUtc: number,
  score: number,
  threadId: string,
  threadType: ThreadType,
  sentiment: string,
  confidence: number,
  tickers: string[],
): boolean {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO comments (id, body, author, created_utc, score, thread_id, thread_type, sentiment, confidence, tickers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    id,
    body,
    author,
    createdUtc,
    score,
    threadId,
    threadType,
    sentiment,
    confidence,
    JSON.stringify(tickers),
  );
  return result.changes > 0;
}

export function saveDailySentiment(entry: DailySentiment): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO daily_sentiment (date, bullish_count, bearish_count, neutral_count, total_comments, raw_comment_count, bullish_percent, bearish_percent, neutral_percent, recommendation, thread_type, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(
    entry.date,
    entry.bullishCount,
    entry.bearishCount,
    entry.neutralCount,
    entry.totalComments,
    entry.rawCommentCount,
    entry.bullishPercent,
    entry.bearishPercent,
    entry.neutralPercent,
    entry.recommendation,
    entry.threadType,
  );
}

export function getTodaySentiment(date: string): DailySentiment | undefined {
  const row = getDb()
    .prepare("SELECT * FROM daily_sentiment WHERE date = ?")
    .get(date) as Record<string, unknown> | undefined;

  if (!row) return undefined;

  return {
    date: row.date as string,
    bullishCount: row.bullish_count as number,
    bearishCount: row.bearish_count as number,
    neutralCount: row.neutral_count as number,
    totalComments: row.total_comments as number,
    rawCommentCount: (row.raw_comment_count as number) || 0,
    bullishPercent: row.bullish_percent as number,
    bearishPercent: row.bearish_percent as number,
    neutralPercent: row.neutral_percent as number,
    recommendation: row.recommendation as DailySentiment["recommendation"],
    threadType: row.thread_type as ThreadType,
  };
}

export function getSentimentHistory(days: number): DailySentiment[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM daily_sentiment WHERE date >= date('now', ? || ' days') ORDER BY date ASC",
    )
    .all(`-${days}`) as Record<string, unknown>[];

  return rows.map((row) => ({
    date: row.date as string,
    bullishCount: row.bullish_count as number,
    bearishCount: row.bearish_count as number,
    neutralCount: row.neutral_count as number,
    totalComments: row.total_comments as number,
    rawCommentCount: (row.raw_comment_count as number) || 0,
    bullishPercent: row.bullish_percent as number,
    bearishPercent: row.bearish_percent as number,
    neutralPercent: row.neutral_percent as number,
    recommendation: row.recommendation as DailySentiment["recommendation"],
    threadType: row.thread_type as ThreadType,
  }));
}

export function getHistoricalComparison(days: number): HistoricalEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM historical WHERE date >= date('now', ? || ' days') ORDER BY date ASC",
    )
    .all(`-${days}`) as Record<string, unknown>[];

  return rows.map((row) => ({
    date: row.date as string,
    wsbSentiment: row.wsb_sentiment as "bullish" | "bearish",
    inverseRecommendation: row.inverse_recommendation as "BUY" | "SELL",
    spyOpen: row.spy_open as number | null,
    spyClose: row.spy_close as number | null,
    spyChange: row.spy_change as number | null,
    inverseCorrect:
      row.inverse_correct === null ? null : Boolean(row.inverse_correct),
  }));
}

export function getRecentOutcomes(limit: number = 5): HistoricalEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM historical
       WHERE wsb_sentiment != 'unknown' AND spy_change IS NOT NULL
       ORDER BY date DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    date: row.date as string,
    wsbSentiment: row.wsb_sentiment as "bullish" | "bearish",
    inverseRecommendation: row.inverse_recommendation as "BUY" | "SELL",
    spyOpen: row.spy_open as number | null,
    spyClose: row.spy_close as number | null,
    spyChange: row.spy_change as number | null,
    inverseCorrect:
      row.inverse_correct === null ? null : Boolean(row.inverse_correct),
  }));
}

export function getCommentCountSince(
  sinceUtc: number,
  threadType?: ThreadType,
): { bullish: number; bearish: number; neutral: number; rawTotal: number } {
  // Upvote-weighted aggregation: each comment's vote is weighted by max(score, 1).
  // A comment with 100 upvotes counts 100x more than a comment with 1.
  // Floor score at 1 so downvoted comments still count once (prevents zero/negative weight).
  const query = threadType
    ? "SELECT sentiment, SUM(MAX(score, 1)) as weight, COUNT(*) as cnt FROM comments WHERE created_utc >= ? AND thread_type = ? GROUP BY sentiment"
    : "SELECT sentiment, SUM(MAX(score, 1)) as weight, COUNT(*) as cnt FROM comments WHERE created_utc >= ? GROUP BY sentiment";

  const rows = threadType
    ? (getDb().prepare(query).all(sinceUtc, threadType) as {
        sentiment: string;
        weight: number;
        cnt: number;
      }[])
    : (getDb().prepare(query).all(sinceUtc) as {
        sentiment: string;
        weight: number;
        cnt: number;
      }[]);

  const result = { bullish: 0, bearish: 0, neutral: 0, rawTotal: 0 };
  for (const row of rows) {
    result.rawTotal += row.cnt;
    if (row.sentiment === "bullish") result.bullish = row.weight;
    else if (row.sentiment === "bearish") result.bearish = row.weight;
    else result.neutral = row.weight;
  }
  return result;
}

/**
 * Time-decayed sentiment aggregation for the trade engine.
 * Comments closer to market open (9:30 AM EST) are weighted more heavily.
 * This captures the "wavefunction collapse" effect: weekend speculation is
 * discounted as Monday morning reality-based comments arrive.
 *
 * Decay tiers (hours before market open → multiplier):
 *   0-2.5h  (7:00-9:30 AM daily thread): 1.0x
 *   2.5-5.5h (4:00-7:00 AM overnight):   0.7x
 *   5.5-17.5h (Sun 4PM - Mon 4AM):        0.5x
 *   17.5h+ (weekend / older):              0.3x
 */
export function getTimeDecayedSentiment(
  sinceUtc: number,
): { bullish: number; bearish: number; neutral: number; rawTotal: number } {
  // Market open is 9:30 AM EST = 14:30 UTC (or 13:30 UTC during DST)
  // Use current time as reference point for "how old is this comment"
  const nowUtc = Math.floor(Date.now() / 1000);

  // Fetch individual comments with their timestamps and scores
  const rows = getDb()
    .prepare(
      "SELECT sentiment, score, created_utc FROM comments WHERE created_utc >= ?",
    )
    .all(sinceUtc) as { sentiment: string; score: number; created_utc: number }[];

  const result = { bullish: 0, bearish: 0, neutral: 0, rawTotal: 0 };

  for (const row of rows) {
    const ageHours = (nowUtc - row.created_utc) / 3600;
    const upvoteWeight = Math.max(row.score, 1);

    // Time-decay multiplier: fresher comments count much more.
    // Steep decay ensures recent sentiment dominates the signal.
    let decayMultiplier: number;
    if (ageHours <= 2.5) {
      decayMultiplier = 1.0; // Last 2.5h (daily thread morning)
    } else if (ageHours <= 5.5) {
      decayMultiplier = 0.6; // 2.5-5.5h ago (overnight/early morning)
    } else if (ageHours <= 17.5) {
      decayMultiplier = 0.3; // 5.5-17.5h ago (previous evening / late night)
    } else {
      decayMultiplier = 0.1; // 17.5h+ ago (weekend / old — near-zero influence)
    }

    const weight = upvoteWeight * decayMultiplier;
    result.rawTotal++;

    if (row.sentiment === "bullish") result.bullish += weight;
    else if (row.sentiment === "bearish") result.bearish += weight;
    else result.neutral += weight;
  }

  return result;
}

export function saveTopPost(post: TopPost, date: string): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO top_posts (id, date, title, author, score, num_comments, created_utc, permalink, sentiment, confidence, tickers, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(
    post.id,
    date,
    post.title,
    post.author,
    post.score,
    post.numComments,
    post.createdUtc,
    post.permalink,
    post.sentiment,
    post.confidence,
    JSON.stringify(post.tickers),
  );
}

export function getTopPosts(date: string): TopPost[] {
  const rows = getDb()
    .prepare("SELECT * FROM top_posts WHERE date = ? ORDER BY score DESC")
    .all(date) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    author: row.author as string,
    score: row.score as number,
    numComments: row.num_comments as number,
    createdUtc: row.created_utc as number,
    permalink: row.permalink as string,
    sentiment: row.sentiment as TopPost["sentiment"],
    confidence: row.confidence as number,
    tickers: JSON.parse(row.tickers as string) as string[],
  }));
}

export function saveHistoricalEntry(
  date: string,
  wsbSentiment: string,
  inverseRecommendation: string,
): void {
  // Once a day has a directional recommendation (CALLS/PUTS), lock it in.
  // Later polls (overnight thread) must not overwrite the market-hours signal.
  const existing = getDb()
    .prepare("SELECT inverse_recommendation FROM historical WHERE date = ?")
    .get(date) as { inverse_recommendation: string } | undefined;

  if (
    existing &&
    (existing.inverse_recommendation === "CALLS" ||
      existing.inverse_recommendation === "PUTS")
  ) {
    return;
  }

  const stmt = getDb().prepare(`
    INSERT INTO historical (date, wsb_sentiment, inverse_recommendation)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET wsb_sentiment = ?, inverse_recommendation = ?
  `);
  stmt.run(
    date,
    wsbSentiment,
    inverseRecommendation,
    wsbSentiment,
    inverseRecommendation,
  );
}

export function updateSpyPrices(
  date: string,
  spyOpen: number,
  spyClose: number,
  spyChange: number,
): void {
  const stmt = getDb().prepare(`
    UPDATE historical SET spy_open = ?, spy_close = ?, spy_change = ? WHERE date = ?
  `);
  stmt.run(spyOpen, spyClose, spyChange, date);

  // Auto-compute inverse_correct: if inverse says BUY/CALLS and SPY went up, correct.
  // If inverse says SELL/PUTS and SPY went down, correct.
  const row = getDb()
    .prepare("SELECT inverse_recommendation FROM historical WHERE date = ?")
    .get(date) as { inverse_recommendation: string } | undefined;

  if (row && spyChange !== 0) {
    const rec = row.inverse_recommendation;
    const spyUp = spyChange > 0;
    const inverseCorrect =
      (rec === "CALLS" && spyUp) || (rec === "PUTS" && !spyUp) ? 1 : 0;
    getDb()
      .prepare("UPDATE historical SET inverse_correct = ? WHERE date = ?")
      .run(inverseCorrect, date);
  }
}

export function bulkUpsertSpyPrices(
  prices: Array<{ date: string; open: number; close: number; change: number }>,
): void {
  const insertStmt = getDb().prepare(`
    INSERT INTO historical (date, wsb_sentiment, inverse_recommendation, spy_open, spy_close, spy_change)
    VALUES (?, 'unknown', 'HOLD', ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET spy_open = ?, spy_close = ?, spy_change = ?
  `);

  const transaction = getDb().transaction(() => {
    for (const p of prices) {
      insertStmt.run(
        p.date,
        p.open,
        p.close,
        p.change,
        p.open,
        p.close,
        p.change,
      );
    }
  });
  transaction();

  // Recompute inverse_correct for all rows that have both a real recommendation and SPY data
  getDb()
    .prepare(
      `
    UPDATE historical SET inverse_correct = CASE
      WHEN inverse_recommendation = 'CALLS' AND spy_change > 0 THEN 1
      WHEN inverse_recommendation = 'PUTS' AND spy_change < 0 THEN 1
      WHEN inverse_recommendation IN ('CALLS', 'PUTS') AND spy_change != 0 THEN 0
      ELSE NULL
    END
    WHERE spy_change IS NOT NULL AND inverse_recommendation != 'HOLD' AND wsb_sentiment != 'unknown'
  `,
    )
    .run();
}

export function purgeOldData(): void {
  // Comments: only keep today and yesterday (for overnight thread analysis)
  const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
  const commentResult = getDb()
    .prepare("DELETE FROM comments WHERE created_utc < ?")
    .run(twoDaysAgo);

  // top_posts: keep 2 days
  getDb()
    .prepare("DELETE FROM top_posts WHERE date < date('now', '-2 days')")
    .run();

  // daily_sentiment: keep 90 days for the dashboard history chart
  getDb()
    .prepare("DELETE FROM daily_sentiment WHERE date < date('now', '-90 days')")
    .run();

  // historical: never purge — this is the long-term record of WSB sentiment
  // vs SPY outcomes for analyzing inverse strategy performance

  // Reclaim disk space after large deletes
  if (commentResult.changes > 1000) {
    getDb().pragma("optimize");
  }

  // cramer_picks: keep 30 days
  getDb()
    .prepare("DELETE FROM cramer_picks WHERE date < date('now', '-30 days')")
    .run();

  logger.info("Purged old data", { commentsDeleted: commentResult.changes });
}

export function saveCramerPick(pick: CramerPick): void {
  const stmt = getDb().prepare(`
    INSERT INTO cramer_picks (ticker, date, direction, raw_direction, source, title)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date, source) DO UPDATE SET direction = ?, raw_direction = ?, title = ?
  `);
  stmt.run(
    pick.ticker,
    pick.date,
    pick.direction,
    pick.rawDirection,
    pick.source,
    pick.title,
    pick.direction,
    pick.rawDirection,
    pick.title,
  );
}

export function saveCramerPicks(picks: CramerPick[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO cramer_picks (ticker, date, direction, raw_direction, source, title)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date, source) DO UPDATE SET direction = ?, raw_direction = ?, title = ?
  `);

  const transaction = getDb().transaction(() => {
    for (const pick of picks) {
      stmt.run(
        pick.ticker,
        pick.date,
        pick.direction,
        pick.rawDirection,
        pick.source,
        pick.title,
        pick.direction,
        pick.rawDirection,
        pick.title,
      );
    }
  });
  transaction();
}

export function getCramerPicks(days: number = 7): CramerPick[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM cramer_picks WHERE date >= date('now', ? || ' days') ORDER BY date DESC",
    )
    .all(`-${days}`) as Record<string, unknown>[];

  return rows.map((row) => ({
    ticker: row.ticker as string,
    direction: row.direction as CramerPick["direction"],
    rawDirection: row.raw_direction as string,
    date: row.date as string,
    source: row.source as CramerPick["source"],
    title: row.title as string,
  }));
}

export function getSpyChangeByDate(): Record<string, number | null> {
  const rows = getDb()
    .prepare(
      "SELECT date, spy_change FROM historical WHERE spy_change IS NOT NULL ORDER BY date DESC LIMIT 90",
    )
    .all() as { date: string; spy_change: number | null }[];

  const map: Record<string, number | null> = {};
  for (const row of rows) {
    map[row.date] = row.spy_change;
  }
  return map;
}

// --- Trade bot database functions ---

export function getTradeBotConfig(
  mode: TradeBotMode,
  paperTrading: boolean,
): TradeBotConfig | undefined {
  const row = getDb()
    .prepare(
      "SELECT * FROM tradebot_config WHERE mode = ? AND paper_trading = ?",
    )
    .get(mode, paperTrading ? 1 : 0) as Record<string, unknown> | undefined;

  if (!row) return undefined;

  return {
    id: row.id as number,
    mode: row.mode as TradeBotMode,
    apiKeyId: decrypt(row.api_key_id as string),
    apiSecretKey: decrypt(row.api_secret_key as string),
    paperTrading: Boolean(row.paper_trading),
    enabled: Boolean(row.enabled),
    riskLevel: (row.risk_level as RiskLevel) ?? "safe",
    tradeType: (row.trade_type as TradeType) ?? "0dte",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllTradeBotConfigs(): TradeBotConfig[] {
  const rows = getDb()
    .prepare("SELECT * FROM tradebot_config ORDER BY mode")
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as number,
    mode: row.mode as TradeBotMode,
    apiKeyId: decrypt(row.api_key_id as string),
    apiSecretKey: decrypt(row.api_secret_key as string),
    paperTrading: Boolean(row.paper_trading),
    enabled: Boolean(row.enabled),
    riskLevel: (row.risk_level as RiskLevel) ?? "safe",
    tradeType: (row.trade_type as TradeType) ?? "0dte",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export function saveTradeBotConfig(
  mode: TradeBotMode,
  apiKeyId: string,
  apiSecretKey: string,
  paperTrading: boolean,
): void {
  const encKeyId = encrypt(apiKeyId);
  const encSecret = encrypt(apiSecretKey);
  getDb()
    .prepare(
      `
    INSERT INTO tradebot_config (mode, api_key_id, api_secret_key, paper_trading, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mode, paper_trading) DO UPDATE SET
      api_key_id = ?,
      api_secret_key = ?,
      updated_at = datetime('now')
  `,
    )
    .run(mode, encKeyId, encSecret, paperTrading ? 1 : 0, encKeyId, encSecret);
}

export function setTradeBotEnabled(
  mode: TradeBotMode,
  paperTrading: boolean,
  enabled: boolean,
): void {
  getDb()
    .prepare(
      `
    UPDATE tradebot_config SET enabled = ?, updated_at = datetime('now')
    WHERE mode = ? AND paper_trading = ?
  `,
    )
    .run(enabled ? 1 : 0, mode, paperTrading ? 1 : 0);
}

export function updateTradeSettings(
  mode: TradeBotMode,
  paperTrading: boolean,
  riskLevel: RiskLevel,
  tradeType: TradeType,
): void {
  getDb()
    .prepare(
      `
    UPDATE tradebot_config SET risk_level = ?, trade_type = ?, updated_at = datetime('now')
    WHERE mode = ? AND paper_trading = ?
  `,
    )
    .run(riskLevel, tradeType, mode, paperTrading ? 1 : 0);
}

export function deleteTradeBotConfig(
  mode: TradeBotMode,
  paperTrading: boolean,
): boolean {
  const result = getDb()
    .prepare("DELETE FROM tradebot_config WHERE mode = ? AND paper_trading = ?")
    .run(mode, paperTrading ? 1 : 0);
  return result.changes > 0;
}

/**
 * Migrates any plaintext API keys to encrypted format.
 * Plaintext keys won't start with "enc:v1:" prefix.
 */
export function migrateKeysToEncrypted(): void {
  const rows = getDb()
    .prepare("SELECT id, api_key_id, api_secret_key FROM tradebot_config")
    .all() as { id: number; api_key_id: string; api_secret_key: string }[];

  const updateStmt = getDb().prepare(
    "UPDATE tradebot_config SET api_key_id = ?, api_secret_key = ? WHERE id = ?",
  );

  let migrated = 0;
  for (const row of rows) {
    const needsKeyMigration = !isEncrypted(row.api_key_id);
    const needsSecretMigration = !isEncrypted(row.api_secret_key);
    if (needsKeyMigration || needsSecretMigration) {
      const encKey = needsKeyMigration
        ? encrypt(row.api_key_id)
        : row.api_key_id;
      const encSecret = needsSecretMigration
        ? encrypt(row.api_secret_key)
        : row.api_secret_key;
      updateStmt.run(encKey, encSecret, row.id);
      migrated++;
    }
  }

  if (migrated > 0) {
    logger.info("Migrated plaintext API keys to encrypted format", {
      count: migrated,
    });
  }
}

export function insertTradeLog(log: Omit<TradeLog, "id" | "timestamp">): number {
  const result = getDb()
    .prepare(
      `
    INSERT INTO trade_log (mode, action, symbol, side, qty, price, order_id, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      log.mode,
      log.action,
      log.symbol,
      log.side,
      log.qty,
      log.price,
      log.orderId,
      log.status,
      log.message,
    );
  return Number(result.lastInsertRowid);
}

export function getRecentTradeLogs(
  mode: TradeBotMode | null,
  limit: number = 50,
): TradeLog[] {
  const query = mode
    ? "SELECT * FROM trade_log WHERE mode = ? ORDER BY timestamp DESC LIMIT ?"
    : "SELECT * FROM trade_log ORDER BY timestamp DESC LIMIT ?";

  const rows = mode
    ? (getDb().prepare(query).all(mode, limit) as Record<string, unknown>[])
    : (getDb().prepare(query).all(limit) as Record<string, unknown>[]);

  return rows.map((row) => ({
    id: row.id as number,
    timestamp: row.timestamp as string,
    mode: row.mode as TradeBotMode,
    action: row.action as string,
    symbol: row.symbol as string,
    side: row.side as "buy" | "sell",
    qty: row.qty as number,
    price: row.price as number | null,
    orderId: row.order_id as string | null,
    status: row.status as TradeLog["status"],
    message: row.message as string,
  }));
}

// --- Trade Rounds ---

export function insertTradeRound(round: {
  mode: TradeBotMode;
  paperTrading: boolean;
  tradeDate: string;
  symbol: string;
  direction: "calls" | "puts";
  qty: number;
  entryPrice: number;
  entryTime: string;
  entryLogId: number;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO trade_rounds (mode, paper_trading, trade_date, symbol, direction, qty, entry_price, entry_time, entry_log_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
    .run(
      round.mode,
      round.paperTrading ? 1 : 0,
      round.tradeDate,
      round.symbol,
      round.direction,
      round.qty,
      round.entryPrice,
      round.entryTime,
      round.entryLogId,
    );
  return Number(result.lastInsertRowid);
}

export function closeTradeRound(
  id: number,
  exitPrice: number,
  exitTime: string,
  exitLogId: number,
  exitReason: string,
  pnlDollars: number,
  pnlPercent: number,
): void {
  getDb()
    .prepare(
      `UPDATE trade_rounds
       SET exit_price = ?, exit_time = ?, exit_log_id = ?, exit_reason = ?,
           pnl_dollars = ?, pnl_percent = ?, status = 'closed'
       WHERE id = ?`,
    )
    .run(exitPrice, exitTime, exitLogId, exitReason, pnlDollars, pnlPercent, id);
}

export function getOpenTradeRound(
  mode: TradeBotMode,
  paperTrading: boolean,
): TradeRound | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM trade_rounds WHERE mode = ? AND paper_trading = ? AND status = 'open' LIMIT 1`,
    )
    .get(mode, paperTrading ? 1 : 0) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapTradeRound(row);
}

export function getTradeRounds(
  mode: TradeBotMode | null,
  paperTrading: boolean | null,
  limit: number = 50,
): TradeRound[] {
  let query = "SELECT * FROM trade_rounds WHERE status = 'closed'";
  const params: unknown[] = [];

  if (mode !== null) {
    query += " AND mode = ?";
    params.push(mode);
  }
  if (paperTrading !== null) {
    query += " AND paper_trading = ?";
    params.push(paperTrading ? 1 : 0);
  }

  query += " ORDER BY trade_date DESC, exit_time DESC LIMIT ?";
  params.push(limit);

  const rows = getDb().prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(mapTradeRound);
}

function mapTradeRound(row: Record<string, unknown>): TradeRound {
  return {
    id: row.id as number,
    mode: row.mode as TradeBotMode,
    paperTrading: (row.paper_trading as number) === 1,
    tradeDate: row.trade_date as string,
    symbol: row.symbol as string,
    direction: row.direction as "calls" | "puts",
    qty: row.qty as number,
    entryPrice: row.entry_price as number,
    exitPrice: row.exit_price as number | null,
    entryTime: row.entry_time as string,
    exitTime: row.exit_time as string | null,
    entryLogId: row.entry_log_id as number,
    exitLogId: row.exit_log_id as number | null,
    exitReason: row.exit_reason as string | null,
    pnlDollars: row.pnl_dollars as number | null,
    pnlPercent: row.pnl_percent as number | null,
    status: row.status as "open" | "closed",
  };
}

export function getTradePerformance(
  mode: TradeBotMode | null,
  paperTrading: boolean | null,
): TradePerformance {
  let query = `
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_dollars <= 0 THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_dollars), 2) as total_pnl,
      ROUND(AVG(pnl_dollars), 2) as avg_pnl,
      ROUND(MAX(pnl_dollars), 2) as best_trade,
      ROUND(MIN(pnl_dollars), 2) as worst_trade,
      ROUND(AVG(CASE WHEN pnl_dollars > 0 THEN pnl_dollars END), 2) as avg_win,
      ROUND(AVG(CASE WHEN pnl_dollars <= 0 THEN pnl_dollars END), 2) as avg_loss
    FROM trade_rounds
    WHERE status = 'closed'`;
  const params: unknown[] = [];

  if (mode !== null) {
    query += " AND mode = ?";
    params.push(mode);
  }
  if (paperTrading !== null) {
    query += " AND paper_trading = ?";
    params.push(paperTrading ? 1 : 0);
  }

  const row = getDb().prepare(query).get(...params) as Record<string, unknown>;
  const total = (row.total_trades as number) || 0;
  const wins = (row.wins as number) || 0;

  return {
    totalTrades: total,
    wins,
    losses: (row.losses as number) || 0,
    winRate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0,
    totalPnl: (row.total_pnl as number) || 0,
    avgPnl: (row.avg_pnl as number) || 0,
    bestTrade: (row.best_trade as number) || 0,
    worstTrade: (row.worst_trade as number) || 0,
    avgWin: (row.avg_win as number) || 0,
    avgLoss: (row.avg_loss as number) || 0,
  };
}

// --- Equity Snapshots ---

export function insertEquitySnapshot(
  mode: TradeBotMode,
  paperTrading: boolean,
  snapshotDate: string,
  equity: number,
  cash: number,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO equity_snapshots (mode, paper_trading, snapshot_date, equity, cash)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(mode, paperTrading ? 1 : 0, snapshotDate, equity, cash);
}

export function getEquityHistory(
  mode: TradeBotMode,
  paperTrading: boolean,
  days: number = 30,
): EquitySnapshot[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, equity, cash FROM equity_snapshots
       WHERE mode = ? AND paper_trading = ?
       AND snapshot_date >= date('now', '-' || ? || ' days')
       ORDER BY snapshot_date ASC`,
    )
    .all(mode, paperTrading ? 1 : 0, days) as Record<string, unknown>[];

  return rows.map((row) => ({
    timestamp: row.timestamp as string,
    equity: row.equity as number,
    cash: row.cash as number,
  }));
}
