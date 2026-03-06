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

// Future trade bot types
export interface TradeAccount {
  name: "wsb" | "inverse";
  apiKey: string;
  apiSecret: string;
}

export interface DailyTrade {
  date: string;
  account: "wsb" | "inverse";
  direction: "call" | "put";
  entryPrice: number;
  exitPrice: number | null;
  profitLoss: number | null;
  profitLossPercent: number | null;
  status: "open" | "closed" | "stopped";
}
