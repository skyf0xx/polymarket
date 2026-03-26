// src/snapshot.ts
// One-shot diagnostic script — connects to every data source, collects a small
// sample, saves each to datasamples/<name>.json, then exits.
// Run:  npx tsx src/snapshot.ts

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { config } from "./config.js";

const TIMEOUT_MS = 15_000;
const SAMPLES_DIR = join(process.cwd(), "datasamples");

mkdirSync(SAMPLES_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────

function save(filename: string, data: unknown) {
  const path = join(SAMPLES_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`  → saved ${filename}`);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
      ),
    ]);
    console.log(`  ✓ ${label} (${Date.now() - start}ms)`);
    return result;
  } catch (err: any) {
    console.log(`  ✗ ${label} — ${err.message} (${Date.now() - start}ms)`);
    return null;
  }
}

function collectWsMessage(
  url: string,
  opts: {
    onOpen?: (ws: WebSocket) => void;
    queryParams?: Record<string, string>;
  } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fullUrl = opts.queryParams
      ? `${url}?${new URLSearchParams(opts.queryParams)}`
      : url;

    const ws = new WebSocket(fullUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout — no message received"));
    }, TIMEOUT_MS);

    ws.on("open", () => {
      if (opts.onOpen) opts.onOpen(ws);
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text === "PONG") return;
      clearTimeout(timer);
      ws.close();
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Snapshots ───────────────────────────────────────────────────

async function snapshotOddsApiEvents() {
  console.log("\n1. Odds API — GET /v3/events");
  const sport = config.oddsApiSports[0] ?? "upcoming";
  const url = `${config.oddsApiRestUrl}/v3/events?apiKey=${config.oddsApiKey}&sport=${sport}&status=pending`;
  const data = await timed(`/v3/events?sport=${sport}`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
  if (data) save("odds-api-events.json", data);
  return data;
}

async function snapshotOddsApiOdds(events: any[] | null) {
  console.log("\n2. Odds API — GET /v3/odds/multi");
  if (!events || events.length === 0) {
    console.log("  ⚠ No events — skipping.");
    return;
  }
  const ids = events.slice(0, 3).map((e: any) => e.id).join(",");
  const bookie = config.bookmakerId || "pinnacle";
  const url = `${config.oddsApiRestUrl}/v3/odds/multi?apiKey=${config.oddsApiKey}&eventIds=${ids}&bookmakers=${bookie}`;
  const data = await timed(`/v3/odds/multi`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
  if (data) save("odds-api-odds.json", data);
}

async function snapshotGammaMarkets() {
  console.log("\n3. Polymarket Gamma — GET /markets");
  const params = new URLSearchParams({
    closed: "false",
    liquidity_num_min: String(config.polymarketMinLiquidity),
    limit: "3",
  });
  for (const t of config.polymarketSportsTypes) params.append("sports_market_types", t);
  for (const id of config.polymarketTagIds) params.append("tag_id", id);
  const url = `${config.gammaApiUrl}/markets?${params}`;
  const data = await timed("Gamma /markets", async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
  if (data) save("gamma-markets.json", data);
  return data;
}

async function snapshotGammaTeams() {
  console.log("\n4. Polymarket Gamma — GET /teams");
  const league = config.gammaLeagues[0] ?? "nba";
  const url = `${config.gammaApiUrl}/teams?league=${league}`;
  const data = await timed(`/teams?league=${league}`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
  if (data) save("gamma-teams.json", data);
}

async function snapshotClobLastTradePrice(tokenId: string) {
  console.log("\n5. Polymarket CLOB — GET /last-trade-price");
  const url = `${config.clobApiUrl}/last-trade-price?token_id=${tokenId}`;
  const data = await timed(`/last-trade-price`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
  if (data) save("clob-last-trade-price.json", data);
}

async function snapshotClobOrderbook(tokenId: string) {
  console.log("\n6. Polymarket CLOB — GET /book");
  const url = `${config.clobApiUrl}/book?token_id=${tokenId}`;
  const data = await timed(`/orderbook`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
  if (data) save("clob-orderbook.json", data);
}

async function snapshotPolygonBalance() {
  console.log("\n7. Polygon RPC — USDC balanceOf");
  const usdc = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const paddedAddr = config.funderAddress.replace("0x", "").padStart(64, "0");
  const callData = `0x70a08231000000000000000000000000${paddedAddr}`;
  const data = await timed("eth_call balanceOf", async () => {
    const res = await fetch(config.polygonRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: usdc, data: callData }, "latest"],
        id: 1,
      }),
    });
    return res.json();
  });
  if (data && (data as any).result) {
    const raw = BigInt((data as any).result);
    console.log(`  → ${Number(raw) / 1e6} USDC`);
  }
  if (data) save("polygon-usdc-balance.json", data);
}

async function snapshotOddsWs() {
  console.log("\n8. Odds API — WebSocket (1 message)");
  const sports = config.oddsApiSports.join(",") || "upcoming";
  const params: Record<string, string> = {
    apiKey: config.oddsApiKey,
    markets: "ML,Spread,Totals",
    sport: sports,
  };
  if (config.oddsApiLeagues.length) {
    params.leagues = config.oddsApiLeagues.join(",");
  }
  const msg = await timed("Odds WS", () =>
    collectWsMessage(config.oddsApiWsUrl, { queryParams: params }),
  );
  if (msg) save("odds-api-ws.json", msg);
}

async function snapshotPolyMarketWs(tokenIds: string[]) {
  console.log("\n9. Polymarket — Market Price WebSocket (1 message)");
  if (!tokenIds.length) {
    console.log("  ⚠ No token IDs — skipping.");
    return;
  }
  const ids = tokenIds.slice(0, 4);
  const msg = await timed("Poly Market WS", () =>
    collectWsMessage(config.polyWsUrl, {
      onOpen: (ws) => {
        ws.send(
          JSON.stringify({
            type: "market",
            assets_ids: ids,
            initial_dump: true,
            level: 2,
            custom_feature_enabled: false,
          }),
        );
      },
    }),
  );
  if (msg) save("polymarket-ws.json", msg);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("POLYMARKET BOT — DATA SOURCE SNAPSHOT");
  console.log(`Output: ${SAMPLES_DIR}/\n`);

  const events = await snapshotOddsApiEvents();
  await snapshotOddsApiOdds(events as any[] | null);

  const markets = await snapshotGammaMarkets();
  await snapshotGammaTeams();

  let sampleTokenId = "";
  if (markets && Array.isArray(markets) && markets.length > 0) {
    const raw = markets[0].clobTokenIds;
    const ids: string[] = typeof raw === "string" ? JSON.parse(raw) : raw;
    sampleTokenId = ids[0] ?? "";
  }

  if (sampleTokenId) {
    await snapshotClobLastTradePrice(sampleTokenId);
    await snapshotClobOrderbook(sampleTokenId);
  } else {
    console.log("\n  ⚠ No token ID from Gamma — skipping CLOB REST calls.");
  }

  await snapshotPolygonBalance();
  await snapshotOddsWs();

  const tokenIds: string[] = [];
  if (markets && Array.isArray(markets)) {
    for (const m of markets.slice(0, 2)) {
      const raw = m.clobTokenIds;
      const ids: string[] = typeof raw === "string" ? JSON.parse(raw) : raw;
      tokenIds.push(...ids);
    }
  }
  await snapshotPolyMarketWs(tokenIds);

  console.log("\n✓ Done — all samples in datasamples/");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
