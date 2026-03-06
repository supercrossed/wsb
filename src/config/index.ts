import path from "path";

export const config = {
  reddit: {
    userAgent: process.env.REDDIT_USER_AGENT ?? "wsb-sentiment-bot/1.0.0",
    subreddit: "wallstreetbets",
  },
  server: {
    port: parseInt(process.env.PORT ?? "3000", 10),
  },
  db: {
    path: path.resolve(__dirname, "../../data/wsb.db"),
  },
  sentiment: {
    // Rolling window in days
    historyDays: 90,
    // How often to poll for new comments (ms)
    pollIntervalMs: 60_000,
  },
  alpaca: {
    wsbKey: process.env.ALPACA_API_KEY_WSB ?? "",
    wsbSecret: process.env.ALPACA_API_SECRET_WSB ?? "",
    inverseKey: process.env.ALPACA_API_KEY_INVERSE ?? "",
    inverseSecret: process.env.ALPACA_API_SECRET_INVERSE ?? "",
    baseUrl:
      process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets",
    // Daily risk parameters
    maxLossPercent: 10,
    targetProfitPercent: 10,
    accountRiskPercent: 80,
  },
} as const;
