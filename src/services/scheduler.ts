import cron from "node-cron";

import { config } from "../config";
import { logger } from "../lib/logger";
import {
  findActiveThread,
  fetchThreadComments,
  fetchTopPosts,
  fetchPostComments,
  getActiveThreadType,
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
        comment.threadId,
        comment.threadType,
        result.sentiment,
        result.confidence,
        result.tickers,
      );
      if (inserted) newCount++;
    }

    // Fetch top 10 WSB posts and their comments
    try {
      const topPostsRaw = await fetchTopPosts();
      const dateStr = getTodayDateString();

      for (const post of topPostsRaw) {
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
        const postComments = await fetchPostComments(post.id, post.permalink);
        for (const comment of postComments) {
          const result = analyzeSentiment(comment.body);
          const inserted = saveFullComment(
            comment.id,
            comment.body,
            comment.author,
            comment.createdUtc,
            comment.threadId,
            comment.threadType,
            result.sentiment,
            result.confidence,
            result.tickers,
          );
          if (inserted) newCount++;
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

    // Recompute daily sentiment from all comments in this period
    const periodStart = getThreadStartUtc(threadType);
    const counts = getCommentCountSince(periodStart, threadType);
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

    const dailySentiment: DailySentiment = {
      date: getTodayDateString(),
      bullishCount: counts.bullish,
      bearishCount: counts.bearish,
      neutralCount: counts.neutral,
      totalComments: total,
      bullishPercent,
      bearishPercent,
      neutralPercent,
      recommendation,
      threadType,
    };

    saveDailySentiment(dailySentiment);

    // Save historical entry for inverse strategy tracking
    const wsbSentiment = bullishPercent > bearishPercent ? "bullish" : "bearish";
    saveHistoricalEntry(getTodayDateString(), wsbSentiment, recommendation);

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
  setInterval(() => {
    fetchCramerData();
  }, 2 * 60 * 60 * 1000);

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
export { pollAndAnalyze };
