import { logger } from "../lib/logger";
import type { CramerPick, CramerIndex } from "../types";

const CNBC_MAD_MONEY_RSS =
  "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15838459";

const USER_AGENT = "Mozilla/5.0 (compatible; wsb-sentiment-bot/1.0)";

// Direction keywords found in CNBC article titles and QuiverQuant data
const BULLISH_PATTERNS = [
  /\bbuy\b/i,
  /\bbullish\b/i,
  /\blong\b/i,
  /\bupgrade/i,
  /\bgo(ing)?\s+higher/i,
  /\bopportunity/i,
  /\bwinner/i,
  /\bfavorite/i,
  /\bown(s)?\b/i,
  /\bstick\s+with/i,
  /\bstay\s+invested/i,
  /\bdon'?t\s+give\s+up/i,
  /\bbuy(ing)?\s+(the\s+)?dip/i,
  /\bis\s+a\s+buy/i,
  /\bpick(s)?\b/i,
  /\bpositive/i,
  /\brally/i,
  /\ball\s+in\b/i,
  /\brecommend(s)?\b/i,
  /\bbet\s+on/i,
];

const BEARISH_PATTERNS = [
  /\bsell\b/i,
  /\bbearish\b/i,
  /\bshort\b/i,
  /\bdowngrade/i,
  /\bavoid/i,
  /\bstay\s+away/i,
  /\bwarns?\b/i,
  /\bdanger/i,
  /\bcrash/i,
  /\bfragile/i,
  /\bfears?\b/i,
  /\bcaution/i,
  /\bdire/i,
  /\brisk/i,
  /\bapocalypse/i,
  /\bdon'?t\s+touch/i,
  /\bnot\s+recommend/i,
  /\btrim\b/i,
];

// QuiverQuant direction mappings
const QV_BULLISH_DIRS = new Set([
  "bullish", "buy", "long", "positive", "buy on a pullback",
]);
const QV_BEARISH_DIRS = new Set([
  "bearish", "sell", "short", "negative", "sell on a pop",
  "not recommending", "trim",
]);

/**
 * Classify a direction string into bullish/bearish/neutral.
 */
function classifyDirection(text: string): "bullish" | "bearish" | "neutral" {
  const lower = text.toLowerCase().trim();

  // Check QuiverQuant exact matches first
  if (QV_BULLISH_DIRS.has(lower)) return "bullish";
  if (QV_BEARISH_DIRS.has(lower)) return "bearish";
  if (lower === "hold" || lower === "interview") return "neutral";

  // Pattern-based classification for article titles
  let bullishScore = 0;
  let bearishScore = 0;

  for (const p of BULLISH_PATTERNS) {
    if (p.test(text)) bullishScore++;
  }
  for (const p of BEARISH_PATTERNS) {
    if (p.test(text)) bearishScore++;
  }

  if (bullishScore > bearishScore) return "bullish";
  if (bearishScore > bullishScore) return "bearish";
  return "neutral";
}

/**
 * Extract stock tickers from text.
 */
function extractTickers(text: string): string[] {
  const tickers = new Set<string>();
  const patterns = [
    /\$([A-Z]{1,5})\b/g,
    /\b(SPY|QQQ|AAPL|TSLA|NVDA|AMD|AMZN|GOOG|GOOGL|META|MSFT|NFLX|GME|AMC|PLTR|SOFI|GS|MS|SMCI|MU|WDC|COIN|AVGO|DELL|CRM|ORCL|PANW|HUBS|NOW)\b/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      tickers.add(match[1]);
    }
  }
  return Array.from(tickers);
}

/**
 * Parse a simple XML tag value from an RSS item.
 */
function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/**
 * Parse RSS date to YYYY-MM-DD.
 */
function parseRssDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Fetches and parses CNBC Mad Money RSS feed for Cramer's picks.
 */
export async function fetchCnbcCramerPicks(): Promise<CramerPick[]> {
  try {
    const response = await fetch(CNBC_MAD_MONEY_RSS, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok) {
      throw new Error(`CNBC RSS returned ${response.status}`);
    }

    const xml = await response.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const picks: CramerPick[] = [];

    for (const item of items) {
      const title = xmlTag(item, "title");
      const pubDate = xmlTag(item, "pubDate");
      const description = xmlTag(item, "description");
      const date = parseRssDate(pubDate);

      if (!title || !date) continue;

      const fullText = `${title} ${description}`;
      const direction = classifyDirection(fullText);
      const tickers = extractTickers(fullText);

      // Create a pick for each ticker mentioned, or one general pick
      if (tickers.length > 0) {
        for (const ticker of tickers) {
          picks.push({
            ticker,
            direction,
            rawDirection: direction,
            date,
            source: "cnbc_rss",
            title,
          });
        }
      } else {
        // General market commentary — still counts for overall index
        picks.push({
          ticker: "MARKET",
          direction,
          rawDirection: direction,
          date,
          source: "cnbc_rss",
          title,
        });
      }
    }

    logger.info("Fetched CNBC Cramer picks", { count: picks.length });
    return picks;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch CNBC Cramer picks", { error: message });
    return [];
  }
}

/**
 * Fetches and parses QuiverQuant Cramer tracker page.
 * The page server-renders a table of recent picks.
 */
export async function fetchQuiverCramerPicks(): Promise<CramerPick[]> {
  try {
    const response = await fetch("https://www.quiverquant.com/cramertracker/", {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok) {
      throw new Error(`QuiverQuant returned ${response.status}`);
    }

    const html = await response.text();
    const picks: CramerPick[] = [];

    // Parse table rows — format: ticker | direction | date | return
    // Look for rows containing ticker links like /stock/TICKER/
    const rowPattern = /\/stock\/([A-Z]{1,5})\/[^>]*>[\s\S]*?<\/a>\s*(?:<[^>]+>\s*)*([^<]+)(?:<[^>]+>\s*)*([A-Z][a-z]{2}\.\s*\d{1,2},\s*\d{4})/g;
    let match: RegExpExecArray | null;

    while ((match = rowPattern.exec(html)) !== null) {
      const ticker = match[1];
      const rawDirection = match[2].trim();
      const dateStr = match[3].trim();

      // Parse "Feb. 6, 2026" format
      const d = new Date(dateStr.replace(/\./g, ""));
      if (isNaN(d.getTime())) continue;

      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const direction = classifyDirection(rawDirection);

      picks.push({
        ticker,
        direction,
        rawDirection,
        date,
        source: "quiverquant",
        title: `${ticker}: ${rawDirection}`,
      });
    }

    logger.info("Fetched QuiverQuant Cramer picks", { count: picks.length });
    return picks;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch QuiverQuant Cramer picks", { error: message });
    return [];
  }
}

/**
 * Fetches picks from all sources and deduplicates.
 */
export async function fetchAllCramerPicks(): Promise<CramerPick[]> {
  const [cnbcPicks, quiverPicks] = await Promise.all([
    fetchCnbcCramerPicks(),
    fetchQuiverCramerPicks(),
  ]);

  // Dedupe: prefer QuiverQuant for ticker-specific picks (more structured),
  // CNBC for general market commentary
  const seen = new Set<string>();
  const all: CramerPick[] = [];

  // QuiverQuant first (more precise)
  for (const pick of quiverPicks) {
    const key = `${pick.ticker}:${pick.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(pick);
    }
  }

  // Then CNBC
  for (const pick of cnbcPicks) {
    const key = `${pick.ticker}:${pick.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(pick);
    }
  }

  return all;
}

/**
 * Computes the Cramer Index from a set of picks.
 * Considers picks from the last N days.
 */
export function computeCramerIndex(picks: CramerPick[], days: number = 7): CramerIndex {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const recentPicks = picks
    .filter((p) => p.date >= cutoffStr)
    .sort((a, b) => b.date.localeCompare(a.date));

  const bullishCount = recentPicks.filter((p) => p.direction === "bullish").length;
  const bearishCount = recentPicks.filter((p) => p.direction === "bearish").length;
  const neutralCount = recentPicks.filter((p) => p.direction === "neutral").length;
  const total = recentPicks.length;

  const bullishPercent = total > 0 ? Math.round((bullishCount / total) * 10000) / 100 : 0;
  const bearishPercent = total > 0 ? Math.round((bearishCount / total) * 10000) / 100 : 0;

  let overallDirection: "bullish" | "bearish" | "neutral" = "neutral";
  if (bullishCount > bearishCount) overallDirection = "bullish";
  else if (bearishCount > bullishCount) overallDirection = "bearish";

  // Cramer's recommendation (what Cramer would say)
  let recommendation: "CALLS" | "PUTS" | "HOLD" = "HOLD";
  if (overallDirection === "bullish") recommendation = "CALLS";
  else if (overallDirection === "bearish") recommendation = "PUTS";

  return {
    bullishCount,
    bearishCount,
    neutralCount,
    totalPicks: total,
    bullishPercent,
    bearishPercent,
    overallDirection,
    recommendation,
    recentPicks: recentPicks.slice(0, 20),
  };
}
