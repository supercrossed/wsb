import { logger } from "../lib/logger";
import { getAccount, getPositions } from "./alpaca";
import { getTradeBotConfig, setTradeBotEnabled } from "./database";
import type { AlpacaCredentials, TradeBotMode, TradeBotStatus } from "../types";

/**
 * In-memory state tracking whether each bot mode is actively running.
 * The actual trading rules will be implemented later — this is the framework.
 */
const botState: Record<TradeBotMode, { running: boolean }> = {
  wsb: { running: false },
  inverse: { running: false },
};

/**
 * Builds AlpacaCredentials from the stored config for a given mode.
 */
function getCredentials(mode: TradeBotMode): AlpacaCredentials | null {
  const cfg = getTradeBotConfig(mode);
  if (!cfg || !cfg.apiKeyId || !cfg.apiSecretKey) return null;
  return {
    apiKeyId: cfg.apiKeyId,
    apiSecretKey: cfg.apiSecretKey,
    paperTrading: cfg.paperTrading,
  };
}

/**
 * Starts the trade bot for the given mode.
 * For now this just marks it as running — trading rules come later.
 */
export function startBot(mode: TradeBotMode): {
  success: boolean;
  error?: string;
} {
  const creds = getCredentials(mode);
  if (!creds) {
    return {
      success: false,
      error:
        "No API credentials configured for this mode. Set up your Alpaca account first.",
    };
  }

  if (botState[mode].running) {
    return { success: false, error: `${mode} bot is already running.` };
  }

  botState[mode].running = true;
  setTradeBotEnabled(mode, true);
  logger.info("Trade bot started", { mode });

  return { success: true };
}

/**
 * Stops the trade bot for the given mode.
 */
export function stopBot(mode: TradeBotMode): {
  success: boolean;
  error?: string;
} {
  if (!botState[mode].running) {
    return { success: false, error: `${mode} bot is not running.` };
  }

  botState[mode].running = false;
  setTradeBotEnabled(mode, false);
  logger.info("Trade bot stopped", { mode });

  return { success: true };
}

/**
 * Returns whether the bot is currently running for a mode.
 */
export function isBotRunning(mode: TradeBotMode): boolean {
  return botState[mode].running;
}

/**
 * Gets the full status for a trade bot mode, including live Alpaca account data.
 */
export async function getBotStatus(
  mode: TradeBotMode,
): Promise<TradeBotStatus> {
  const cfg = getTradeBotConfig(mode);
  const running = botState[mode].running;

  if (!cfg || !cfg.apiKeyId) {
    return {
      running,
      mode,
      paperTrading: true,
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
    logger.warn("Failed to fetch Alpaca status", { mode, error: message });

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
  for (const mode of ["wsb", "inverse"] as TradeBotMode[]) {
    const cfg = getTradeBotConfig(mode);
    if (cfg?.enabled) {
      botState[mode].running = true;
      logger.info("Restored trade bot state", { mode, running: true });
    }
  }
}
