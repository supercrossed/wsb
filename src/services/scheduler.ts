import cron from "node-cron";

import { config } from "../config";
import { logger } from "../lib/logger";
import {
  findActiveThread,
  fetchThreadComments,
  fetchTopPosts,
  fetchPostComments,
  getActiveThreadType,
  getSecondaryThreadTypes,
} from "./reddit";
import { analyzeSentiment, getInverseRecommendation } from "./sentiment";
import {
  saveFullComment,
  saveDailySentiment,
  saveTopPost,
  saveHistoricalEntry,
  bulkUpsertSpyPrices,
  saveCramerPicks,
  getCommentCountSince,
  purgeOldData,
} from "./database";
import { fetchSpyPrices } from "./spy";
import { fetchAllCramerPicks } from "./cramer";
import { importDataFeed } from "./data-feed";
import {
  evaluateAndTrade,
  closeBeforeMarketClose,
  resetDailyTrades,
  startPositionMonitor,
  captureEquitySnapshots,
} from "./trade-engine";
import type { DailySentiment, ThreadType, TopPost } from "../types";

let isPolling = false;

function getTodayDateString(): string {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const year = est.getFullYear();
  const month = String(est.getMonth() + 1).padStart(2, "0");
  const day = String(est.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns the trading date that the current sentiment should apply to.
 * Before 4 PM EST: today's date (sentiment for today's trading session).
 * After 4 PM EST: the next trading day's date (overnight sentiment feeds into next day).
 * Handles weekends: Friday after 4 PM → Monday, Saturday/Sunday → Monday.
 */
export function getTradingDateString(): string {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const hour = est.getHours();
  const day = est.getDay(); // 0=Sun, 6=Sat

  // Before 4 PM on a weekday: sentiment is for today
  if (day >= 1 && day <= 5 && hour < 16) {
    return formatDate(est);
  }

  // After 4 PM or weekend: advance to next trading day
  const next = new Date(est);

  if (day >= 1 && day <= 4 && hour >= 16) {
    // Mon-Thu after 4 PM → next day
    next.setDate(next.getDate() + 1);
  } else if (day === 5 && hour >= 16) {
    // Friday after 4 PM → Monday
    next.setDate(next.getDate() + 3);
  } else if (day === 6) {
    // Saturday → Monday
    next.setDate(next.getDate() + 2);
  } else if (day === 0) {
    // Sunday → Monday
    next.setDate(next.getDate() + 1);
  }

  return formatDate(next);
}

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns the UTC timestamp for the start of the current thread's active period.
 */
function getThreadStartUtc(threadType: ThreadType): number {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );

  switch (threadType) {
    case "daily":
      // Started at 7:00 AM EST today
      est.setHours(7, 0, 0, 0);
      break;
    case "overnight":
      // Started at 4:00 PM EST today (or yesterday if before midnight)
      if (est.getHours() < 7) {
        est.setDate(est.getDate() - 1);
      }
      est.setHours(16, 0, 0, 0);
      break;
    case "weekend":
      // Started Friday at 4:00 PM — go back to last Friday
      while (est.getDay() !== 5) {
        est.setDate(est.getDate() - 1);
      }
      est.setHours(16, 0, 0, 0);
      break;
  }

  return Math.floor(est.getTime() / 1000);
}

async function pollAndAnalyze(): Promise<void> {
  if (isPolling) {
    logger.debug("Skipping poll, previous poll still running");
    return;
  }

  isPolling = true;

  try {
    const threadType = getActiveThreadType();
    const thread = await findActiveThread(threadType);

    if (!thread) {
      logger.warn("No thread found, skipping poll");
      return;
    }

    // Fetch all comments from the thread; DB deduplicates via INSERT OR IGNORE
    const comments = await fetchThreadComments(thread, threadType);

    if (comments.length === 0) {
      logger.debug("No comments found in thread");
      return;
    }

    // Analyze and save each comment (dupes are ignored by DB)
    let newCount = 0;
    for (const comment of comments) {
      const result = analyzeSentiment(comment.body);
      const inserted = saveFullComment(
        comment.id,
        comment.body,
        comment.author,
        comment.createdUtc,
        comment.score,
        comment.threadId,
        comment.threadType,
        result.sentiment,
        result.confidence,
        result.tickers,
      );
      if (inserted) newCount++;
    }

    // Poll secondary threads during transition windows (e.g. weekend → overnight on Sunday 4 PM)
    const secondaryTypes = getSecondaryThreadTypes();
    for (const secType of secondaryTypes) {
      try {
        const secThread = await findActiveThread(secType);
        if (secThread) {
          const secComments = await fetchThreadComments(secThread, secType);
          for (const comment of secComments) {
            const result = analyzeSentiment(comment.body);
            const inserted = saveFullComment(
              comment.id,
              comment.body,
              comment.author,
              comment.createdUtc,
              comment.score,
              comment.threadId,
              comment.threadType,
              result.sentiment,
              result.confidence,
              result.tickers,
            );
            if (inserted) newCount++;
          }
          logger.info("Secondary thread polled", {
            threadType: secType,
            fetched: secComments.length,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Secondary thread poll failed", { threadType: secType, error: message });
      }
    }

    // Fetch top 10 WSB posts and their comments
    try {
      const topPostsRaw = await fetchTopPosts();
      const dateStr = getTradingDateString();

      let consecutivePostFailures = 0;
      for (const post of topPostsRaw) {
        // Bail if rate limited on multiple consecutive posts
        if (consecutivePostFailures >= 3) {
          logger.warn("Skipping remaining top posts after 3 consecutive failures", {
            processed: topPostsRaw.indexOf(post),
            total: topPostsRaw.length,
          });
          break;
        }

        // Analyze the post title for sentiment
        const titleResult = analyzeSentiment(post.title);
        const topPost: TopPost = {
          ...post,
          sentiment: titleResult.sentiment,
          confidence: titleResult.confidence,
          tickers: titleResult.tickers,
        };
        saveTopPost(topPost, dateStr);

        // Fetch and analyze comments from this post
        try {
          const postComments = await fetchPostComments(post.id, post.permalink);
          consecutivePostFailures = 0;
          for (const comment of postComments) {
            const result = analyzeSentiment(comment.body);
            const inserted = saveFullComment(
              comment.id,
              comment.body,
              comment.author,
              comment.createdUtc,
              comment.score,
              comment.threadId,
              comment.threadType,
              result.sentiment,
              result.confidence,
              result.tickers,
            );
            if (inserted) newCount++;
          }
        } catch {
          consecutivePostFailures++;
        }
      }

      logger.info("Top posts processed", {
        posts: topPostsRaw.length,
        date: dateStr,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Failed to fetch top posts", { error: message });
    }

    // Recompute daily sentiment from all comments in this period.
    // During transition windows (Sun 4 PM → Mon 7 AM), aggregate across all
    // thread types from the weekend start so the dashboard reflects the full picture.
    const hasSecondary = secondaryTypes.length > 0;
    const periodStart = hasSecondary
      ? getThreadStartUtc("weekend")
      : getThreadStartUtc(threadType);
    const counts = hasSecondary
      ? getCommentCountSince(periodStart)
      : getCommentCountSince(periodStart, threadType);
    const total = counts.bullish + counts.bearish + counts.neutral;

    if (total === 0) return;

    const bullishPercent = Math.round((counts.bullish / total) * 10000) / 100;
    const bearishPercent = Math.round((counts.bearish / total) * 10000) / 100;
    const neutralPercent =
      Math.round((100 - bullishPercent - bearishPercent) * 100) / 100;

    const recommendation = getInverseRecommendation(
      bullishPercent,
      bearishPercent,
    );

    const tradingDate = getTradingDateString();

    const dailySentiment: DailySentiment = {
      date: tradingDate,
      bullishCount: counts.bullish,
      bearishCount: counts.bearish,
      neutralCount: counts.neutral,
      totalComments: total,
      rawCommentCount: counts.rawTotal,
      bullishPercent,
      bearishPercent,
      neutralPercent,
      recommendation,
      threadType,
    };

    saveDailySentiment(dailySentiment);

    // Save historical entry for inverse strategy tracking
    const wsbSentiment =
      bullishPercent > bearishPercent ? "bullish" : "bearish";
    saveHistoricalEntry(tradingDate, wsbSentiment, recommendation);

    logger.info("Poll complete", {
      fetched: comments.length,
      new: newCount,
      total,
      bullishPercent,
      bearishPercent,
      recommendation,
      threadType,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Poll failed", { error: message });
  } finally {
    isPolling = false;
  }
}

export function startScheduler(): void {
  // Poll for new comments at the configured interval
  const intervalMs = config.sentiment.pollIntervalMs;
  logger.info("Starting comment poller", { intervalMs });

  // Import historical data feed from GitHub (fills in missed days for exe users)
  importDataFeed();

  // Initial poll + SPY backfill
  pollAndAnalyze();
  backfillSpyPrices();

  // Recurring poll
  setInterval(() => {
    pollAndAnalyze();
  }, intervalMs);

  // Update SPY prices daily at 5 PM EST (after market close + settlement)
  cron.schedule(
    "0 17 * * 1-5",
    () => {
      backfillSpyPrices();
    },
    { timezone: "America/New_York" },
  );

  // Fetch Cramer picks on startup + every 2 hours
  fetchCramerData();
  setInterval(
    () => {
      fetchCramerData();
    },
    2 * 60 * 60 * 1000,
  );

  // Trade bot: reset daily tracker at 9:29 AM, then evaluate + trade at 9:30 AM (market open).
  cron.schedule(
    "29 9 * * 1-5",
    () => {
      resetDailyTrades();
    },
    { timezone: "America/New_York" },
  );
  cron.schedule(
    "45 9 * * 1-5",
    () => {
      evaluateAndTrade();
    },
    { timezone: "America/New_York" },
  );

  // Trade bot: retry evaluation every 30 min if HOLD at open.
  // If sentiment was borderline at 9:45, new comments may tip the signal.
  // Stops at 11:00 AM — after that, 0DTE theta decay makes entry too risky.
  cron.schedule(
    "15,45 10 * * 1-5",
    () => {
      evaluateAndTrade();
    },
    { timezone: "America/New_York" },
  );
  cron.schedule(
    "0 11 * * 1-5",
    () => {
      evaluateAndTrade();
    },
    { timezone: "America/New_York" },
  );

  // Start the position monitor (checks option prices every 1s for exit logic)
  startPositionMonitor();

  // Trade bot: close all 0DTE positions at 3:45 PM EST (15 min before close).
  cron.schedule(
    "45 15 * * 1-5",
    () => {
      closeBeforeMarketClose();
    },
    { timezone: "America/New_York" },
  );

  // Capture daily equity snapshots at 4:01 PM EST (after market close).
  cron.schedule(
    "1 16 * * 1-5",
    () => {
      captureEquitySnapshots();
    },
    { timezone: "America/New_York" },
  );

  // Finalize daily sentiment at 4 PM EST (market close).
  // After this point, pollAndAnalyze() writes to the next trading day.
  cron.schedule(
    "0 16 * * 1-5",
    () => {
      finalizeDaySentiment();
    },
    { timezone: "America/New_York" },
  );

  // Also fetch Cramer picks at 8 PM EST (after Mad Money airs at 6 PM)
  cron.schedule(
    "0 20 * * 1-5",
    () => {
      fetchCramerData();
    },
    { timezone: "America/New_York" },
  );

  // Daily cleanup: purge old comments at midnight EST
  cron.schedule(
    "0 0 * * *",
    () => {
      purgeOldData();
    },
    { timezone: "America/New_York" },
  );

  logger.info("Scheduler started");
}

/**
 * Finalizes the current trading day's sentiment at 4 PM EST (market close).
 * Runs one last poll for the daily thread, then logs that the day is finalized.
 * Subsequent polls will accumulate sentiment under the next trading day.
 */
async function finalizeDaySentiment(): Promise<void> {
  try {
    // Run a final poll to capture any last-minute comments from the daily thread
    await pollAndAnalyze();
    logger.info("Daily sentiment finalized at market close", {
      finalizedDate: getTodayDateString(),
      nextTradingDate: getTradingDateString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to finalize daily sentiment", { error: message });
  }
}

/**
 * Fetches Cramer picks from CNBC RSS + QuiverQuant and saves to DB.
 */
async function fetchCramerData(): Promise<void> {
  try {
    const picks = await fetchAllCramerPicks();
    if (picks.length > 0) {
      saveCramerPicks(picks);
      logger.info("Cramer picks saved", { count: picks.length });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Cramer fetch failed", { error: message });
  }
}

/**
 * Backfills SPY price data for the last 90 days into the historical table.
 * Safe to call multiple times — uses ON CONFLICT DO UPDATE.
 */
async function backfillSpyPrices(): Promise<void> {
  try {
    const prices = await fetchSpyPrices(90);
    bulkUpsertSpyPrices(prices);
    logger.info("SPY price backfill complete", { days: prices.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("SPY price backfill failed", { error: message });
  }
}

// Allow manual trigger for API
export { pollAndAnalyze, backfillSpyPrices };
