import { config } from "../config";
import { logger } from "../lib/logger";
import { AppError } from "../lib/app-error";
import type { RedditComment, ThreadType, TopPost } from "../types";

const BASE_URL = "https://www.reddit.com";
const USER_AGENT = config.reddit.userAgent;

// Rate limit: wait between requests to avoid 429s from public API
const REQUEST_DELAY_MS = 1500;

interface RedditListingChild {
  kind: string;
  data: {
    id: string;
    title?: string;
    body?: string;
    author: string;
    created_utc: number;
    stickied?: boolean;
    distinguished?: string | null;
    children?: string[];
    parent_id?: string;
    link_id?: string;
    score?: number;
    num_comments?: number;
    permalink?: string;
    replies?: { kind: string; data: { children: RedditListingChild[] } } | "";
  };
}

interface RedditListingResponse {
  kind: string;
  data: {
    children: RedditListingChild[];
    after: string | null;
  };
}

interface MoreChildrenResponse {
  json: {
    data: {
      things: RedditListingChild[];
    };
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function redditFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    logger.warn("Reddit rate limited, backing off 5s");
    await delay(5000);
    return redditFetch<T>(url);
  }

  if (!res.ok) {
    throw new AppError("Reddit API request failed", "REDDIT_HTTP_ERROR", {
      status: res.status,
      statusText: res.statusText,
      url,
    });
  }

  return res.json() as Promise<T>;
}

/**
 * Determines which thread type should be active based on current EST time.
 * - "daily": 7:00 AM - 3:59 PM EST weekdays
 * - "overnight": 4:00 PM - 6:59 AM EST next day weekdays
 * - "weekend": Friday 4:00 PM - Monday 6:59 AM
 */
export function getActiveThreadType(): ThreadType {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const hour = est.getHours();
  const day = est.getDay(); // 0=Sun, 6=Sat

  // Weekend: Sat all day, Sun all day, Fri after 4pm, Mon before 7am
  if (day === 0 || day === 6) return "weekend";
  if (day === 5 && hour >= 16) return "weekend";
  if (day === 1 && hour < 7) return "weekend";

  // Market hours
  if (hour >= 7 && hour < 16) return "daily";

  // Overnight
  return "overnight";
}

/**
 * Finds the active WSB discussion thread by fetching hot posts
 * from the public JSON endpoint.
 */
export async function findActiveThread(
  threadType: ThreadType,
): Promise<{ id: string; title: string; permalink: string } | null> {
  const searchQueries: Record<ThreadType, string[]> = {
    daily: ["daily discussion thread", "what are your moves today"],
    overnight: ["what are your moves tomorrow"],
    weekend: ["weekend discussion thread"],
  };

  const queries = searchQueries[threadType];

  try {
    const url = `${BASE_URL}/r/${config.reddit.subreddit}/hot.json?limit=15`;
    const listing = await redditFetch<RedditListingResponse>(url);

    for (const child of listing.data.children) {
      const post = child.data;
      const title = (post.title ?? "").toLowerCase();

      for (const query of queries) {
        if (title.includes(query)) {
          logger.info("Found active thread", {
            threadType,
            title: post.title,
            id: post.id,
          });
          return {
            id: post.id,
            title: post.title ?? "",
            permalink: `${BASE_URL}/r/${config.reddit.subreddit}/comments/${post.id}.json`,
          };
        }
      }
    }

    logger.warn("No active thread found", { threadType });
    return null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError("Failed to find active thread", "REDDIT_SEARCH_FAIL", {
      threadType,
      error: message,
    });
  }
}

/**
 * Fetches "more" comments using Reddit's morechildren API.
 * Processes in batches of 100 IDs (API limit).
 */
async function fetchMoreChildren(
  linkId: string,
  moreIds: string[],
): Promise<RedditListingChild[]> {
  const allComments: RedditListingChild[] = [];
  const batchSize = 100;

  for (let i = 0; i < moreIds.length; i += batchSize) {
    const batch = moreIds.slice(i, i + batchSize);
    const ids = batch.join(",");
    const url = `${BASE_URL}/api/morechildren.json?api_type=json&link_id=t3_${linkId}&children=${ids}`;

    try {
      await delay(REQUEST_DELAY_MS);
      const res = await redditFetch<MoreChildrenResponse>(url);

      if (res.json?.data?.things) {
        allComments.push(...res.json.data.things);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Failed to fetch more children batch", {
        batch: i / batchSize,
        error: message,
      });
    }
  }

  return allComments;
}

/**
 * Fetches top 10 non-stickied posts from WSB (hot).
 * Returns post metadata including title for sentiment analysis.
 */
export async function fetchTopPosts(): Promise<Omit<TopPost, "sentiment" | "confidence" | "tickers">[]> {
  const url = `${BASE_URL}/r/${config.reddit.subreddit}/hot.json?limit=25`;
  const listing = await redditFetch<RedditListingResponse>(url);

  const posts: Omit<TopPost, "sentiment" | "confidence" | "tickers">[] = [];

  for (const child of listing.data.children) {
    const p = child.data;
    // Skip stickied/mod posts and daily threads
    if (p.stickied || p.distinguished) continue;

    posts.push({
      id: p.id,
      title: p.title ?? "",
      author: p.author,
      score: p.score ?? 0,
      numComments: p.num_comments ?? 0,
      createdUtc: p.created_utc,
      permalink: `${BASE_URL}${p.permalink ?? ""}`,
    });

    if (posts.length >= 10) break;
  }

  logger.info("Fetched top posts", { count: posts.length });
  return posts;
}

/**
 * Fetches comments from a top post for sentiment analysis.
 * Lighter than thread fetching — only gets top-sorted comments, no morechildren expansion.
 */
export async function fetchPostComments(
  postId: string,
  permalink: string,
): Promise<RedditComment[]> {
  const comments: RedditComment[] = [];

  const url = `${permalink}.json?limit=200&sort=top`;
  await delay(REQUEST_DELAY_MS);

  try {
    const data = await redditFetch<RedditListingResponse[]>(url);
    if (!data[1]?.data?.children) return comments;

    function processComment(child: RedditListingChild): void {
      if (child.kind !== "t1") return;
      const c = child.data;
      if (!c.body || c.body === "[deleted]" || c.body === "[removed]") return;
      if (c.author === "AutoModerator" || c.author === "[deleted]") return;

      comments.push({
        id: c.id,
        body: c.body,
        author: c.author,
        createdUtc: c.created_utc,
        threadId: postId,
        threadType: "daily", // stored as daily for simplicity
      });

      if (c.replies && typeof c.replies === "object" && c.replies.data?.children) {
        for (const reply of c.replies.data.children) {
          processComment(reply);
        }
      }
    }

    for (const child of data[1].data.children) {
      processComment(child);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch post comments", { postId, error: message });
  }

  return comments;
}

/**
 * Fetches comments from a thread using the public JSON endpoint.
 * Recursively expands "more" comment stubs to get all comments.
 */
export async function fetchThreadComments(
  thread: { id: string; permalink: string },
  threadType: ThreadType,
): Promise<RedditComment[]> {
  try {
    const seenIds = new Set<string>();
    const comments: RedditComment[] = [];
    const allMoreIds: string[] = [];

    function processComment(child: RedditListingChild): void {
      const c = child.data;

      // Collect "more" comment IDs for expansion
      if (child.kind === "more" && c.children) {
        for (const id of c.children) {
          if (!seenIds.has(id)) {
            allMoreIds.push(id);
          }
        }
        return;
      }

      // Skip non-comment nodes
      if (child.kind !== "t1") return;

      // Deduplicate across sort passes
      if (seenIds.has(c.id)) return;
      seenIds.add(c.id);

      // Skip deleted/removed and bots
      if (!c.body || c.body === "[deleted]" || c.body === "[removed]") return;
      if (c.author === "AutoModerator" || c.author === "[deleted]") return;

      comments.push({
        id: c.id,
        body: c.body,
        author: c.author,
        createdUtc: c.created_utc,
        threadId: thread.id,
        threadType,
      });

      // Process nested replies recursively
      if (
        c.replies &&
        typeof c.replies === "object" &&
        c.replies.data?.children
      ) {
        for (const reply of c.replies.data.children) {
          processComment(reply);
        }
      }
    }

    // Fetch with multiple sort orders to maximize comment coverage.
    // Each sort surfaces different top-level comments and reply trees.
    const sorts = ["new", "old", "confidence", "top"];

    for (const sort of sorts) {
      const url = `${thread.permalink}?limit=500&sort=${sort}`;
      await delay(REQUEST_DELAY_MS);
      const data = await redditFetch<RedditListingResponse[]>(url);

      if (!data[1]?.data?.children) continue;

      for (const child of data[1].data.children) {
        processComment(child);
      }

      logger.debug("Sort pass complete", {
        sort,
        commentsNow: comments.length,
        moreIdsNow: allMoreIds.length,
      });
    }

    // Expand "more" comment stubs to get remaining comments
    // Deduplicate moreIds before fetching
    const uniqueMoreIds = allMoreIds.filter((id) => !seenIds.has(id));

    if (uniqueMoreIds.length > 0) {
      logger.info("Expanding more comments", {
        moreCount: uniqueMoreIds.length,
        threadId: thread.id,
      });

      const moreComments = await fetchMoreChildren(thread.id, uniqueMoreIds);

      for (const child of moreComments) {
        processComment(child);
      }

      logger.info("Expanded more comments", {
        expanded: moreComments.length,
        totalNow: comments.length,
      });
    }

    logger.info("Fetched comments", {
      threadType,
      count: comments.length,
      threadId: thread.id,
    });

    return comments;
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError("Failed to fetch comments", "REDDIT_FETCH_FAIL", {
      threadId: thread.id,
      error: message,
    });
  }
}
