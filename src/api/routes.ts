import { Router, Request, Response } from "express";
import os from "os";
import fs from "fs";

import {
  getTodaySentiment,
  getSentimentHistory,
  getHistoricalComparison,
  getCommentCountSince,
  getTopPosts,
  getRecentOutcomes,
  getCramerPicks,
  getSpyChangeByDate,
  getDb,
} from "../services/database";
import { fetchSpyToday, fetchSpyRealtime } from "../services/spy";
import { getActiveThreadType } from "../services/reddit";
import { computeCramerIndex } from "../services/cramer";
import { getInverseRecommendation } from "../services/sentiment";
import { pollAndAnalyze, backfillSpyPrices, getTradingDateString } from "../services/scheduler";
import { logger } from "../lib/logger";
import { config } from "../config";

const router = Router();

/**
 * GET /api/sentiment/today
 * Returns today's aggregated sentiment and inverse recommendation.
 */
router.get("/api/sentiment/today", (_req: Request, res: Response) => {
  const tradingDate = getTradingDateString();
  const sentiment = getTodaySentiment(tradingDate);
  const threadType = getActiveThreadType();

  // Recalculate recommendation live from current percentages
  if (sentiment) {
    sentiment.recommendation = getInverseRecommendation(
      sentiment.bullishPercent,
      sentiment.bearishPercent,
    );
  }

  res.json({
    date: tradingDate,
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
 * POST /api/backfill-spy
 * Manually triggers SPY price backfill and recomputes inverse_correct verdicts.
 */
router.post("/api/backfill-spy", async (_req: Request, res: Response) => {
  try {
    await backfillSpyPrices();
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Manual SPY backfill failed", { error: message });
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/top-posts
 * Returns today's top 10 WSB posts with sentiment analysis.
 */
router.get("/api/top-posts", (_req: Request, res: Response) => {
  const tradingDate = getTradingDateString();
  const posts = getTopPosts(tradingDate);
  res.json({ date: tradingDate, posts });
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

/**
 * GET /api/cramer
 * Returns the Cramer Index — his recent picks aggregated into bull/bear direction,
 * plus comparison data for the dashboard.
 */
router.get("/api/cramer", (_req: Request, res: Response) => {
  const picks = getCramerPicks(30);
  const index = computeCramerIndex(picks);

  // Attach SPY change data to recent picks for RIGHT/WRONG verdict
  const spyData = getSpyChangeByDate();
  const recentWithVerdict = index.recentPicks.map((pick) => {
    const spy = spyData[pick.date];
    let verdict: string | null = null;
    if (spy !== undefined && spy !== null) {
      // Cramer bullish + SPY up = Cramer was right; Cramer bearish + SPY down = right
      const spyUp = spy > 0;
      const cramerRight =
        (pick.direction === "bullish" && spyUp) ||
        (pick.direction === "bearish" && !spyUp);
      verdict = pick.direction === "neutral" ? null : (cramerRight ? "RIGHT" : "WRONG");
    }
    return { ...pick, spyChange: spy ?? null, verdict };
  });

  res.json({ ...index, recentPicks: recentWithVerdict });
});

/**
 * GET /api/inverse-scorecard
 * Returns 30-day right/wrong counts for the inverse WSB strategy.
 */
router.get("/api/inverse-scorecard", (_req: Request, res: Response) => {
  const rows = getDb()
    .prepare(
      `SELECT inverse_correct, COUNT(*) as count
       FROM historical
       WHERE date >= date('now', '-30 days')
         AND inverse_correct IS NOT NULL
       GROUP BY inverse_correct`,
    )
    .all() as { inverse_correct: number; count: number }[];

  let right = 0;
  let wrong = 0;
  for (const row of rows) {
    if (row.inverse_correct === 1) right = row.count;
    else wrong = row.count;
  }

  const total = right + wrong;
  res.json({
    right,
    wrong,
    total,
    rightPercent: total > 0 ? Math.round((right / total) * 10000) / 100 : 0,
    wrongPercent: total > 0 ? Math.round((wrong / total) * 10000) / 100 : 0,
  });
});

// --- Hardware monitoring ---

let prevNetRx = 0;
let prevNetTx = 0;
let prevNetTime = 0;

function getNetworkBytes(): { rx: number; tx: number } {
  try {
    const data = fs.readFileSync("/proc/net/dev", "utf-8");
    let totalRx = 0;
    let totalTx = 0;
    for (const line of data.split("\n").slice(2)) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0] || parts[0] === "lo:") continue;
      totalRx += parseInt(parts[1], 10) || 0;
      totalTx += parseInt(parts[9], 10) || 0;
    }
    return { rx: totalRx, tx: totalTx };
  } catch {
    return { rx: 0, tx: 0 };
  }
}

let prevCpuIdle = 0;
let prevCpuTotal = 0;

function getCpuUsage(): number {
  try {
    const stat = fs.readFileSync("/proc/stat", "utf-8");
    const cpuLine = stat.split("\n")[0];
    const parts = cpuLine.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    const diffIdle = idle - prevCpuIdle;
    const diffTotal = total - prevCpuTotal;
    prevCpuIdle = idle;
    prevCpuTotal = total;
    if (diffTotal === 0) return 0;
    return Math.round((1 - diffIdle / diffTotal) * 10000) / 100;
  } catch {
    // Fallback for non-Linux: use os.loadavg
    const cpus = os.cpus().length;
    return Math.round((os.loadavg()[0] / cpus) * 10000) / 100;
  }
}

/**
 * GET /api/system
 * Returns CPU, RAM, and network stats for the host machine.
 */
router.get("/api/system", (_req: Request, res: Response) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const cpu = getCpuUsage();

  const now = Date.now();
  const net = getNetworkBytes();
  const elapsed = prevNetTime > 0 ? (now - prevNetTime) / 1000 : 1;
  const rxRate = prevNetTime > 0 ? (net.rx - prevNetRx) / elapsed : 0;
  const txRate = prevNetTime > 0 ? (net.tx - prevNetTx) / elapsed : 0;
  prevNetRx = net.rx;
  prevNetTx = net.tx;
  prevNetTime = now;

  const uptime = os.uptime();

  res.json({
    cpu,
    ram: {
      total: totalMem,
      used: usedMem,
      percent: Math.round((usedMem / totalMem) * 10000) / 100,
    },
    network: {
      rxBytesPerSec: Math.round(rxRate),
      txBytesPerSec: Math.round(txRate),
    },
    uptime,
    hostname: os.hostname(),
    loadAvg: os.loadavg(),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
  });
});

export { router };
