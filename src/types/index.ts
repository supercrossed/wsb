export interface RedditComment {
  id: string;
  body: string;
  author: string;
  createdUtc: number;
  threadId: string;
  threadType: ThreadType;
}

export type ThreadType = "daily" | "overnight" | "weekend";

export type Sentiment = "bullish" | "bearish" | "neutral";

export interface SentimentResult {
  sentiment: Sentiment;
  confidence: number;
  tickers: string[];
}

export interface CommentSentiment {
  commentId: string;
  sentiment: Sentiment;
  confidence: number;
  tickers: string[];
  createdUtc: number;
  threadType: ThreadType;
}

export interface DailySentiment {
  date: string;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  totalComments: number;
  bullishPercent: number;
  bearishPercent: number;
  neutralPercent: number;
  recommendation: "CALLS" | "PUTS" | "HOLD";
  threadType: ThreadType;
}

export interface HistoricalEntry {
  date: string;
  wsbSentiment: "bullish" | "bearish";
  inverseRecommendation: "BUY" | "SELL";
  spyOpen: number | null;
  spyClose: number | null;
  spyChange: number | null;
  inverseCorrect: boolean | null;
}

export interface TopPost {
  id: string;
  title: string;
  author: string;
  score: number;
  numComments: number;
  createdUtc: number;
  permalink: string;
  sentiment: Sentiment;
  confidence: number;
  tickers: string[];
}

// Cramer types
export interface CramerPick {
  ticker: string;
  direction: "bullish" | "bearish" | "neutral";
  rawDirection: string;
  date: string;
  source: "cnbc_rss" | "quiverquant";
  title: string;
}

export interface CramerIndex {
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  totalPicks: number;
  bullishPercent: number;
  bearishPercent: number;
  overallDirection: "bullish" | "bearish" | "neutral";
  recommendation: "CALLS" | "PUTS" | "HOLD";
  recentPicks: CramerPick[];
}

// Trade bot types
export type TradeBotMode = "wsb" | "inverse";

export interface AlpacaCredentials {
  apiKeyId: string;
  apiSecretKey: string;
  paperTrading: boolean;
}

export interface TradeBotConfig {
  id: number;
  mode: TradeBotMode;
  apiKeyId: string;
  apiSecretKey: string;
  paperTrading: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TradeBotStatus {
  running: boolean;
  mode: TradeBotMode;
  paperTrading: boolean;
  accountEquity: number | null;
  accountCash: number | null;
  lastTradeAt: string | null;
  positions: AlpacaPosition[];
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: string;
  marketValue: string;
  unrealizedPl: string;
  unrealizedPlpc: string;
  currentPrice: string;
  avgEntryPrice: string;
}

export interface TradeLog {
  id: number;
  timestamp: string;
  mode: TradeBotMode;
  action: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number | null;
  orderId: string | null;
  status: "submitted" | "filled" | "cancelled" | "error";
  message: string;
}
