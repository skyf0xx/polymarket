// src/executor.ts
// Receives a trade signal from the poller and places a matching order on Polymarket.

import { ClobClient } from "@polymarket/clob-client";
import type { TargetTrade } from "./poller.js";
import type { TickSize } from "@polymarket/clob-client";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

interface MarketInfo {
  tickSize: TickSize;
  negRisk: boolean;
}

// Cache market info to avoid redundant lookups
const marketCache = new Map<string, MarketInfo>();

async function getMarketInfo(slug: string): Promise<MarketInfo> {
  const cached = marketCache.get(slug);
  if (cached) return cached;

  const res = await fetch(`${GAMMA_API}/markets/slug/${slug}`);
  if (!res.ok)
    throw new Error(`Gamma API error for slug ${slug}: ${res.status}`);
  const market = await res.json();

  // Convert to number instead of string
  const tickSize = market.orderPriceMinTickSize ?? 0.01;
  const negRisk = market.events?.[0]?.negRisk ?? false;

  const info: MarketInfo = { tickSize, negRisk };
  marketCache.set(slug, info);
  return info;
}

export interface SizingConfig {
  mode: "fixed" | "multiplier" | "percent";
  value: number; // used by fixed + multiplier
  targetValue: number | null; // target's portfolio $, for percent mode
  myBankroll: number | null; // our portfolio $, for percent mode
}

function computeSize(trade: TargetTrade, sizing: SizingConfig): number {
  if (sizing.mode === "multiplier") {
    return Math.max(
      5,
      Math.round((trade.usdcSize * sizing.value) / trade.price),
    );
  }
  if (sizing.mode === "percent") {
    if (!sizing.targetValue || !sizing.myBankroll || sizing.targetValue <= 0) {
      console.warn(
        `  WARN percent mode but missing portfolio values (target=${sizing.targetValue}, mine=${sizing.myBankroll}). Falling back to $10 fixed.`,
      );
      return Math.max(5, Math.round(10 / trade.price));
    }
    // What % of his portfolio did he spend?
    const pct = trade.usdcSize / sizing.targetValue;
    // Spend the same % of our bankroll
    const myUsdc = pct * sizing.myBankroll;
    return Math.max(5, Math.round(myUsdc / trade.price));
  }
  // fixed: buy $value worth of shares at the target's price
  return Math.max(5, Math.round(sizing.value / trade.price));
}

export async function executeTrade(
  client: ClobClient,
  trade: TargetTrade,
  sizing: SizingConfig,
  maxSlippage: number,
  aggressivePct = 0.20,
): Promise<void> {
  if (trade.side === "SELL") return;

  const tag = `[${trade.side} ${trade.outcome} @ ${trade.price}] "${trade.title}"`;

  try {
    // 1. Get market info (tick size + negRisk)
    const { tickSize, negRisk } = await getMarketInfo(trade.slug);

    // 2. Fetch current price; derive an aggressive bid above it
    let bidPrice = trade.price;
    const priceRes = await fetch(
      `${CLOB_API}/last-trade-price?token_id=${trade.asset}`,
    );
    if (priceRes.ok) {
      const priceData = await priceRes.json();
      const currentPrice = Number(priceData?.price ?? trade.price);

      // Guard: skip if the market has already moved too far from the signal price
      const slippagePercent =
        (Math.abs(currentPrice - trade.price) / trade.price) * 100;
      if (slippagePercent > maxSlippage) {
        console.log(
          `  SKIP ${tag} — price drifted ${slippagePercent.toFixed(2)}% > ${maxSlippage}%`,
        );
        return;
      }

      // Bid aggressivePct above the current market price so it crosses the spread
      const raw = currentPrice * (1 + aggressivePct);
      const tick = Number(tickSize);
      bidPrice = Math.min(0.99, Math.round(raw / tick) * tick);
      // Re-round to avoid floating-point noise (e.g. 0.120000000001)
      bidPrice = Math.round(bidPrice / tick) * tick;
    }

    // 3. Compute size
    const size = computeSize(trade, sizing);
    console.log(
      `  EXEC ${tag} aggressive_bid=${bidPrice.toFixed(4)} size=${size} shares`,
    );

    // 4. Place order via the SDK
    const resp = await client.createAndPostOrder(
      {
        tokenID: trade.asset,
        price: bidPrice,
        size,
        side: trade.side,
      },
      { tickSize, negRisk },
    );

    if (resp?.success) {
      console.log(`  ✓ Order placed: ${resp.orderID} status=${resp.status}`);
    } else {
      console.error(`  ✗ Order failed:`, resp?.errorMsg || resp);
    }
  } catch (err: any) {
    console.error(`  ✗ Error executing ${tag}:`, err.message ?? err);
  }
}
