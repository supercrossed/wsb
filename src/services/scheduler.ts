import cron from "node-cron";

import { config } from "../config";
import { logger } from "../lib/logger";
import {
  findActiveThread,
  fetchThreadComments,
  getActiveThreadType,
} from "./reddit";
import { analyzeSentiment, getInverseRecommendation } from "./sentiment";
import {
  saveFullComment,
  saveDailySentiment,
  getCommentCountSince,
  purgeOldData,
} from "./database";
import type { DailySentiment, ThreadType } from "../types";

let lastFetchUtc = 0;
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

    const comments = await fetchThreadComments(
      thread,
      threadType,
      lastFetchUtc,
    );

    if (comments.length === 0) {
      logger.debug("No new comments since last poll");
      return;
    }

    // Analyze and save each comment
    for (const comment of comments) {
      const result = analyzeSentiment(comment.body);
      saveFullComment(
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

      if (comment.createdUtc > lastFetchUtc) {
        lastFetchUtc = comment.createdUtc;
      }
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

    logger.info("Poll complete", {
      newComments: comments.length,
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

  // Initial poll
  pollAndAnalyze();

  // Recurring poll
  setInterval(() => {
    pollAndAnalyze();
  }, intervalMs);

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

// Allow manual trigger for API
export { pollAndAnalyze };
