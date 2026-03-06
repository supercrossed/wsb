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

interface SpyRealtimeQuote {
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  marketState: string;
  updatedAt: number;
}

interface YahooMeta {
  regularMarketPrice: number;
  previousClose: number;
  chartPreviousClose: number;
  currentTradingPeriod?: {
    pre?: { start: number; end: number };
    regular?: { start: number; end: number };
    post?: { start: number; end: number };
  };
}

interface YahooChartResult {
  meta: YahooMeta;
  timestamp?: number[];
  indicators?: {
    quote: Array<{
      open: number[];
      close: number[];
      high: number[];
      low: number[];
      volume: number[];
    }>;
  };
}

// Cache real-time quote for 10 seconds to avoid excessive API calls
let realtimeCache: { data: SpyRealtimeQuote; fetchedAt: number } | null = null;
const REALTIME_CACHE_MS = 10_000;

/**
 * Fetches the current SPY price in near-real-time (includes pre/post market).
 * Uses Yahoo Finance's quote endpoint which returns the latest trade price
 * regardless of market session.
 */
export async function fetchSpyRealtime(): Promise<SpyRealtimeQuote | null> {
  if (realtimeCache && Date.now() - realtimeCache.fetchedAt < REALTIME_CACHE_MS) {
    return realtimeCache.data;
  }

  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=1m&includePrePost=true";

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; wsb-sentiment-bot/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { chart?: { result?: YahooChartResult[] } };
    const result = data?.chart?.result?.[0];

    if (!result?.meta) {
      throw new Error("Unexpected Yahoo Finance response structure");
    }

    const { meta } = result;
    const previousClose = meta.previousClose ?? meta.chartPreviousClose;

    // Use the latest data point from the chart for pre/post market prices
    // meta.regularMarketPrice only reflects the regular session close
    let currentPrice = meta.regularMarketPrice;
    if (result.timestamp && result.indicators?.quote?.[0]) {
      const closes = result.indicators.quote[0].close;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          currentPrice = closes[i];
          break;
        }
      }
    }
    const change = Math.round((currentPrice - previousClose) * 100) / 100;
    const changePercent = Math.round((change / previousClose) * 10000) / 100;

    // Determine market state from trading periods
    const now = Math.floor(Date.now() / 1000);
    const periods = meta.currentTradingPeriod;
    let marketState = "closed";
    if (periods?.regular && now >= periods.regular.start && now < periods.regular.end) {
      marketState = "regular";
    } else if (periods?.pre && now >= periods.pre.start && now < periods.pre.end) {
      marketState = "pre";
    } else if (periods?.post && now >= periods.post.start && now < periods.post.end) {
      marketState = "post";
    }

    const quote: SpyRealtimeQuote = {
      price: Math.round(currentPrice * 100) / 100,
      previousClose: Math.round(previousClose * 100) / 100,
      change,
      changePercent,
      marketState,
      updatedAt: Date.now(),
    };

    realtimeCache = { data: quote, fetchedAt: Date.now() };
    return quote;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch realtime SPY quote", { error: message });
    return realtimeCache?.data ?? null;
  }
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
