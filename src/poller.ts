// src/poller.ts
// Polls the Polymarket Data API for a target user's trades and returns unseen ones.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { Side } from "@polymarket/clob-client";
import { ethers } from "ethers";

const POLYGON_RPC = "https://rpc.ankr.com/polygon/1b84a04c3e06bd15a1e3bad027f2c91a37928395fcccc1c57bb64aead5ec3114";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];
const DATA_API = "https://data-api.polymarket.com";
const STATE_FILE = "./seen_trades.json";

export interface TargetTrade {
  transactionHash: string;
  conditionId: string;
  asset: string; // tokenId
  side: Side.BUY | Side.SELL;
  price: number;
  size: number;
  usdcSize: number;
  outcomeIndex: number;
  outcome: string;
  title: string;
  slug: string;
  timestamp: number;
}

function loadSeen(): Set<string> {
  if (!existsSync(STATE_FILE)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  // Keep last 500 to avoid unbounded growth
  const arr = [...seen].slice(-500);
  writeFileSync(STATE_FILE, JSON.stringify(arr));
}

export async function pollNewTrades(
  targetWallet: string,
): Promise<TargetTrade[]> {
  const seen = loadSeen();

  const url = `${DATA_API}/activity?user=${targetWallet}&type=TRADE&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(
      `[poller] Activity API error: ${res.status} ${res.statusText}`,
    );
    return [];
  }

  const trades: any[] = await res.json();
  const newTrades: TargetTrade[] = [];

  for (const t of trades) {
    if (seen.has(t.transactionHash)) continue;
    seen.add(t.transactionHash);
    newTrades.push({
      transactionHash: t.transactionHash,
      conditionId: t.conditionId,
      asset: t.asset,
      side: t.side,
      price: t.price,
      size: t.size,
      usdcSize: t.usdcSize,
      outcomeIndex: t.outcomeIndex,
      outcome: t.outcome,
      title: t.title,
      slug: t.slug,
      timestamp: t.timestamp,
    });
  }

  saveSeen(seen);

  // Return oldest-first so we execute in chronological order
  return newTrades.reverse();
}

export async function getUsdcBalance(wallet: string): Promise<number | null> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC, 137);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const raw: ethers.BigNumber = await usdc.balanceOf(wallet);
    console.log("xxxxx", raw);
    return parseFloat(ethers.utils.formatUnits(raw, 6));
  } catch (e) {
    console.log("xxx", e);
    return null;
  }
}
