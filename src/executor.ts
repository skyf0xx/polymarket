// src/executor.ts
// Receives a TradeSignal from the coordinator and places an order on Polymarket.
// Supports both BUY and SELL. Checks orderbook depth before sizing.

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { TickSize } from "@polymarket/clob-client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { TradeSignal } from "./types.js";

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

/**
 * Fetch orderbook and return available shares on the relevant side
 * that are fillable at or better than the given limit price.
 * For BUY: sum ask-side shares where ask price <= limitPrice.
 * For SELL: sum bid-side shares where bid price >= limitPrice.
 */
async function getAvailableShares(
  tokenId: string,
  side: "BUY" | "SELL",
  limitPrice: number,
): Promise<number> {
  try {
    const res = await fetch(`${config.clobApiUrl}/orderbook/${tokenId}`);
    if (!res.ok) return Infinity; // fail open — don't block trade

    const book = await res.json();
    const levels: Array<{
      price?: string | number;
      size?: string | number;
      [index: number]: string | number;
    }> = side === "BUY" ? (book.asks ?? []) : (book.bids ?? []);

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
    return totalShares;
  } catch {
    return Infinity; // fail open
  }
}

// ── Main Execute Function ─────────────────────────────────────────

export async function executeSignal(
  client: ClobClient,
  signal: TradeSignal,
): Promise<boolean> {
  const tag = `[${signal.side} ${signal.slug} @ ${signal.price.toFixed(4)}]`;

  try {
    // 1. Get market info (tick size + negRisk)
    const { tickSize, negRisk } = await getMarketInfo(signal.slug);

    // 2. Fetch current price + slippage guard (skipped for exits — must close)
    const orderPrice = signal.price;
    const priceRes = await fetch(
      `${config.clobApiUrl}/last-trade-price?token_id=${signal.tokenId}`,
    );
    if (priceRes.ok) {
      const priceData = await priceRes.json();
      const currentPrice = Number(priceData?.price ?? signal.price);

      if (signal.reason !== "exit_signal") {
        const slippagePct =
          (Math.abs(currentPrice - signal.price) / signal.price) * 100;
        if (slippagePct > config.maxSlippagePct) {
          log.warn(
            `SKIP ${tag} — price drifted ${slippagePct.toFixed(2)}% > ${config.maxSlippagePct}%`,
          );
          return false;
        }
      }
    } else {
      log.warn(
        `${tag} — slippage check skipped: price endpoint returned ${priceRes.status}`,
      );
    }

    // 3. Check orderbook liquidity and cap size
    const availableShares = await getAvailableShares(
      signal.tokenId,
      signal.side,
      orderPrice,
    );
    const size = Math.min(signal.size, availableShares);

    if (size * orderPrice < 5) {
      log.warn(
        `SKIP ${tag} — insufficient liquidity (${availableShares === Infinity ? "unknown" : availableShares.toFixed(0)} shares available)`,
      );
      return false;
    }

    log.info(
      `EXEC ${tag} order_price=${orderPrice.toFixed(4)} size=${size} edge=${(signal.edge * 100).toFixed(2)}%`,
    );

    // 4. Place order via SDK
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
