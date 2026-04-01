// src/executor.ts
// Receives a TradeSignal from the coordinator and places a GTD order on Polymarket.
// Price is locked at edge-detection time — order fills or expires in 5 minutes.

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { createLogger } from "./logger.js";
import type { PendingOrders } from "./pending-orders.js";
import type { PositionTracker } from "./position-tracker.js"; // type-only: only used for parameter typing
import type { TradeSignal } from "./types.js";

const log = createLogger("executor");

// ── Market Info Cache ─────────────────────────────────────────────

interface MarketInfo {
  tickSize: TickSize;
  negRisk: boolean;
}

const marketCache = new Map<string, MarketInfo>();

async function getMarketInfo(
  client: ClobClient,
  tokenId: string,
): Promise<MarketInfo> {
  const cached = marketCache.get(tokenId);
  if (cached) return cached;

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]);

  const info: MarketInfo = { tickSize, negRisk };
  marketCache.set(tokenId, info);
  return info;
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
    const { tickSize, negRisk } = await getMarketInfo(client, signal.tokenId);

    // 2. Place 2 ticks inside the best bid/ask
    const tick = Number(tickSize);
    const isBuy = signal.side === "BUY";

    /** NOTE FROM DOCS
     * const buyPrice = await client.getPrice("TOKEN_ID", "BUY");
      console.log("Best ask:", buyPrice.price); // Price you'd pay to buy

      const sellPrice = await client.getPrice("TOKEN_ID", "SELL");
      console.log("Best bid:", sellPrice.price); // Price you'd receive to sell
     */

    const { price: bookPrice } = await client.getPrice(
      signal.tokenId,
      isBuy ? "BUY" : "SELL",
    );
    const orderPrice = isBuy
      ? Number(bookPrice) - 2 * tick // 2 ticks below best ask (we're market making)
      : Number(bookPrice) - 2 * tick; // 2 ticks below best bid (sell aggressively into bid)
    const size = signal.size;

    const isSell = !isBuy;
    const sdkSide = isSell ? Side.SELL : Side.BUY;

    log.info(
      `EXEC ${tag} order_price=${orderPrice.toFixed(4)} size=${size} edge=${(signal.edge * 100).toFixed(2)}% type=${isSell ? "FOK" : "GTD"}`,
    );

    // 4. Place order via SDK
    //    BUY: GTD limit order (5 min expiry)
    //    SELL: FOK market order (fill immediately or cancel — we want out)
    const resp = isSell
      ? await client.createAndPostMarketOrder(
          {
            tokenID: signal.tokenId,
            price: orderPrice, // worst acceptable price (bestBid)
            amount: size,
            side: sdkSide,
          },
          { tickSize, negRisk },
          OrderType.FOK,
        )
      : await client.createAndPostOrder(
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
      // SDK returns { status: 400, error: "message" } on failure
      const errorMsg: string =
        (resp as { error?: string })?.error ??
        String(resp?.status ?? JSON.stringify(resp));
      const errorStr = resp?.status ?? JSON.stringify(resp);
      const isBalanceError = errorMsg.includes("not enough balance");

      // FOK no-fill (400) on a SELL means no liquidity at exit price — expected when
      // market has resolved or price moved past our limit. Log as warn, not error.
      if (isSell && resp?.status === 400 && !isBalanceError) {
        log.warn(`SELL FOK no fill ${tag}: ${errorMsg}`);
        return false;
      }

      const trackedPosition =
        signal.side === "SELL"
          ? positions?.getPosition(signal.tokenId)
          : undefined;

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
        ...(isBalanceError &&
          signal.side === "SELL" && {
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
