import { logger } from "../lib/logger";
import type { AlpacaCredentials, AlpacaPosition } from "../types";

const PAPER_BASE_URL = "https://paper-api.alpaca.markets";
const LIVE_BASE_URL = "https://api.alpaca.markets";

function getBaseUrl(paperTrading: boolean): string {
  return paperTrading ? PAPER_BASE_URL : LIVE_BASE_URL;
}

function getHeaders(creds: AlpacaCredentials): Record<string, string> {
  return {
    "APCA-API-KEY-ID": creds.apiKeyId,
    "APCA-API-SECRET-KEY": creds.apiSecretKey,
    "Content-Type": "application/json",
  };
}

export interface AlpacaAccount {
  id: string;
  status: string;
  currency: string;
  buyingPower: string;
  cash: string;
  equity: string;
  portfolioValue: string;
  patternDayTrader: boolean;
  tradingBlocked: boolean;
  accountBlocked: boolean;
}

/**
 * Fetches account info from Alpaca. Used to verify credentials and get account status.
 */
export async function getAccount(
  creds: AlpacaCredentials,
): Promise<AlpacaAccount> {
  const url = `${getBaseUrl(creds.paperTrading)}/v2/account`;
  const res = await fetch(url, { headers: getHeaders(creds) });

  if (!res.ok) {
    const body = await res.text();
    logger.error("Alpaca getAccount failed", { status: res.status, body });
    throw new Error(`Alpaca API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    id: data.id as string,
    status: data.status as string,
    currency: data.currency as string,
    buyingPower: data.buying_power as string,
    cash: data.cash as string,
    equity: data.equity as string,
    portfolioValue: data.portfolio_value as string,
    patternDayTrader: data.pattern_day_trader as boolean,
    tradingBlocked: data.trading_blocked as boolean,
    accountBlocked: data.account_blocked as boolean,
  };
}

/**
 * Fetches all open positions from Alpaca.
 */
export async function getPositions(
  creds: AlpacaCredentials,
): Promise<AlpacaPosition[]> {
  const url = `${getBaseUrl(creds.paperTrading)}/v2/positions`;
  const res = await fetch(url, { headers: getHeaders(creds) });

  if (!res.ok) {
    const body = await res.text();
    logger.error("Alpaca getPositions failed", { status: res.status, body });
    throw new Error(`Alpaca API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>[];
  return data.map((pos) => ({
    symbol: pos.symbol as string,
    qty: pos.qty as string,
    side: pos.side as string,
    marketValue: pos.market_value as string,
    unrealizedPl: pos.unrealized_pl as string,
    unrealizedPlpc: pos.unrealized_plpc as string,
    currentPrice: pos.current_price as string,
    avgEntryPrice: pos.avg_entry_price as string,
  }));
}

export interface AlpacaOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  timeInForce: string;
  status: string;
  filledAvgPrice: string | null;
}

/**
 * Places a market order on Alpaca.
 */
export async function placeOrder(
  creds: AlpacaCredentials,
  symbol: string,
  qty: number,
  side: "buy" | "sell",
): Promise<AlpacaOrder> {
  const url = `${getBaseUrl(creds.paperTrading)}/v2/orders`;
  const res = await fetch(url, {
    method: "POST",
    headers: getHeaders(creds),
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error("Alpaca placeOrder failed", {
      status: res.status,
      body,
      symbol,
      qty,
      side,
    });
    throw new Error(`Alpaca order error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    id: data.id as string,
    clientOrderId: data.client_order_id as string,
    symbol: data.symbol as string,
    qty: data.qty as string,
    side: data.side as string,
    type: data.type as string,
    timeInForce: data.time_in_force as string,
    status: data.status as string,
    filledAvgPrice: (data.filled_avg_price as string) ?? null,
  };
}

/**
 * Fetches recent orders from Alpaca.
 */
export async function getOrders(
  creds: AlpacaCredentials,
  status: "open" | "closed" | "all" = "all",
  limit: number = 20,
): Promise<AlpacaOrder[]> {
  const url = `${getBaseUrl(creds.paperTrading)}/v2/orders?status=${status}&limit=${limit}&direction=desc`;
  const res = await fetch(url, { headers: getHeaders(creds) });

  if (!res.ok) {
    const body = await res.text();
    logger.error("Alpaca getOrders failed", { status: res.status, body });
    throw new Error(`Alpaca API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>[];
  return data.map((order) => ({
    id: order.id as string,
    clientOrderId: order.client_order_id as string,
    symbol: order.symbol as string,
    qty: order.qty as string,
    side: order.side as string,
    type: order.type as string,
    timeInForce: order.time_in_force as string,
    status: order.status as string,
    filledAvgPrice: (order.filled_avg_price as string) ?? null,
  }));
}
