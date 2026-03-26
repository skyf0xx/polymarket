// src/executor.ts
// Receives a TradeSignal from the coordinator and places an order on Polymarket.
// Supports both BUY and SELL. Checks orderbook depth before sizing.

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { PendingOrders } from "./pending-orders.js";
import type { TradeSignal } from "./types.js";

const TICK_MAP: Record<string, number> = {
  "0.1": 0.1,
  "0.01": 0.01,
  "0.001": 0.001,
  "0.0001": 0.0001,
};

const log = createLogger("executor");

// ── Market Info Cache ─────────────────────────────────────────────

interface MarketInfo {
  tickSize: TickSize;
  negRisk: boolean;
}

const marketCache = new Map<string, MarketInfo>();

async function getMarketInfo(slug: string): Promise<MarketInfo> {
  const cached = marketCache.get(slug);
  if (cached) return cached;

  const res = await fetch(`${config.gammaApiUrl}/markets/slug/${slug}`);
  if (!res.ok)
    throw new Error(`Gamma API error for slug ${slug}: ${res.status}`);
  const market = await res.json();

  const tickSize = (market.orderPriceMinTickSize ?? "0.01") as TickSize;
  const negRisk = market.events?.[0]?.negRisk ?? false;

  const info: MarketInfo = { tickSize, negRisk };
  marketCache.set(slug, info);
  return info;
}

// ── Orderbook Depth Check ─────────────────────────────────────────

interface OrderbookResult {
  availableShares: number;
  bestBid: number;
  bestAsk: number;
}

/**
 * Fetch orderbook and return available shares on the relevant side
 * that are fillable at or better than the given limit price,
 * plus the current best bid/ask for maker pricing.
 */
async function getOrderbookInfo(
  tokenId: string,
  side: "BUY" | "SELL",
  limitPrice: number,
): Promise<OrderbookResult> {
  try {
    const res = await fetch(`${config.clobApiUrl}/orderbook/${tokenId}`);
    if (!res.ok) return { availableShares: Infinity, bestBid: 0, bestAsk: 1 };

    const book = await res.json();
    const bids: Array<{ price?: string | number; size?: string | number; [index: number]: string | number }> = book.bids ?? [];
    const asks: Array<{ price?: string | number; size?: string | number; [index: number]: string | number }> = book.asks ?? [];

    const levels = side === "BUY" ? asks : bids;

    let totalShares = 0;
    for (const level of levels) {
      const price = Number(level.price ?? level[0] ?? 0);
      const size = Number(level.size ?? level[1] ?? 0);
      if (side === "BUY" && price <= limitPrice) {
        totalShares += size;
      } else if (side === "SELL" && price >= limitPrice) {
        totalShares += size;
      }
    }

    const bestBid = bids.length > 0 ? Number(bids[0].price ?? bids[0][0] ?? 0) : 0;
    const bestAsk = asks.length > 0 ? Number(asks[0].price ?? asks[0][0] ?? 1) : 1;

    return { availableShares: totalShares, bestBid, bestAsk };
  } catch {
    return { availableShares: Infinity, bestBid: 0, bestAsk: 1 };
  }
}

// ── Main Execute Function ─────────────────────────────────────────

export async function executeSignal(
  client: ClobClient,
  signal: TradeSignal,
  pendingOrders?: PendingOrders,
): Promise<boolean> {
  const tag = `[${signal.side} ${signal.slug} @ ${signal.price.toFixed(4)}]`;

  try {
    // 1. Get market info (tick size + negRisk)
    const { tickSize, negRisk } = await getMarketInfo(signal.slug);

    // 2. Use the price from edge detection — GTD order will expire if it doesn't fill
    let orderPrice = signal.price;

    // 3. Check orderbook liquidity and cap size
    const obInfo = await getOrderbookInfo(
      signal.tokenId,
      signal.side,
      orderPrice,
    );
    const size = Math.min(signal.size, obInfo.availableShares);

    if (size * orderPrice < 5) {
      log.warn(
        `SKIP ${tag} — insufficient liquidity (${obInfo.availableShares === Infinity ? "unknown" : obInfo.availableShares.toFixed(0)} shares available)`,
      );
      return false;
    }

    // 4. In maker mode, place limit order at bestBid + 1 tick (top of bid book).
    //    This makes us a maker — we rest on the book and pay zero fees.
    //    Cap at bestAsk - 1 tick to ensure the order doesn't cross the spread.
    if (config.marketMaker && signal.side === "BUY") {
      const tick = TICK_MAP[tickSize] ?? 0.01;
      const makerPrice = Math.min(
        obInfo.bestBid + tick,  // one tick above best bid
        obInfo.bestAsk - tick,  // never cross the spread
      );
      if (makerPrice > 0 && makerPrice < 1) {
        orderPrice = makerPrice;
      }
      log.info(
        `MAKER ${tag} bid=${obInfo.bestBid} ask=${obInfo.bestAsk} → order_price=${orderPrice.toFixed(4)}`,
      );
    }

    log.info(
      `EXEC ${tag} order_price=${orderPrice.toFixed(4)} size=${size} edge=${(signal.edge * 100).toFixed(2)}% mode=${config.marketMaker ? "maker" : "taker"}`,
    );

    // 5. Place order via SDK
    const sdkSide = signal.side === "BUY" ? Side.BUY : Side.SELL;
    const resp = await client.createAndPostOrder(
      {
        tokenID: signal.tokenId,
        price: orderPrice,
        size,
        side: sdkSide,
        expiration: Math.floor(Date.now() / 1_000) + 300,
      },
      { tickSize, negRisk },
      OrderType.GTD,
    );

    if (resp?.success) {
      log.record(`✓ Order placed`, {
        tokenId: signal.tokenId,
        slug: signal.slug,
        side: signal.side,
        price: orderPrice,
        size,
        edge: signal.edge,
        reason: signal.reason,
        orderId: resp.orderID,
        success: true,
      });

      // Track pending notional so position cap accounts for resting orders
      if (pendingOrders && resp.orderID && signal.side === "BUY") {
        pendingOrders.add(resp.orderID, signal.tokenId, orderPrice, size);
      }

      return true;
    } else {
      log.error(`✗ Order failed`, {
        tokenId: signal.tokenId,
        slug: signal.slug,
        side: signal.side,
        price: orderPrice,
        size,
        edge: signal.edge,
        reason: signal.reason,
        success: false,
        error: resp?.status ?? JSON.stringify(resp),
      });
      return false;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`✗ Error executing ${tag}: ${message}`);
    return false;
  }
}
