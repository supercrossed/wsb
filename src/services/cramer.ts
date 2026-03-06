import Sentiment from "sentiment";
import { logger } from "../lib/logger";
import type { CramerPick, CramerIndex } from "../types";

const CNBC_MAD_MONEY_RSS =
  "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15838459";

const USER_AGENT = "Mozilla/5.0 (compatible; wsb-sentiment-bot/1.0)";

// Cramer-specific sentiment analyzer
const cramerAnalyzer = new Sentiment();

// Cramer-specific lexicon — words/phrases common in financial headlines
const CRAMER_LEXICON: Record<string, number> = {
  // Bullish signals
  "buy": 4, "buying": 3, "bullish": 4, "long": 3, "upgrade": 3,
  "opportunity": 3, "winner": 3, "winners": 3, "favorite": 3,
  "rally": 3, "higher": 2, "upside": 3, "breakout": 3,
  "benefiting": 2, "benefit": 2, "optimistic": 3, "confident": 2,
  "recommend": 2, "pick": 2, "picks": 2, "love": 2, "loves": 2,
  "exciting": 2, "outperform": 3, "beat": 2, "surge": 3,
  "soaring": 3, "momentum": 2, "growth": 2, "strong": 2,
  "rebound": 2, "recovery": 2, "comeback": 2, "shrugged": 1,

  // Bearish signals
  "sell": -4, "selling": -3, "bearish": -4, "short": -3, "downgrade": -3,
  "avoid": -3, "warns": -3, "warning": -3, "danger": -3, "dangerous": -3,
  "crash": -4, "crashing": -4, "fragile": -3, "fear": -2, "fears": -2,
  "caution": -2, "cautious": -2, "dire": -3, "risk": -2, "risky": -2,
  "apocalypse": -4, "trim": -2, "dump": -3, "dumping": -3,
  "hurt": -2, "pain": -2, "painful": -2, "plunge": -3, "drop": -2,
  "falling": -2, "decline": -2, "recession": -3, "trouble": -2,
  "struggle": -2, "struggles": -2, "selloff": -3, "downturn": -3,
  "volatile": -1, "volatility": -1, "overvalued": -2, "bubble": -3,
  "worst": -3, "weak": -2, "weakness": -2,

  // Neutral/hold signals (these reduce magnitude)
  "limbo": -1, "stuck": -1, "mixed": 0, "hold": 0, "wait": 0,
  "uncertain": -1, "unclear": -1, "sideways": 0, "flat": 0,
  "confused": -1, "conflicting": 0,
};

cramerAnalyzer.registerLanguage("en", { labels: CRAMER_LEXICON });

// Scored phrase patterns for Cramer headlines (more context-aware)
const CRAMER_PHRASES: Array<{ pattern: RegExp; score: number }> = [
  // Strong bullish
  { pattern: /\bdon'?t\s+give\s+up/i, score: 4 },
  { pattern: /\bstick\s+with/i, score: 3 },
  { pattern: /\bstay\s+invested/i, score: 3 },
  { pattern: /\bbuy(ing)?\s+(the\s+)?dip/i, score: 4 },
  { pattern: /\bis\s+a\s+buy/i, score: 4 },
  { pattern: /\ball\s+in\b/i, score: 4 },
  { pattern: /\bgo(ing)?\s+higher/i, score: 3 },
  { pattern: /\bgo(ing)?\s+much\s+higher/i, score: 4 },
  { pattern: /\bbuy(ing)?\s+opportunity/i, score: 4 },
  { pattern: /\bbet\s+on/i, score: 3 },
  { pattern: /\bmaking?\s+money/i, score: 3 },
  { pattern: /\bprint(ing)?\s+money/i, score: 3 },
  { pattern: /\bnot\s+bailing/i, score: 3 },
  { pattern: /\bnot\s+abandon/i, score: 3 },
  { pattern: /\bproves?\s+(to\s+be\s+)?a?\s*buying/i, score: 3 },
  { pattern: /\brenewed\s+.*faith/i, score: 3 },
  { pattern: /\bcan\s+go\s+higher/i, score: 3 },
  { pattern: /\bcheat\s+sheet/i, score: 2 },
  { pattern: /\babsolute\s+favorite/i, score: 4 },

  // Strong bearish
  { pattern: /\bdon'?t\s+touch/i, score: -4 },
  { pattern: /\bstay\s+away/i, score: -4 },
  { pattern: /\bnot\s+recommend/i, score: -3 },
  { pattern: /\btake\s+profits/i, score: -2 },
  { pattern: /\bget\s+out/i, score: -3 },
  { pattern: /\bstuck\s+in\s+limbo/i, score: -2 },
  { pattern: /\bwild\s+speculation/i, score: -3 },
  { pattern: /\bprisoners?\s+of\s+pessimism/i, score: -2 },
  { pattern: /\bdownfall/i, score: -3 },
  { pattern: /\bbearing?\s+the\s+brunt/i, score: -3 },
  { pattern: /\bai\s+(apocalypse|fears?|disruption)/i, score: -2 },
  { pattern: /\bmarket\s+fragile/i, score: -3 },

  // Neutral/hold
  { pattern: /\bweek\s+ahead/i, score: 0 },
  { pattern: /\bearnings\s+from/i, score: 0 },
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
 * Classify a direction string into bullish/bearish/neutral using NLP + patterns.
 */
function classifyDirection(text: string): "bullish" | "bearish" | "neutral" {
  const lower = text.toLowerCase().trim();

  // Check QuiverQuant exact matches first
  if (QV_BULLISH_DIRS.has(lower)) return "bullish";
  if (QV_BEARISH_DIRS.has(lower)) return "bearish";
  if (lower === "hold" || lower === "interview") return "neutral";

  // NLP analysis
  const nlpResult = cramerAnalyzer.analyze(text);
  const nlpScore = nlpResult.comparative * 10;

  // Phrase pattern scoring
  let phraseScore = 0;
  for (const { pattern, score } of CRAMER_PHRASES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      phraseScore += score;
    }
  }

  // Combined score: phrases get higher weight (more specific)
  const totalScore = nlpScore + (phraseScore * 1.5);

  if (totalScore > 1) return "bullish";
  if (totalScore < -1) return "bearish";
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
 * Uses the most recent cluster of activity: today + yesterday if available,
 * otherwise falls back to the most recent 3 days that have any data.
 */
export function computeCramerIndex(picks: CramerPick[]): CramerIndex {
  // Sort all picks by date descending
  const sorted = [...picks].sort((a, b) => b.date.localeCompare(a.date));

  // Get unique dates, take the most recent 3
  const uniqueDates = [...new Set(sorted.map((p) => p.date))].slice(0, 3);

  const recentPicks = sorted.filter((p) => uniqueDates.includes(p.date));

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
