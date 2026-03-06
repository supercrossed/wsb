import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

import { logger } from "../lib/logger";
import type { CommentSentiment, DailySentiment, HistoricalEntry, ThreadType, TopPost } from "../types";

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
  `);

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
  threadId: string,
  threadType: ThreadType,
  sentiment: string,
  confidence: number,
  tickers: string[],
): boolean {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO comments (id, body, author, created_utc, thread_id, thread_type, sentiment, confidence, tickers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(id, body, author, createdUtc, threadId, threadType, sentiment, confidence, JSON.stringify(tickers));
  return result.changes > 0;
}

export function saveDailySentiment(entry: DailySentiment): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO daily_sentiment (date, bullish_count, bearish_count, neutral_count, total_comments, bullish_percent, bearish_percent, neutral_percent, recommendation, thread_type, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(
    entry.date,
    entry.bullishCount,
    entry.bearishCount,
    entry.neutralCount,
    entry.totalComments,
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
    inverseCorrect: row.inverse_correct === null ? null : Boolean(row.inverse_correct),
  }));
}

export function getCommentCountSince(sinceUtc: number, threadType?: ThreadType): { bullish: number; bearish: number; neutral: number } {
  const query = threadType
    ? "SELECT sentiment, COUNT(*) as count FROM comments WHERE created_utc >= ? AND thread_type = ? GROUP BY sentiment"
    : "SELECT sentiment, COUNT(*) as count FROM comments WHERE created_utc >= ? GROUP BY sentiment";

  const rows = threadType
    ? (getDb().prepare(query).all(sinceUtc, threadType) as { sentiment: string; count: number }[])
    : (getDb().prepare(query).all(sinceUtc) as { sentiment: string; count: number }[]);

  const result = { bullish: 0, bearish: 0, neutral: 0 };
  for (const row of rows) {
    if (row.sentiment === "bullish") result.bullish = row.count;
    else if (row.sentiment === "bearish") result.bearish = row.count;
    else result.neutral = row.count;
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

export function purgeOldData(): void {
  // Comments: only keep today and yesterday (for overnight thread analysis)
  const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
  const commentResult = getDb().prepare("DELETE FROM comments WHERE created_utc < ?").run(twoDaysAgo);

  // top_posts: keep 2 days
  getDb().prepare("DELETE FROM top_posts WHERE date < date('now', '-2 days')").run();

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

  logger.info("Purged old data", { commentsDeleted: commentResult.changes });
}
