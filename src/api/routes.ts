import { Router, Request, Response } from "express";

import {
  getTodaySentiment,
  getSentimentHistory,
  getHistoricalComparison,
  getCommentCountSince,
  getTopPosts,
  getRecentOutcomes,
} from "../services/database";
import { fetchSpyToday, fetchSpyRealtime } from "../services/spy";
import { getActiveThreadType } from "../services/reddit";
import { pollAndAnalyze } from "../services/scheduler";
import { logger } from "../lib/logger";
import { config } from "../config";

const router = Router();

/**
 * GET /api/sentiment/today
 * Returns today's aggregated sentiment and inverse recommendation.
 */
router.get("/api/sentiment/today", (_req: Request, res: Response) => {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const year = est.getFullYear();
  const month = String(est.getMonth() + 1).padStart(2, "0");
  const day = String(est.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  const sentiment = getTodaySentiment(dateStr);
  const threadType = getActiveThreadType();

  res.json({
    date: dateStr,
    threadType,
    sentiment: sentiment ?? null,
  });
});

/**
 * GET /api/sentiment/history?days=90
 * Returns sentiment history for the rolling window.
 */
router.get("/api/sentiment/history", (req: Request, res: Response) => {
  const days = Math.min(
    parseInt((req.query.days as string) ?? "90", 10),
    config.sentiment.historyDays,
  );
  const history = getSentimentHistory(days);
  res.json({ days, entries: history });
});

/**
 * GET /api/historical?days=90
 * Returns historical comparison with SPY outcomes.
 */
router.get("/api/historical", (req: Request, res: Response) => {
  const days = Math.min(
    parseInt((req.query.days as string) ?? "90", 10),
    config.sentiment.historyDays,
  );
  const entries = getHistoricalComparison(days);
  res.json({ days, entries });
});

/**
 * GET /api/status
 * Returns app status info.
 */
router.get("/api/status", (_req: Request, res: Response) => {
  const threadType = getActiveThreadType();
  res.json({
    status: "running",
    activeThreadType: threadType,
    pollIntervalMs: config.sentiment.pollIntervalMs,
    historyDays: config.sentiment.historyDays,
  });
});

/**
 * POST /api/poll
 * Manually triggers a poll cycle.
 */
router.post("/api/poll", async (_req: Request, res: Response) => {
  try {
    await pollAndAnalyze();
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Manual poll failed", { error: message });
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/top-posts
 * Returns today's top 10 WSB posts with sentiment analysis.
 */
router.get("/api/top-posts", (_req: Request, res: Response) => {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const year = est.getFullYear();
  const month = String(est.getMonth() + 1).padStart(2, "0");
  const day = String(est.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  const posts = getTopPosts(dateStr);
  res.json({ date: dateStr, posts });
});

/**
 * GET /api/live-counts
 * Returns current live bullish/bearish/neutral counts for the active thread period.
 */
router.get("/api/live-counts", (_req: Request, res: Response) => {
  const threadType = getActiveThreadType();
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );

  // Compute period start based on thread type
  let periodStart: Date;
  switch (threadType) {
    case "daily":
      periodStart = new Date(est);
      periodStart.setHours(7, 0, 0, 0);
      break;
    case "overnight":
      periodStart = new Date(est);
      if (est.getHours() < 7) {
        periodStart.setDate(periodStart.getDate() - 1);
      }
      periodStart.setHours(16, 0, 0, 0);
      break;
    case "weekend":
      periodStart = new Date(est);
      while (periodStart.getDay() !== 5) {
        periodStart.setDate(periodStart.getDate() - 1);
      }
      periodStart.setHours(16, 0, 0, 0);
      break;
  }

  const sinceUtc = Math.floor(periodStart.getTime() / 1000);
  const counts = getCommentCountSince(sinceUtc, threadType);
  const total = counts.bullish + counts.bearish + counts.neutral;

  res.json({
    threadType,
    ...counts,
    total,
    bullishPercent: total > 0 ? Math.round((counts.bullish / total) * 10000) / 100 : 0,
    bearishPercent: total > 0 ? Math.round((counts.bearish / total) * 10000) / 100 : 0,
    neutralPercent: total > 0 ? Math.round((counts.neutral / total) * 10000) / 100 : 0,
  });
});

/**
 * GET /api/spy/realtime
 * Returns current SPY price with 10s server-side cache. Includes pre/post market.
 */
router.get("/api/spy/realtime", async (_req: Request, res: Response) => {
  try {
    const quote = await fetchSpyRealtime();
    res.json({ quote });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/spy/scorecard
 * Returns recent outcomes comparing WSB sentiment vs actual SPY movement.
 */
router.get("/api/spy/scorecard", async (_req: Request, res: Response) => {
  try {
    const quote = await fetchSpyRealtime();
    const recentOutcomes = getRecentOutcomes(5);
    res.json({ quote, recentOutcomes });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/spy/today
 * Returns today's SPY price data.
 */
router.get("/api/spy/today", async (_req: Request, res: Response) => {
  try {
    const spy = await fetchSpyToday();
    res.json({ spy });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/spy/history?days=90
 * Returns SPY prices from the historical table overlaid with sentiment data.
 */
router.get("/api/spy/history", (req: Request, res: Response) => {
  const days = Math.min(
    parseInt((req.query.days as string) ?? "90", 10),
    config.sentiment.historyDays,
  );
  const entries = getHistoricalComparison(days);
  res.json({ days, entries });
});

export { router };
