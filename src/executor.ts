// src/executor.ts
// Places orders on Polymarket CLOB.
// BUY: GTD limit order (5-min expiry) at sharp signal price
// SELL: FAK market order (fill or cancel)

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { createLogger } from "./logger.js";
import type { OrderTracker } from "./order-tracker.js";
import type { TradeSignal } from "./types.js";

const log = createLogger("executor");

// -- Market Info Cache --------------------------------------------------------

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

// -- Execute ------------------------------------------------------------------

export async function executeSignal(
  client: ClobClient,
  signal: TradeSignal,
  orders?: OrderTracker,
): Promise<boolean> {
  const tag = `[${signal.side} ${signal.slug} @ ${signal.price.toFixed(4)}]`;

  try {
    const isBuy = signal.side === "BUY";

    // BUY: post just below ask (maker), capped at sharp signal price
    // SELL: FAK into the live bid
    const priceSide = isBuy ? "BUY" : "SELL";
    const [{ tickSize, negRisk }, { price: bookPrice }] = await Promise.all([
      getMarketInfo(client, signal.tokenId),
      client.getPrice(signal.tokenId, priceSide),
    ]);

    let orderPrice: number;
    if (isBuy) {
      const bestAsk = Number(bookPrice);
      const tick = Number(tickSize);
      orderPrice = Math.min(signal.price, bestAsk - tick);
    } else {
      orderPrice = Number(bookPrice);
    }

    const size = signal.size;
    const sdkSide = isBuy ? Side.BUY : Side.SELL;

    log.info(
      `EXEC ${tag} order_price=${orderPrice.toFixed(4)} size=${size} edge=${(signal.edge * 100).toFixed(2)}% type=${isBuy ? "GTD" : "FAK"}`,
    );

    const resp = isBuy
      ? await client.createAndPostOrder(
          {
            tokenID: signal.tokenId,
            price: orderPrice,
            size,
            side: sdkSide,
            expiration: Math.floor(Date.now() / 1_000) + 300,
          },
          { tickSize, negRisk },
          OrderType.GTD,
        )
      : await client.createAndPostMarketOrder(
          {
            tokenID: signal.tokenId,
            price: orderPrice,
            amount: size,
            side: sdkSide,
          },
          { tickSize, negRisk },
          OrderType.FAK,
        );

    if (resp?.success) {
      log.record(`Order placed`, {
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

      if (orders && resp.orderID && isBuy) {
        orders.trackOrder(resp.orderID, signal.tokenId, orderPrice, size);
      }

      return true;
    } else {
      const errorMsg: string =
        (resp as { error?: string })?.error ??
        String(resp?.status ?? JSON.stringify(resp));
      const isBalanceError = errorMsg.includes("not enough balance");

      // FAK no-fill on SELL is expected when market has resolved
      if (!isBuy && resp?.status === 400 && !isBalanceError) {
        log.warn(`SELL FAK no fill ${tag}: ${errorMsg}`);
        return false;
      }

      log.recordError(`Order failed`, {
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
    log.error(`Error executing ${tag}: ${message}`);
    return false;
  }
}
