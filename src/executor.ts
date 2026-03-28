// src/executor.ts
// Receives a TradeSignal from the coordinator and places a GTD order on Polymarket.
// Price is locked at edge-detection time — order fills or expires in 5 minutes.

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { PendingOrders } from "./pending-orders.js";
import type { PositionTracker } from "./position-tracker.js"; // type-only: only used for parameter typing
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

  const tickSize = String(market.orderPriceMinTickSize) as TickSize;
  const negRisk = market.events?.[0]?.negRisk ?? false;

  const info: MarketInfo = { tickSize, negRisk };
  marketCache.set(slug, info);
  return info;
}

// ── Orderbook Best Bid/Ask (maker mode only) ────────────────────

interface TopOfBook {
  bestBid: number;
  bestAsk: number;
}

async function getTopOfBook(tokenId: string): Promise<TopOfBook> {
  try {
    const res = await fetch(`${config.clobApiUrl}/book?token_id=${tokenId}`);
    if (!res.ok) return { bestBid: 0, bestAsk: 1 };

    const book = await res.json();
    const bids: Array<{ price?: string | number; [index: number]: string | number }> = book.bids ?? [];
    const asks: Array<{ price?: string | number; [index: number]: string | number }> = book.asks ?? [];

    // Bids/asks are NOT guaranteed sorted — find best manually
    let bestBid = 0;
    for (const b of bids) {
      const p = Number(b.price ?? b[0] ?? 0);
      if (p > bestBid) bestBid = p;
    }
    let bestAsk = asks.length > 0 ? Infinity : 1;
    for (const a of asks) {
      const p = Number(a.price ?? a[0] ?? Infinity);
      if (p < bestAsk) bestAsk = p;
    }
    if (bestAsk === Infinity) bestAsk = 1;

    return { bestBid, bestAsk };
  } catch {
    return { bestBid: 0, bestAsk: 1 };
  }
}

// ── Main Execute Function ─────────────────────────────────────────

export async function executeSignal(
  client: ClobClient,
  signal: TradeSignal,
  pendingOrders?: PendingOrders,
  positions?: PositionTracker,
): Promise<boolean> {
  const tag = `[${signal.side} ${signal.slug} @ ${signal.price.toFixed(4)}]`;

  try {
    // 1. Get market info (tick size + negRisk)
    const { tickSize, negRisk } = await getMarketInfo(signal.slug);

    // 2. Use the price from edge detection — GTD order will expire if it doesn't fill
    let orderPrice = signal.price;
    const size = signal.size;

    // 2b. Truncate to tick grid and clamp to valid CLOB range [tick, 1 - tick]
    //     BUY: floor (pay less), SELL: ceil (receive more) — always in our favor
    const tick = TICK_MAP[tickSize] ?? 0.01;
    const inv = Math.round(1 / tick); // e.g. 100 for tick 0.01
    orderPrice = signal.side === "BUY"
      ? Math.floor(orderPrice * inv) / inv
      : Math.ceil(orderPrice * inv) / inv;
    const minPrice = tick;
    const maxPrice = Math.round((1 - tick) * inv) / inv;
    orderPrice = Math.max(minPrice, Math.min(maxPrice, orderPrice));

    // 3. In maker mode, place limit order at bestBid + 1 tick (top of bid book).
    //    This makes us a maker — we rest on the book and pay zero fees.
    //    Cap at bestAsk - 1 tick to ensure the order doesn't cross the spread.
    if (config.marketMaker && signal.side === "BUY") {
      const obInfo = await getTopOfBook(signal.tokenId);
      const makerPrice = Math.min(
        obInfo.bestBid + tick,  // one tick above best bid
        obInfo.bestAsk - tick,  // never cross the spread
      );
      if (makerPrice > 0 && makerPrice < 1) {
        orderPrice = Math.min(signal.price, makerPrice);
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
      const errorStr = resp?.status ?? JSON.stringify(resp);
      const isBalanceError = typeof errorStr === "string" && errorStr.includes("not enough balance");
      const trackedPosition = signal.side === "SELL" ? positions?.getPosition(signal.tokenId) : undefined;

      log.recordError(`✗ Order failed`, {
        tokenId: signal.tokenId,
        slug: signal.slug,
        side: signal.side,
        price: orderPrice,
        size,
        edge: signal.edge,
        reason: signal.reason,
        success: false,
        error: errorStr,
        ...(isBalanceError && signal.side === "SELL" && {
          debug_balance_error: {
            tracker_size: trackedPosition?.size ?? null,
            tracker_avg_price: trackedPosition?.avgPrice ?? null,
            tracker_total_cost: trackedPosition?.totalCost ?? null,
            order_size: size,
            order_price: orderPrice,
            // raw CLOB amounts: makerAmount = shares * 1e6, takerAmount = USDC * 1e6
            expected_maker_amount: Math.round(size * 1e6),
            expected_taker_amount: Math.round(size * orderPrice * 1e6),
          },
        }),
      });

      // Stale position → re-hydrate so we stop retrying with wrong size
      if (isBalanceError && positions) {
        log.warn(`Balance mismatch — re-hydrating positions`);
        positions.hydrate().catch(() => {});
      }

      return false;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`✗ Error executing ${tag}: ${message}`);
    return false;
  }
}
