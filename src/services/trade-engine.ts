import { logger } from "../lib/logger";
import {
  getAccount,
  getOptionsChain,
  getOptionQuote,
  getOptionSnapshot,
  placeOptionsOrder,
  closePosition,
  getPositions,
} from "./alpaca";
import type { OptionGreeks } from "./alpaca";
import {
  getAllTradeBotConfigs,
  insertTradeLog,
  getTimeDecayedSentiment,
  insertTradeRound,
  closeTradeRound,
  insertEquitySnapshot,
} from "./database";
import { getInverseRecommendation } from "./sentiment";

import { isBotRunning } from "./tradebot";
import { fetchSpyRealtime, fetchVix } from "./spy";
import type { AlpacaCredentials, RiskLevel, TradeBotConfig } from "../types";

/**
 * Risk level → percentage of portfolio equity to allocate per trade.
 */
const RISK_ALLOCATION: Record<RiskLevel, number> = {
  safe: 0.3, // 30% of portfolio
  degen: 0.5, // 50% of portfolio
  yolo: 0.7, // 70% of portfolio
};

/** Profit target: sell when option is up 10% from entry */
const PROFIT_TARGET_PCT = 0.1;

/** Hard stop loss: sell immediately when option is down 20% from entry */
const STOP_LOSS_PCT = 0.2;

/**
 * Momentum trailing: once profit exceeds 10%, switch to trailing stop.
 * The trailing stop is set at 50% of unrealized profit.
 * e.g., if option is up 30%, trailing stop triggers at +15%.
 */
const TRAILING_STOP_RATIO = 0.5;

/**
 * Strike selection zones:
 * - Primary: ATM to 1.5% OTM (best delta, highest probability of profit)
 * - Extended: 1.5% to 3% OTM (used when primary zone is unaffordable)
 * Within each zone, pick the strike that maximizes contracts × proximity score.
 */
const MAX_OTM_PERCENT = 0.015;
const EXTENDED_OTM_PERCENT = 0.03;

/**
 * Risk-level-aware Greeks constraints.
 * Safe: conservative — require meaningful delta, cap IV to avoid overpaying.
 * Degen: moderate — lower delta floor, higher IV tolerance.
 * YOLO: aggressive — search the full extended zone upfront, no Greeks filters.
 */
interface RiskGreeksConfig {
  minDelta: number;        // minimum abs(delta) to consider a contract
  maxIV: number;           // maximum implied volatility (e.g., 0.5 = 50%)
  searchExtendedFirst: boolean; // if true, search ATM→3% OTM in one pass
}

const RISK_GREEKS: Record<RiskLevel, RiskGreeksConfig> = {
  safe:  { minDelta: 0.20, maxIV: 0.30, searchExtendedFirst: false },
  degen: { minDelta: 0.05, maxIV: 0.50, searchExtendedFirst: false },
  yolo:  { minDelta: 0.00, maxIV: 1.00, searchExtendedFirst: true },
};

/**
 * VIX-based position-size multiplier per risk level.
 * Higher VIX = more cautious for safe, neutral for yolo.
 */
type VixRegime = "calm" | "normal" | "elevated" | "high" | "extreme";

interface VixMultiplierResult {
  multiplier: number;
  regime: VixRegime;
  skip: boolean;
}

function getVixMultiplier(vixLevel: number, riskLevel: RiskLevel): VixMultiplierResult {
  if (vixLevel < 15) return { multiplier: 1.0, regime: "calm", skip: false };
  if (vixLevel < 20) return { multiplier: 1.0, regime: "normal", skip: false };

  if (vixLevel < 25) {
    const m = { safe: 0.75, degen: 1.0, yolo: 1.25 }[riskLevel];
    return { multiplier: m, regime: "elevated", skip: false };
  }
  if (vixLevel < 30) {
    const m = { safe: 0.5, degen: 0.75, yolo: 1.0 }[riskLevel];
    return { multiplier: m, regime: "high", skip: false };
  }

  // VIX 30+: extreme — safe skips entirely
  const m = { safe: 0.0, degen: 0.5, yolo: 1.0 }[riskLevel];
  return { multiplier: m, regime: "extreme", skip: riskLevel === "safe" };
}

/**
 * VIX-adjusted stop loss and profit target.
 * Wider stops in high-vol to avoid whipsaw exits.
 */
function getVixAdjustedExitParams(vixLevel: number): { stopLossPct: number; profitTargetPct: number } {
  if (vixLevel < 20) return { stopLossPct: STOP_LOSS_PCT, profitTargetPct: PROFIT_TARGET_PCT };
  if (vixLevel < 25) return { stopLossPct: 0.25, profitTargetPct: 0.15 };
  if (vixLevel < 30) return { stopLossPct: 0.30, profitTargetPct: 0.20 };
  return { stopLossPct: 0.35, profitTargetPct: 0.25 };
}

/** Interval for monitoring open positions (ms) */
const MONITOR_INTERVAL_MS = 5_000; // check every 5 seconds

/** Latest time to enter a 0DTE trade (11:00 AM EST = 660 minutes).
 *  After this, theta decay makes entry too risky. */
const ENTRY_CUTOFF_MINUTES = 660;

/**
 * Tracks whether we've placed a trade today for each bot key.
 * Reset daily at market open.
 */
const tradedToday: Map<string, boolean> = new Map();

/**
 * Tracks active positions for exit logic.
 * Key: botKey, Value: position details with entry price.
 */
interface ActivePosition {
  botKey: string;
  mode: "wsb" | "inverse";
  paperTrading: boolean;
  optionSymbol: string;
  entryPrice: number;
  qty: number;
  highWaterMark: number; // highest price seen (for trailing stop)
  creds: AlpacaCredentials;
  tradeRoundId: number; // links to trade_rounds.id
  stopLossPct: number;
  profitTargetPct: number;
  vixAtEntry: number | null;
}

const activePositions: Map<string, ActivePosition> = new Map();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Resets the daily trade tracker. Called at market open.
 */
export function resetDailyTrades(): void {
  tradedToday.clear();
  activePositions.clear();
  logger.info("Daily trade tracker reset");
}

function getTodayEST(): string {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const year = est.getFullYear();
  const month = String(est.getMonth() + 1).padStart(2, "0");
  const day = String(est.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isMarketHours(): boolean {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const hours = est.getHours();
  const minutes = est.getMinutes();
  const timeMinutes = hours * 60 + minutes;
  return timeMinutes >= 570 && timeMinutes < 960; // 9:30 AM - 4:00 PM
}

function parseExitReason(reason: string): string {
  if (reason.startsWith("Stop loss")) return "stop_loss";
  if (reason.startsWith("Market close")) return "eod_close";
  if (reason.startsWith("Trailing stop")) return "trailing_stop";
  if (reason.startsWith("Momentum fade")) return "momentum_fade";
  return "other";
}

function isNearClose(): boolean {
  const now = new Date();
  const est = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const hours = est.getHours();
  const minutes = est.getMinutes();
  const timeMinutes = hours * 60 + minutes;
  return timeMinutes >= 945 && timeMinutes < 960; // 3:45 PM - 4:00 PM
}

interface ScoredOption {
  symbol: string;
  strikePrice: number;
  type: "call" | "put";
  estimatedPrice: number;
  score: number;
  greeks: OptionGreeks | null;
}

/**
 * Scores candidates from a given OTM zone and returns the best option.
 * Uses real Greeks from Alpaca snapshots when available:
 *   Score = (contracts we can buy) × abs(delta)
 * Falls back to proximity heuristic if Greeks are unavailable.
 *
 * Greeks constraints (from risk level) filter out contracts that don't
 * meet the minimum delta or exceed the max IV threshold.
 */
async function scoreCandidates(
  creds: AlpacaCredentials,
  candidates: { symbol: string; strikePrice: number; type: "call" | "put"; tradable: boolean; closePrice: number | null }[],
  optionType: "call" | "put",
  spyPrice: number,
  budget: number,
  zoneMaxOtm: number,
  greeksConfig: RiskGreeksConfig,
): Promise<ScoredOption | null> {
  let bestScore = -1;
  let bestOption: ScoredOption | null = null;

  let skippedNoPrice = 0;
  let skippedDelta = 0;
  let skippedIV = 0;
  let skippedCost = 0;
  let skippedSnap = 0;

  for (const c of candidates) {
    let price: number;
    let greeks: OptionGreeks | null = null;

    try {
      const snap = await getOptionSnapshot(creds, c.symbol);
      price = snap.midPrice > 0 ? snap.midPrice : snap.askPrice;
      greeks = snap.greeks;
    } catch {
      price = c.closePrice ?? 0;
      skippedSnap++;
    }

    if (price <= 0) { skippedNoPrice++; continue; }

    // Apply Greeks filters when data is available
    if (greeks) {
      if (Math.abs(greeks.delta) < greeksConfig.minDelta) { skippedDelta++; continue; }
      if (greeks.impliedVolatility > greeksConfig.maxIV) { skippedIV++; continue; }
    }

    const contractCost = price * 100;
    const numContracts = Math.floor(budget / contractCost);
    if (numContracts < 1) { skippedCost++; continue; }

    // Use real delta if available; fall back to proximity heuristic
    let sensitivity: number;
    if (greeks && Math.abs(greeks.delta) > 0) {
      sensitivity = Math.abs(greeks.delta);
    } else {
      const otmDistance =
        optionType === "call"
          ? (c.strikePrice - spyPrice) / spyPrice
          : (spyPrice - c.strikePrice) / spyPrice;
      sensitivity = Math.max(
        0.3,
        1.0 - (otmDistance / zoneMaxOtm) * 0.7,
      );
    }

    // Score = contracts × delta — maximizes total dollar exposure per $1 SPY move
    const score = numContracts * sensitivity;

    if (score > bestScore) {
      bestScore = score;
      bestOption = {
        symbol: c.symbol,
        strikePrice: c.strikePrice,
        type: optionType,
        estimatedPrice: price,
        score,
        greeks,
      };
    }
  }

  logger.info("Score candidates result", {
    candidates: candidates.length,
    skippedNoPrice,
    skippedSnapshot: skippedSnap,
    skippedDelta,
    skippedIV,
    skippedCost,
    selected: bestOption ? bestOption.symbol : "none",
    bestScore: bestOption ? bestScore : 0,
  });

  return bestOption;
}

/**
 * Selects the optimal 0DTE option contract to maximize potential wins.
 *
 * Two-pass strategy:
 * 1. Primary zone (ATM → 1.5% OTM): best delta, highest probability of profit.
 * 2. Extended zone (1.5% → 3% OTM): used only when nothing in the primary zone
 *    is affordable. Lower delta but still moves meaningfully on 1%+ SPY swings.
 *
 * Within each zone, score = (contracts we can buy) × (proximity factor).
 * This balances cheaper OTM (more leverage) vs closer to ATM (higher delta).
 */
async function selectOption(
  creds: AlpacaCredentials,
  signal: "CALLS" | "PUTS",
  spyPrice: number,
  budget: number,
  riskLevel: RiskLevel,
): Promise<{
  symbol: string;
  strikePrice: number;
  type: "call" | "put";
  estimatedPrice: number;
  greeks: OptionGreeks | null;
} | null> {
  const today = getTodayEST();
  const optionType = signal === "CALLS" ? "call" : "put";
  const greeksConfig = RISK_GREEKS[riskLevel];

  const contracts = await getOptionsChain(creds, "SPY", today, optionType, spyPrice);
  logger.info("Option chain fetched", {
    date: today,
    type: optionType,
    totalContracts: contracts.length,
    strikes: contracts.slice(0, 5).map((c) => c.strikePrice),
    spy: spyPrice,
  });
  if (contracts.length === 0) {
    logger.warn("No 0DTE contracts found", { date: today, type: optionType });
    return null;
  }

  const tradable = contracts.filter((c) => c.tradable);
  if (tradable.length === 0) {
    logger.warn("No tradable 0DTE options", {
      total: contracts.length,
      statuses: contracts.map((c) => c.status),
    });
    return null;
  }

  // Helper: filter tradable contracts within an OTM range
  const filterZone = (minOtm: number, maxOtm: number) => {
    const zoneContracts = tradable.filter((c) => {
      if (optionType === "call") {
        return (
          c.strikePrice >= spyPrice * (1 + minOtm) &&
          c.strikePrice <= spyPrice * (1 + maxOtm)
        );
      }
      return (
        c.strikePrice <= spyPrice * (1 - minOtm) &&
        c.strikePrice >= spyPrice * (1 - maxOtm)
      );
    });
    logger.info("Strike zone filtered", {
      type: optionType,
      spy: spyPrice,
      minOtm,
      maxOtm,
      rangeMin: spyPrice * (1 - maxOtm),
      rangeMax: spyPrice * (1 + maxOtm),
      tradable: tradable.length,
      inZone: zoneContracts.length,
      zoneStrikes: zoneContracts.map((c) => c.strikePrice),
    });
    return zoneContracts;
  };

  let bestOption: ScoredOption | null;

  if (greeksConfig.searchExtendedFirst) {
    // YOLO: search entire ATM → 3% OTM zone in one pass
    const allCandidates = filterZone(0, EXTENDED_OTM_PERCENT);
    bestOption = await scoreCandidates(creds, allCandidates, optionType, spyPrice, budget, EXTENDED_OTM_PERCENT, greeksConfig);
  } else {
    // Safe/Degen: primary zone first, extended as fallback
    const primaryCandidates = filterZone(0, MAX_OTM_PERCENT);
    bestOption = await scoreCandidates(creds, primaryCandidates, optionType, spyPrice, budget, MAX_OTM_PERCENT, greeksConfig);

    if (!bestOption) {
      const extendedCandidates = filterZone(MAX_OTM_PERCENT, EXTENDED_OTM_PERCENT);
      if (extendedCandidates.length > 0) {
        logger.info("Primary zone unaffordable, searching extended zone", {
          budget,
          spy: spyPrice,
          riskLevel,
          extendedStrikes: extendedCandidates.length,
        });
        bestOption = await scoreCandidates(creds, extendedCandidates, optionType, spyPrice, budget, EXTENDED_OTM_PERCENT, greeksConfig);
      }
    }
  }

  if (bestOption) {
    const otmPct = optionType === "call"
      ? ((bestOption.strikePrice - spyPrice) / spyPrice * 100).toFixed(1)
      : ((spyPrice - bestOption.strikePrice) / spyPrice * 100).toFixed(1);
    const g = bestOption.greeks;
    logger.info("Option selected", {
      symbol: bestOption.symbol,
      strike: bestOption.strikePrice,
      price: bestOption.estimatedPrice,
      spy: spyPrice,
      budget,
      riskLevel,
      otmPercent: otmPct + "%",
      zone: parseFloat(otmPct) <= MAX_OTM_PERCENT * 100 ? "primary" : "extended",
      score: bestOption.score.toFixed(1),
      ...(g ? {
        delta: g.delta.toFixed(4),
        gamma: g.gamma.toFixed(4),
        theta: g.theta.toFixed(4),
        iv: (g.impliedVolatility * 100).toFixed(1) + "%",
      } : {}),
    });
  }

  return bestOption;
}

/**
 * Gets the sentiment signal for a bot based on its mode.
 */
function getSignal(
  mode: "wsb" | "inverse",
  bullishPct: number,
  bearishPct: number,
): "CALLS" | "PUTS" | "HOLD" {
  if (mode === "inverse") {
    return getInverseRecommendation(bullishPct, bearishPct);
  }

  // WSB mode: follow the crowd
  const directional = bullishPct + bearishPct;
  if (directional === 0) return "HOLD";

  const bullRatio = (bullishPct / directional) * 100;
  const bearRatio = (bearishPct / directional) * 100;
  const spread = Math.abs(bullRatio - bearRatio);

  if (spread < 5) return "HOLD";
  return bullRatio > bearRatio ? "CALLS" : "PUTS";
}

/**
 * Places an entry trade for a single bot.
 */
async function executeTrade(cfg: TradeBotConfig): Promise<void> {
  const botLabel = `${cfg.mode}/${cfg.paperTrading ? "paper" : "live"}`;
  const botKey = `${cfg.mode}_${cfg.paperTrading ? "paper" : "live"}`;

  if (tradedToday.get(botKey)) return;
  if (!isBotRunning(cfg.mode, cfg.paperTrading)) return;

  const creds: AlpacaCredentials = {
    apiKeyId: cfg.apiKeyId,
    apiSecretKey: cfg.apiSecretKey,
    paperTrading: cfg.paperTrading,
  };

  // Get time-decayed sentiment: comments closer to market open count more.
  // Look back 48h to capture weekend + overnight + morning threads with decay weighting.
  const lookbackUtc = Math.floor(Date.now() / 1000) - 48 * 3600;
  const counts = getTimeDecayedSentiment(lookbackUtc);
  const totalDirectional = counts.bullish + counts.bearish + counts.neutral;

  if (totalDirectional === 0) {
    logger.info("No sentiment data yet", { bot: botLabel });
    return;
  }

  const bullishPercent =
    Math.round((counts.bullish / totalDirectional) * 10000) / 100;
  const bearishPercent =
    Math.round((counts.bearish / totalDirectional) * 10000) / 100;

  const signal = getSignal(cfg.mode, bullishPercent, bearishPercent);

  logger.info("Time-decayed sentiment evaluated", {
    bot: botLabel,
    bull: bullishPercent,
    bear: bearishPercent,
    rawComments: counts.rawTotal,
    signal,
  });

  if (signal === "HOLD") {
    // Check if we're past the entry cutoff — if so, skip the day entirely
    const now = new Date();
    const est = new Date(
      now.toLocaleString("en-US", { timeZone: "America/New_York" }),
    );
    const currentMinutes = est.getHours() * 60 + est.getMinutes();
    const pastCutoff = currentMinutes >= ENTRY_CUTOFF_MINUTES;

    logger.info(pastCutoff ? "HOLD at cutoff — skipping day" : "HOLD signal — will retry", {
      bot: botLabel,
      bull: bullishPercent,
      bear: bearishPercent,
      cutoffAt: "11:00 AM EST",
      pastCutoff,
    });

    insertTradeLog({
      mode: cfg.mode,
      action: pastCutoff ? "signal_hold_final" : "signal_hold_retry",
      symbol: "SPY",
      side: "buy",
      qty: 0,
      price: null,
      orderId: null,
      status: "cancelled",
      message: pastCutoff
        ? `HOLD final (bull=${bullishPercent}% bear=${bearishPercent}%). Cutoff reached, no trade today.`
        : `HOLD (bull=${bullishPercent}% bear=${bearishPercent}%). Will retry until 11:00 AM.`,
    });

    // Only mark tradedToday if past the cutoff — otherwise leave open for retry
    if (pastCutoff) {
      tradedToday.set(botKey, true);
    }
    return;
  }

  // Get SPY price
  let spyPrice: number;
  try {
    const quote = await fetchSpyRealtime();
    if (!quote) {
      logger.warn("SPY quote unavailable", { bot: botLabel });
      return;
    }
    spyPrice = quote.price;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("SPY price fetch failed", { bot: botLabel, error: msg });
    return;
  }

  // Fetch VIX level for position-size adjustment (if enabled)
  let vixLevel: number | null = null;
  let vixMult = 1.0;
  let exitParams = { stopLossPct: STOP_LOSS_PCT, profitTargetPct: PROFIT_TARGET_PCT };
  if (cfg.vixEnabled) {
    const vixData = await fetchVix();
    if (vixData) {
      vixLevel = vixData.level;
      const vixResult = getVixMultiplier(vixLevel, cfg.riskLevel);
      vixMult = vixResult.multiplier;
      exitParams = getVixAdjustedExitParams(vixLevel);

      logger.info("VIX analysis", {
        bot: botLabel,
        vix: vixLevel,
        regime: vixResult.regime,
        multiplier: vixMult,
        skip: vixResult.skip,
        stopLoss: `${(exitParams.stopLossPct * 100).toFixed(0)}%`,
        profitTarget: `${(exitParams.profitTargetPct * 100).toFixed(0)}%`,
      });

      if (vixResult.skip) {
        insertTradeLog({
          mode: cfg.mode,
          action: "vix_skip",
          symbol: "SPY",
          side: "buy",
          qty: 0,
          price: null,
          orderId: null,
          status: "cancelled",
          message: `VIX ${vixLevel.toFixed(1)} (${vixResult.regime}) — too volatile for ${cfg.riskLevel} risk level, skipping`,
        });
        tradedToday.set(botKey, true);
        return;
      }
    } else {
      logger.warn("VIX data unavailable, proceeding without VIX adjustment", { bot: botLabel });
    }
  }

  // Get account equity for budget calculation
  let equity: number;
  try {
    const account = await getAccount(creds);
    equity = parseFloat(account.equity);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Account fetch failed", { bot: botLabel, error: msg });
    return;
  }

  const budget = equity * RISK_ALLOCATION[cfg.riskLevel] * vixMult;

  // Select optimal option contract given our budget
  const option = await selectOption(creds, signal, spyPrice, budget, cfg.riskLevel);
  if (!option) {
    insertTradeLog({
      mode: cfg.mode,
      action: "no_contract",
      symbol: "SPY",
      side: "buy",
      qty: 0,
      price: null,
      orderId: null,
      status: "error",
      message: `${signal} but no 0DTE option found (SPY $${spyPrice.toFixed(2)}, budget $${budget.toFixed(2)})`,
    });
    // Do NOT mark as traded — allow retry at next scheduled evaluation
    return;
  }

  // Position size: buy as many contracts as the risk-allocated budget allows
  const contractCost = option.estimatedPrice * 100;
  const qty = Math.floor(budget / contractCost);
  if (qty === 0) {
    insertTradeLog({
      mode: cfg.mode,
      action: "insufficient_funds",
      symbol: option.symbol,
      side: "buy",
      qty: 0,
      price: option.estimatedPrice,
      orderId: null,
      status: "error",
      message: `${signal} ${option.type} $${option.strikePrice} — contract cost $${contractCost.toFixed(2)} > budget $${budget.toFixed(2)}`,
    });
    tradedToday.set(botKey, true);
    return;
  }

  // Place order (limit at mid-price for better fill)
  try {
    const order = await placeOptionsOrder(
      creds,
      option.symbol,
      qty,
      "buy",
      option.estimatedPrice,
    );

    const g = option.greeks;
    const greeksStr = g
      ? ` | Δ=${g.delta.toFixed(3)} Γ=${g.gamma.toFixed(4)} Θ=${g.theta.toFixed(3)} IV=${(g.impliedVolatility * 100).toFixed(1)}%`
      : "";

    logger.info("Trade placed", {
      bot: botLabel,
      signal,
      symbol: option.symbol,
      strike: option.strikePrice,
      type: option.type,
      qty,
      price: option.estimatedPrice,
      orderId: order.id,
      ...(g ? {
        delta: g.delta.toFixed(4),
        gamma: g.gamma.toFixed(4),
        theta: g.theta.toFixed(4),
        vega: g.vega.toFixed(4),
        iv: (g.impliedVolatility * 100).toFixed(1) + "%",
      } : {}),
    });

    const entryLogId = insertTradeLog({
      mode: cfg.mode,
      action: `0dte_${signal.toLowerCase()}`,
      symbol: option.symbol,
      side: "buy",
      qty,
      price: option.estimatedPrice,
      orderId: order.id,
      status: order.status === "filled" ? "filled" : "submitted",
      message: `${signal} ${qty}x ${option.type.toUpperCase()} SPY $${option.strikePrice} @ $${option.estimatedPrice.toFixed(2)} [${cfg.riskLevel}]${greeksStr}${vixLevel != null ? ` | VIX ${vixLevel.toFixed(1)} (${vixMult}x)` : ""}`,
    });

    const roundId = insertTradeRound({
      mode: cfg.mode,
      paperTrading: cfg.paperTrading,
      tradeDate: getTodayEST(),
      symbol: option.symbol,
      direction: signal.toLowerCase() as "calls" | "puts",
      qty,
      entryPrice: option.estimatedPrice,
      entryTime: new Date().toISOString(),
      entryLogId,
    });

    // Snapshot equity at entry
    insertEquitySnapshot(cfg.mode, cfg.paperTrading, getTodayEST(), equity, parseFloat((await getAccount(creds)).cash));

    // Track for position monitoring
    activePositions.set(botKey, {
      botKey,
      mode: cfg.mode,
      paperTrading: cfg.paperTrading,
      optionSymbol: option.symbol,
      entryPrice: option.estimatedPrice,
      qty,
      highWaterMark: option.estimatedPrice,
      creds,
      tradeRoundId: roundId,
      stopLossPct: exitParams.stopLossPct,
      profitTargetPct: exitParams.profitTargetPct,
      vixAtEntry: vixLevel,
    });

    tradedToday.set(botKey, true);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Order placement failed", { bot: botLabel, error: msg });
    insertTradeLog({
      mode: cfg.mode,
      action: `0dte_${signal.toLowerCase()}_failed`,
      symbol: option.symbol,
      side: "buy",
      qty,
      price: option.estimatedPrice,
      orderId: null,
      status: "error",
      message: `Order failed: ${msg}`,
    });
  }
}

/**
 * Monitors active positions and applies exit logic:
 * 1. Hard stop loss at -20%
 * 2. Take profit at +10% — but if momentum is strong, switch to trailing stop
 * 3. Trailing stop: once past +10%, trail at 50% of unrealized gain
 * 4. Force close at 3:45 PM (near market close for 0DTE)
 */
async function monitorPositions(): Promise<void> {
  if (activePositions.size === 0) return;

  for (const [botKey, pos] of activePositions.entries()) {
    if (!isBotRunning(pos.mode, pos.paperTrading)) {
      activePositions.delete(botKey);
      continue;
    }

    try {
      const quote = await getOptionQuote(pos.creds, pos.optionSymbol);
      const currentPrice = quote.midPrice > 0 ? quote.midPrice : quote.bidPrice;

      if (currentPrice <= 0) continue;

      const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
      const botLabel = `${pos.mode}/${pos.paperTrading ? "paper" : "live"}`;

      // Update high water mark
      if (currentPrice > pos.highWaterMark) {
        pos.highWaterMark = currentPrice;
      }

      let shouldClose = false;
      let reason = "";

      // 1. Hard stop loss (VIX-adjusted if enabled)
      if (pnlPct <= -pos.stopLossPct) {
        shouldClose = true;
        reason = `Stop loss hit (${(pnlPct * 100).toFixed(1)}%${pos.vixAtEntry ? `, VIX ${pos.vixAtEntry.toFixed(1)}` : ""})`;
      }

      // 2. Near market close: force exit
      if (!shouldClose && isNearClose()) {
        shouldClose = true;
        reason = `Market close exit (P/L: ${(pnlPct * 100).toFixed(1)}%)`;
      }

      // 3. Profit/trailing logic (VIX-adjusted target)
      if (!shouldClose && pnlPct >= pos.profitTargetPct) {
        // Check momentum: is price still climbing or has it dropped from peak?
        const hwmPnl = (pos.highWaterMark - pos.entryPrice) / pos.entryPrice;
        const dropFromPeak =
          (pos.highWaterMark - currentPrice) / pos.highWaterMark;

        // Trailing stop: if we've dropped 50% of our unrealized gains from the peak
        const trailingThreshold = hwmPnl * TRAILING_STOP_RATIO;
        if (pnlPct < trailingThreshold) {
          shouldClose = true;
          reason = `Trailing stop (peak +${(hwmPnl * 100).toFixed(1)}%, now +${(pnlPct * 100).toFixed(1)}%)`;
        }

        // Also close if price dropped >3% from high water mark (momentum fading)
        if (
          !shouldClose &&
          dropFromPeak > 0.03 &&
          pnlPct >= pos.profitTargetPct
        ) {
          shouldClose = true;
          reason = `Momentum fade — locking profit (${(pnlPct * 100).toFixed(1)}%, peak drop ${(dropFromPeak * 100).toFixed(1)}%)`;
        }
      }

      if (shouldClose) {
        logger.info("Closing position", {
          bot: botLabel,
          symbol: pos.optionSymbol,
          entry: pos.entryPrice,
          current: currentPrice,
          pnl: `${(pnlPct * 100).toFixed(1)}%`,
          reason,
        });

        try {
          const order = await closePosition(pos.creds, pos.optionSymbol);
          const dollarPnl = (currentPrice - pos.entryPrice) * pos.qty * 100;

          const exitLogId = insertTradeLog({
            mode: pos.mode,
            action: "close_position",
            symbol: pos.optionSymbol,
            side: "sell",
            qty: pos.qty,
            price: currentPrice,
            orderId: order.id,
            status: "submitted",
            message: `${reason} | Sold ${pos.qty}x @ $${currentPrice.toFixed(2)} (P/L: $${dollarPnl.toFixed(2)})`,
          });

          closeTradeRound(
            pos.tradeRoundId,
            currentPrice,
            new Date().toISOString(),
            exitLogId,
            parseExitReason(reason),
            dollarPnl,
            pnlPct * 100,
          );

          // Snapshot equity after close
          try {
            const acct = await getAccount(pos.creds);
            insertEquitySnapshot(pos.mode, pos.paperTrading, getTodayEST(), parseFloat(acct.equity), parseFloat(acct.cash));
          } catch { /* non-critical */ }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Close position failed", {
            bot: botLabel,
            symbol: pos.optionSymbol,
            error: msg,
          });
          insertTradeLog({
            mode: pos.mode,
            action: "close_failed",
            symbol: pos.optionSymbol,
            side: "sell",
            qty: pos.qty,
            price: currentPrice,
            orderId: null,
            status: "error",
            message: `Close failed (${reason}): ${msg}`,
          });
        }

        activePositions.delete(botKey);
      } else {
        logger.debug("Position check", {
          bot: botLabel,
          symbol: pos.optionSymbol,
          pnl: `${(pnlPct * 100).toFixed(1)}%`,
          hwm: pos.highWaterMark,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Position monitor quote failed", {
        botKey,
        symbol: pos.optionSymbol,
        error: msg,
      });
    }
  }
}

/**
 * Starts the position monitor loop. Called once at app startup.
 */
export function startPositionMonitor(): void {
  if (monitorInterval) return;
  monitorInterval = setInterval(() => {
    monitorPositions();
  }, MONITOR_INTERVAL_MS);
  logger.info("Position monitor started", { intervalMs: MONITOR_INTERVAL_MS });
}

/**
 * Main entry: evaluate sentiment and place trades for all running bots.
 * Called by scheduler at market open (9:30 AM EST).
 */
export async function evaluateAndTrade(): Promise<void> {
  if (!isMarketHours()) {
    logger.debug("Outside market hours, skipping trade evaluation");
    return;
  }

  const configs = getAllTradeBotConfigs();
  for (const cfg of configs) {
    if (cfg.tradeType !== "0dte") continue;

    try {
      await executeTrade(cfg);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Trade execution error", {
        mode: cfg.mode,
        paper: cfg.paperTrading,
        error: msg,
      });
    }
  }
}

/**
 * Force-close all option positions for every running bot.
 * Called near market close as a safety net.
 */
export async function closeBeforeMarketClose(): Promise<void> {
  logger.info("Near market close — closing all 0DTE positions");

  // First, close any tracked active positions
  for (const [botKey, pos] of activePositions.entries()) {
    try {
      const order = await closePosition(pos.creds, pos.optionSymbol);
      const exitLogId = insertTradeLog({
        mode: pos.mode,
        action: "eod_close",
        symbol: pos.optionSymbol,
        side: "sell",
        qty: pos.qty,
        price: null,
        orderId: order.id,
        status: "submitted",
        message: `End-of-day close for ${pos.optionSymbol}`,
      });

      // Close the trade round — estimate P&L from entry price (actual fill price not yet known)
      closeTradeRound(
        pos.tradeRoundId,
        pos.entryPrice, // best estimate; actual fill may differ slightly
        new Date().toISOString(),
        exitLogId,
        "eod_close",
        0, // P&L unknown without fill price
        0,
      );

      // Snapshot equity
      try {
        const acct = await getAccount(pos.creds);
        insertEquitySnapshot(pos.mode, pos.paperTrading, getTodayEST(), parseFloat(acct.equity), parseFloat(acct.cash));
      } catch { /* non-critical */ }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("EOD close failed", {
        botKey,
        symbol: pos.optionSymbol,
        error: msg,
      });
    }
    activePositions.delete(botKey);
  }

  // Also scan Alpaca for any leftover option positions (safety net)
  const configs = getAllTradeBotConfigs();
  for (const cfg of configs) {
    if (!isBotRunning(cfg.mode, cfg.paperTrading)) continue;

    const creds: AlpacaCredentials = {
      apiKeyId: cfg.apiKeyId,
      apiSecretKey: cfg.apiSecretKey,
      paperTrading: cfg.paperTrading,
    };

    try {
      const positions = await getPositions(creds);
      const opts = positions.filter(
        (p) => p.symbol.length > 6 && p.symbol.startsWith("SPY"),
      );

      for (const p of opts) {
        try {
          const order = await closePosition(creds, p.symbol);
          insertTradeLog({
            mode: cfg.mode,
            action: "eod_close",
            symbol: p.symbol,
            side: "sell",
            qty: Math.abs(parseFloat(p.qty)),
            price: parseFloat(p.currentPrice),
            orderId: order.id,
            status: "submitted",
            message: `EOD safety close ${p.qty}x ${p.symbol} (P/L: $${p.unrealizedPl})`,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("EOD safety close failed", {
            symbol: p.symbol,
            error: msg,
          });
        }
      }
    } catch {
      // Ignore — already logged
    }
  }
}

/**
 * Captures daily equity snapshots for all enabled bot configs.
 * Called by scheduler at 4:01 PM EST on weekdays.
 */
export async function captureEquitySnapshots(): Promise<void> {
  const configs = getAllTradeBotConfigs();
  const today = getTodayEST();

  for (const cfg of configs) {
    if (!cfg.enabled) continue;

    const creds: AlpacaCredentials = {
      apiKeyId: cfg.apiKeyId,
      apiSecretKey: cfg.apiSecretKey,
      paperTrading: cfg.paperTrading,
    };

    try {
      const acct = await getAccount(creds);
      insertEquitySnapshot(
        cfg.mode,
        cfg.paperTrading,
        today,
        parseFloat(acct.equity),
        parseFloat(acct.cash),
      );
      logger.info("Equity snapshot captured", {
        mode: cfg.mode,
        paper: cfg.paperTrading,
        equity: acct.equity,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Equity snapshot failed", {
        mode: cfg.mode,
        paper: cfg.paperTrading,
        error: msg,
      });
    }
  }
}
