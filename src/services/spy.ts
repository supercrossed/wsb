import { logger } from "../lib/logger";

interface YahooQuote {
  timestamp: number[];
  indicators: {
    quote: Array<{
      open: number[];
      close: number[];
      high: number[];
      low: number[];
      volume: number[];
    }>;
  };
}

interface SpyDailyPrice {
  date: string;
  open: number;
  close: number;
  change: number;
  changePercent: number;
}

/**
 * Fetches SPY price data from Yahoo Finance's public chart API.
 * No API key required — this uses the same endpoint as the Yahoo Finance website.
 */
export async function fetchSpyPrices(days: number = 90): Promise<SpyDailyPrice[]> {
  const period1 = Math.floor(Date.now() / 1000) - days * 86400;
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${period1}&period2=${period2}&interval=1d`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; wsb-sentiment-bot/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as { chart?: { result?: YahooQuote[] } };
  const result = data?.chart?.result?.[0];

  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error("Unexpected Yahoo Finance response structure");
  }

  const { timestamp, indicators } = result;
  const quote = indicators.quote[0];
  const prices: SpyDailyPrice[] = [];

  for (let i = 0; i < timestamp.length; i++) {
    const open = quote.open[i];
    const close = quote.close[i];

    if (open == null || close == null) continue;

    const date = new Date(timestamp[i] * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    prices.push({
      date: `${year}-${month}-${day}`,
      open: Math.round(open * 100) / 100,
      close: Math.round(close * 100) / 100,
      change: Math.round((close - open) * 100) / 100,
      changePercent: Math.round(((close - open) / open) * 10000) / 100,
    });
  }

  logger.info("Fetched SPY prices", { days: prices.length });
  return prices;
}

/**
 * Fetches just today's SPY quote (current price + daily change).
 */
export async function fetchSpyToday(): Promise<SpyDailyPrice | null> {
  try {
    const prices = await fetchSpyPrices(5);
    return prices.length > 0 ? prices[prices.length - 1] : null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch today's SPY price", { error: message });
    return null;
  }
}
