import type { Sentiment, SentimentResult } from "../types";

// Bullish keywords/phrases common on WSB
const BULLISH_PATTERNS: RegExp[] = [
  /\bcalls?\b/i,
  /\bbullish\b/i,
  /\bmoon(ing)?\b/i,
  /\brocket\b/i,
  /\btendie(s)?\b/i,
  /\bLFG\b/,
  /\bbuy(ing)?\s+(the\s+)?dip\b/i,
  /\blong\b/i,
  /\bsqueeze\b/i,
  /\bgreen\b/i,
  /\bpump(ing)?\b/i,
  /\brally\b/i,
  /\bbreakout\b/i,
  /\bupside\b/i,
  /\bbottom(ed)?\s*(out)?\b/i,
  /\bload(ing)?\s*(up)?\b/i,
  /\ball\s*in\b/i,
  /\bATH\b/,
  /\bbull\s*run\b/i,
  /\bgonna\s*(rip|fly|print)\b/i,
  /\bfree\s*money\b/i,
  /\bshort\s*squeeze\b/i,
  /\bgap\s*up\b/i,
  /\b(huge|big|massive)\s*(green|gain|win)\b/i,
  /\bto\s*the\s*moon\b/i,
  /\bdiamonds?\s*hands?\b/i,
  /\b(SPY|QQQ|ES)\s*\d{3,4}\s*c\b/i,
  /\b0dte\s*call/i,
];

// Bearish keywords/phrases common on WSB
const BEARISH_PATTERNS: RegExp[] = [
  /\bputs?\b/i,
  /\bbearish\b/i,
  /\bcrash(ing)?\b/i,
  /\bdrill(ing)?\b/i,
  /\bred\b/i,
  /\bdump(ing)?\b/i,
  /\btank(ing)?\b/i,
  /\brug\s*pull\b/i,
  /\bshort(ing)?\b/i,
  /\bbag\s*hold(ing|er)?\b/i,
  /\brecession\b/i,
  /\bdownside\b/i,
  /\bdead\s*cat\b/i,
  /\bover(sold|bought)\b/i,
  /\bsell(ing)?\s*off\b/i,
  /\bcollapse\b/i,
  /\bfade\b/i,
  /\bgap\s*down\b/i,
  /\b(huge|big|massive)\s*(red|loss|drop)\b/i,
  /\bGUH\b/,
  /\bwrecked\b/i,
  /\bblood\s*(bath|red)\b/i,
  /\bfuk\b/i,
  /\bcliff\b/i,
  /\b(SPY|QQQ|ES)\s*\d{3,4}\s*p\b/i,
  /\b0dte\s*put/i,
];

// Common ticker pattern: $TICKER or just uppercase 2-5 letter words that look like tickers
const TICKER_PATTERN = /\$([A-Z]{1,5})\b/g;
const BARE_TICKER_PATTERN = /\b(SPY|QQQ|AAPL|TSLA|NVDA|AMD|AMZN|GOOG|GOOGL|META|MSFT|NFLX|GME|AMC|PLTR|SOFI|RIVN|NIO|BABA|COIN|MARA|RIOT)\b/g;

function extractTickers(text: string): string[] {
  const tickers = new Set<string>();

  let match: RegExpExecArray | null;

  TICKER_PATTERN.lastIndex = 0;
  while ((match = TICKER_PATTERN.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  BARE_TICKER_PATTERN.lastIndex = 0;
  while ((match = BARE_TICKER_PATTERN.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  return Array.from(tickers);
}

function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

export function analyzeSentiment(text: string): SentimentResult {
  const bullishScore = countMatches(text, BULLISH_PATTERNS);
  const bearishScore = countMatches(text, BEARISH_PATTERNS);
  const totalScore = bullishScore + bearishScore;

  let sentiment: Sentiment;
  let confidence: number;

  if (totalScore === 0) {
    sentiment = "neutral";
    confidence = 0;
  } else if (bullishScore > bearishScore) {
    sentiment = "bullish";
    confidence = bullishScore / totalScore;
  } else if (bearishScore > bullishScore) {
    sentiment = "bearish";
    confidence = bearishScore / totalScore;
  } else {
    sentiment = "neutral";
    confidence = 0.5;
  }

  return {
    sentiment,
    confidence: Math.round(confidence * 100) / 100,
    tickers: extractTickers(text),
  };
}

export function getInverseRecommendation(
  bullishPercent: number,
  bearishPercent: number,
): "BUY" | "SELL" | "HOLD" {
  // Inverse WSB: if WSB is bullish, we sell. If bearish, we buy.
  const spread = Math.abs(bullishPercent - bearishPercent);

  // Need at least 10% spread to make a directional call
  if (spread < 10) return "HOLD";

  if (bullishPercent > bearishPercent) return "SELL";
  return "BUY";
}
