import { logger } from "../lib/logger";
import { getAccount, getPositions } from "./alpaca";
import {
  getTradeBotConfig,
  getAllTradeBotConfigs,
  setTradeBotEnabled,
} from "./database";
import type {
  AlpacaCredentials,
  BotKey,
  TradeBotMode,
  TradeBotStatus,
} from "../types";
import { makeBotKey } from "../types";

/**
 * In-memory state tracking whether each bot instance is actively running.
 * Keyed by BotKey (e.g. "inverse_paper", "wsb_live").
 */
const botState: Map<BotKey, { running: boolean }> = new Map();

function getState(key: BotKey): { running: boolean } {
  let state = botState.get(key);
  if (!state) {
    state = { running: false };
    botState.set(key, state);
  }
  return state;
}

/**
 * Builds AlpacaCredentials from the stored config for a given mode + paper/live.
 */
function getCredentials(
  mode: TradeBotMode,
  paperTrading: boolean,
): AlpacaCredentials | null {
  const cfg = getTradeBotConfig(mode, paperTrading);
  if (!cfg || !cfg.apiKeyId || !cfg.apiSecretKey) return null;
  return {
    apiKeyId: cfg.apiKeyId,
    apiSecretKey: cfg.apiSecretKey,
    paperTrading: cfg.paperTrading,
  };
}

/**
 * Starts the trade bot for the given mode + paper/live.
 */
export function startBot(
  mode: TradeBotMode,
  paperTrading: boolean,
): {
  success: boolean;
  error?: string;
} {
  const creds = getCredentials(mode, paperTrading);
  if (!creds) {
    return {
      success: false,
      error:
        "No API credentials configured for this mode. Set up your Alpaca account first.",
    };
  }

  const key = makeBotKey(mode, paperTrading);
  const state = getState(key);

  if (state.running) {
    return {
      success: false,
      error: `${mode} ${paperTrading ? "paper" : "live"} bot is already running.`,
    };
  }

  state.running = true;
  setTradeBotEnabled(mode, paperTrading, true);
  logger.info("Trade bot started", { mode, paperTrading });

  return { success: true };
}

/**
 * Stops the trade bot for the given mode + paper/live.
 */
export function stopBot(
  mode: TradeBotMode,
  paperTrading: boolean,
): {
  success: boolean;
  error?: string;
} {
  const key = makeBotKey(mode, paperTrading);
  const state = getState(key);

  if (!state.running) {
    return {
      success: false,
      error: `${mode} ${paperTrading ? "paper" : "live"} bot is not running.`,
    };
  }

  state.running = false;
  setTradeBotEnabled(mode, paperTrading, false);
  logger.info("Trade bot stopped", { mode, paperTrading });

  return { success: true };
}

/**
 * Returns whether the bot is currently running for a mode + paper/live.
 */
export function isBotRunning(
  mode: TradeBotMode,
  paperTrading: boolean,
): boolean {
  const key = makeBotKey(mode, paperTrading);
  return getState(key).running;
}

/**
 * Gets the full status for a trade bot instance, including live Alpaca account data.
 */
export async function getBotStatus(
  mode: TradeBotMode,
  paperTrading: boolean,
): Promise<TradeBotStatus> {
  const cfg = getTradeBotConfig(mode, paperTrading);
  const key = makeBotKey(mode, paperTrading);
  const running = getState(key).running;

  if (!cfg || !cfg.apiKeyId) {
    return {
      running,
      mode,
      paperTrading,
      accountEquity: null,
      accountCash: null,
      lastTradeAt: null,
      positions: [],
    };
  }

  const creds: AlpacaCredentials = {
    apiKeyId: cfg.apiKeyId,
    apiSecretKey: cfg.apiSecretKey,
    paperTrading: cfg.paperTrading,
  };

  try {
    const [account, positions] = await Promise.all([
      getAccount(creds),
      getPositions(creds),
    ]);

    return {
      running,
      mode,
      paperTrading: cfg.paperTrading,
      accountEquity: parseFloat(account.equity),
      accountCash: parseFloat(account.cash),
      lastTradeAt: null,
      positions,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to fetch Alpaca status", {
      mode,
      paperTrading,
      error: message,
    });

    return {
      running,
      mode,
      paperTrading: cfg.paperTrading,
      accountEquity: null,
      accountCash: null,
      lastTradeAt: null,
      positions: [],
    };
  }
}

/**
 * Gets status for ALL configured bots at once.
 */
export async function getAllBotStatuses(): Promise<TradeBotStatus[]> {
  const configs = getAllTradeBotConfigs();
  if (configs.length === 0) return [];

  const statuses = await Promise.all(
    configs.map((cfg) => getBotStatus(cfg.mode, cfg.paperTrading)),
  );
  return statuses;
}

/**
 * Validates Alpaca credentials by making a test API call.
 */
export async function validateCredentials(
  apiKeyId: string,
  apiSecretKey: string,
  paperTrading: boolean,
): Promise<{
  valid: boolean;
  account?: { id: string; equity: string; cash: string; status: string };
  error?: string;
}> {
  try {
    const account = await getAccount({ apiKeyId, apiSecretKey, paperTrading });
    return {
      valid: true,
      account: {
        id: account.id,
        equity: account.equity,
        cash: account.cash,
        status: account.status,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}

/**
 * Restores bot state on startup — if a bot was enabled when the server last stopped,
 * mark it as running again.
 */
export function restoreBotState(): void {
  const configs = getAllTradeBotConfigs();
  for (const cfg of configs) {
    if (cfg.enabled) {
      const key = makeBotKey(cfg.mode, cfg.paperTrading);
      getState(key).running = true;
      logger.info("Restored trade bot state", {
        mode: cfg.mode,
        paperTrading: cfg.paperTrading,
        running: true,
      });
    }
  }
}
