/**
 * analyze-trader.ts
 *
 * Fetches closed positions, current positions, and recent activity for a given
 * Polymarket address, then cross-references with The Odds API to surface
 * probable entry signals and P&L stats.
 *
 * Usage:
 *   tsx scripts/analyze-trader.ts [address]
 *
 * Defaults to TRADER_ADDRESS env var or the hardcoded target below.
 */

import "dotenv/config";

const TARGET_ADDRESS =
  process.argv[2] ??
  process.env.TRADER_ADDRESS ??
  "0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e";

const ODDS_API_KEY = process.env.ODDS_API_KEY!;
const ODDS_API_REST = process.env.ODDS_API_REST_URL ?? "https://api.odds-api.io";
const BOOKMAKER_ID = process.env.BOOKMAKER_ID ?? "Betfair Exchange";

const DATA_BASE = "https://data-api.polymarket.com";

// ── helpers ────────────────────────────────────────────────────────────────

async function get<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[${label}] HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

function pct(n: number) {
  return (n * 100).toFixed(2) + "%";
}

function usd(n: number) {
  return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
}

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleString();
}

function bar(val: number, max: number, width = 20): string {
  const filled = Math.round((val / (max || 1)) * width);
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

// ── Polymarket API types (per official OpenAPI spec) ──────────────────────

interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;      // USDC spent
  realizedPnl: number;
  curPrice: number;
  timestamp: number;        // unix seconds
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;          // "Yes" | "No"
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
}

interface CurrentPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;             // shares held
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;          // unrealised P&L
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

interface Activity {
  proxyWallet: string;
  timestamp: number;        // unix seconds
  conditionId: string;
  type: string;             // TRADE | SPLIT | MERGE | REDEEM | REWARD | ...
  size: number;             // tokens
  usdcSize: number;         // USDC
  price: number;
  asset: string;
  side: string;             // BUY | SELL
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
}

// ── fetch functions ────────────────────────────────────────────────────────

/** Paginate through all closed positions (max 50/page). */
async function fetchAllClosedPositions(address: string): Promise<ClosedPosition[]> {
  const all: ClosedPosition[] = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const url = `${DATA_BASE}/closed-positions?user=${address}&limit=${limit}&offset=${offset}&sortBy=REALIZEDPNL&sortDirection=DESC`;
    const page = await get<ClosedPosition[]>(url, "closed-positions");
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
    if (offset >= 10000) break; // API max
  }
  return all;
}

async function fetchCurrentPositions(address: string): Promise<CurrentPosition[]> {
  const url = `${DATA_BASE}/positions?user=${address}&sizeThreshold=0.1&limit=500&sortBy=TOKENS&sortDirection=DESC`;
  return get<CurrentPosition[]>(url, "current-positions");
}

async function fetchActivity(address: string, limit = 500): Promise<Activity[]> {
  const url = `${DATA_BASE}/activity?user=${address}&limit=${limit}&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC`;
  return get<Activity[]>(url, "activity");
}

// ── Odds API ───────────────────────────────────────────────────────────────

interface OddsEvent {
  id: number;
  home: string;
  away: string;
  date: string;
  sport: { slug: string };
  league: { slug: string };
}

async function fetchOddsEvents(sports: string[]): Promise<OddsEvent[]> {
  if (!ODDS_API_KEY) return [];
  const all: OddsEvent[] = [];
  for (const sport of sports) {
    try {
      const url = `${ODDS_API_REST}/v3/events?sport=${sport}&apiKey=${ODDS_API_KEY}`;
      const data: any = await get(url, `odds-events-${sport}`);
      const events: OddsEvent[] = Array.isArray(data) ? data : (data?.events ?? data?.data ?? []);
      all.push(...events);
    } catch {
      // skip per-sport failures silently
    }
  }
  return all;
}

async function fetchOddsForEvent(eventId: number): Promise<any> {
  const url = `${ODDS_API_REST}/v3/odds?id=${eventId}&bookmaker=${encodeURIComponent(BOOKMAKER_ID)}&apiKey=${ODDS_API_KEY}`;
  return get(url, `odds-${eventId}`).catch(() => null);
}

function impliedProbFromDecimal(d: string | number): number {
  const n = parseFloat(String(d));
  return n > 1 ? 1 / n : 0;
}

function extractMLProbs(oddsData: any): { home: number; away: number; draw?: number } | null {
  if (!oddsData) return null;
  const bm = oddsData.bookmakers?.[BOOKMAKER_ID];
  if (!bm) return null;
  const ml = bm.find((m: any) =>
    ["ML", "Moneyline", "1X2", "H2H"].includes(m.name)
  );
  if (!ml?.odds?.[0]) return null;
  const o = ml.odds[0];
  return {
    home: o.home ? impliedProbFromDecimal(o.home) : 0,
    away: o.away ? impliedProbFromDecimal(o.away) : 0,
    draw: o.draw ? impliedProbFromDecimal(o.draw) : undefined,
  };
}

// ── analysis ──────────────────────────────────────────────────────────────

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function matchEventToTitle(title: string, events: OddsEvent[]): { event: OddsEvent; score: number } | null {
  const t = normalize(title);
  let best: OddsEvent | null = null;
  let bestScore = 0;
  for (const ev of events) {
    const tokens = [
      ...normalize(ev.home).split(" "),
      ...normalize(ev.away).split(" "),
    ].filter((w) => w.length > 3);
    const hits = tokens.filter((w) => t.includes(w)).length;
    if (hits > bestScore) {
      bestScore = hits;
      best = ev;
    }
  }
  return best && bestScore >= 1 ? { event: best, score: bestScore } : null;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(70));
  console.log("  POLYMARKET TRADER ANALYSIS");
  console.log(`  Address : ${TARGET_ADDRESS}`);
  console.log("═".repeat(70) + "\n");

  // ── 1. Fetch all data ──────────────────────────────────────────────────
  console.log("Fetching data from Polymarket…");
  const [closed, current, activity] = await Promise.all([
    fetchAllClosedPositions(TARGET_ADDRESS),
    fetchCurrentPositions(TARGET_ADDRESS),
    fetchActivity(TARGET_ADDRESS),
  ]);

  const trades = activity.filter((a) => a.type === "TRADE");
  console.log(
    `  Closed positions : ${closed.length}` +
    `  |  Current positions : ${current.length}` +
    `  |  Trade events : ${trades.length}\n`
  );

  // ── 2. Closed positions summary ────────────────────────────────────────
  console.log("── CLOSED POSITIONS SUMMARY ──────────────────────────────────────");
  if (closed.length > 0) {
    const totalPnl = closed.reduce((s, p) => s + p.realizedPnl, 0);
    const winners = closed.filter((p) => p.realizedPnl > 0);
    const losers = closed.filter((p) => p.realizedPnl < 0);
    const winRate = winners.length / closed.length;

    console.log(`  Total realised P&L : ${usd(totalPnl)}`);
    console.log(`  Win rate           : ${bar(winRate, 1)} ${pct(winRate)} (${winners.length}W / ${losers.length}L)`);

    const avgWin = winners.length
      ? winners.reduce((s, p) => s + p.realizedPnl, 0) / winners.length
      : 0;
    const avgLoss = losers.length
      ? losers.reduce((s, p) => s + p.realizedPnl, 0) / losers.length
      : 0;
    console.log(`  Avg winner         : ${usd(avgWin)}`);
    console.log(`  Avg loser          : ${usd(avgLoss)}`);
    if (avgLoss !== 0) {
      console.log(`  Profit factor      : ${(Math.abs(avgWin * winners.length) / Math.abs(avgLoss * losers.length)).toFixed(2)}x`);
    }

    // Outcome bias
    const yesBuys = closed.filter((p) => p.outcome?.toLowerCase() === "yes").length;
    const noBuys = closed.filter((p) => p.outcome?.toLowerCase() === "no").length;
    console.log(`\n  YES positions : ${yesBuys}   NO positions : ${noBuys}`);

    // Entry price distribution
    const buckets: [string, (p: number) => boolean][] = [
      ["<10¢",   (p) => p < 0.10],
      ["10-30¢", (p) => p >= 0.10 && p < 0.30],
      ["30-50¢", (p) => p >= 0.30 && p < 0.50],
      ["50-70¢", (p) => p >= 0.50 && p < 0.70],
      ["70-90¢", (p) => p >= 0.70 && p < 0.90],
      [">90¢",   (p) => p >= 0.90],
    ];
    const counts = buckets.map(([, fn]) => closed.filter((p) => fn(p.avgPrice)).length);
    const maxCount = Math.max(...counts);
    console.log("\n  Entry price distribution (avgPrice):");
    buckets.forEach(([label], i) => {
      console.log(`    ${label.padEnd(7)} ${bar(counts[i], maxCount, 15)} ${counts[i]}`);
    });

    // Top 15 by |P&L|
    const top = [...closed].sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl)).slice(0, 15);
    console.log("\n  Top 15 trades by |P&L|:");
    console.log("  " + ["Market".padEnd(42), "Out".padEnd(4), "Avg$".padEnd(7), "PnL"].join(" "));
    console.log("  " + "─".repeat(65));
    for (const p of top) {
      const mkt = (p.title ?? p.slug ?? p.conditionId).slice(0, 41).padEnd(41);
      const out = (p.outcome ?? "?").slice(0, 3).padEnd(3);
      const avg = pct(p.avgPrice ?? 0).padEnd(6);
      const pnl = usd(p.realizedPnl);
      console.log(`  ${mkt} ${out} ${avg} ${pnl}`);
    }

    // Strategy hints
    console.log("\n  Strategy hints:");
    const avgEntry = closed.reduce((s, p) => s + p.avgPrice, 0) / closed.length;
    const avgEntryWin = winners.length
      ? winners.reduce((s, p) => s + p.avgPrice, 0) / winners.length
      : 0;
    const avgSpend = closed.reduce((s, p) => s + p.totalBought, 0) / closed.length;
    console.log(`    Avg entry price (all)    : ${pct(avgEntry)}`);
    console.log(`    Avg entry price (winners): ${pct(avgEntryWin)}`);
    console.log(`    Avg USDC per trade       : ${usd(avgSpend).replace("+", "")}`);
  } else {
    console.log("  No closed positions returned.");
  }

  // ── 3. Current open positions ──────────────────────────────────────────
  console.log("\n── CURRENT OPEN POSITIONS ────────────────────────────────────────");
  if (current.length > 0) {
    const totalUnrealized = current.reduce((s, p) => s + p.cashPnl, 0);
    const totalDeployed = current.reduce((s, p) => s + p.totalBought, 0);
    console.log(`  Count              : ${current.length}`);
    console.log(`  Total deployed     : $${totalDeployed.toFixed(2)}`);
    console.log(`  Unrealised P&L     : ${usd(totalUnrealized)}\n`);

    console.log("  " + ["Market".padEnd(42), "Out".padEnd(4), "Avg$".padEnd(7), "Now$".padEnd(7), "Shares".padEnd(9), "uPnL"].join(" "));
    console.log("  " + "─".repeat(80));
    for (const p of current) {
      const mkt = (p.title ?? p.slug ?? p.conditionId).slice(0, 41).padEnd(41);
      const out = (p.outcome ?? "?").slice(0, 3).padEnd(3);
      const avg = pct(p.avgPrice ?? 0).padEnd(6);
      const now = pct(p.curPrice ?? 0).padEnd(6);
      const shares = (p.size ?? 0).toFixed(1).padEnd(8);
      const pnl = usd(p.cashPnl ?? 0);
      console.log(`  ${mkt} ${out} ${avg} ${now} ${shares} ${pnl}`);
    }
  } else {
    console.log("  No open positions.");
  }

  // ── 4. Recent trade activity ───────────────────────────────────────────
  console.log("\n── RECENT TRADES (last 20) ───────────────────────────────────────");
  const recentTrades = trades.slice(0, 20);
  if (recentTrades.length > 0) {
    console.log("  " + ["Date".padEnd(22), "Side".padEnd(5), "Out".padEnd(4), "Price".padEnd(8), "USDC".padEnd(9), "Market"].join(" "));
    console.log("  " + "─".repeat(80));
    for (const t of recentTrades) {
      const dt = fmtDate(t.timestamp).padEnd(21);
      const side = (t.side ?? "?").padEnd(4);
      const out = (t.outcome ?? "?").slice(0, 3).padEnd(3);
      const price = pct(t.price ?? 0).padEnd(7);
      const usdc = `$${(t.usdcSize ?? 0).toFixed(2)}`.padEnd(8);
      const mkt = (t.title ?? t.slug ?? t.conditionId ?? "?").slice(0, 35);
      console.log(`  ${dt} ${side} ${out} ${price} ${usdc} ${mkt}`);
    }
  } else {
    console.log("  No trade activity found.");
  }

  // ── 5. Behavioural fingerprint ─────────────────────────────────────────
  console.log("\n── BEHAVIOURAL FINGERPRINT ───────────────────────────────────────");
  if (trades.length > 0) {
    const buys = trades.filter((t) => t.side === "BUY");
    const sells = trades.filter((t) => t.side === "SELL");
    const avgUsdcPerTrade = trades.reduce((s, t) => s + t.usdcSize, 0) / trades.length;
    const avgBuyPrice = buys.length
      ? buys.reduce((s, t) => s + t.price, 0) / buys.length
      : 0;
    const yesBuys = buys.filter((t) => t.outcome?.toLowerCase() === "yes").length;
    const noBuys = buys.filter((t) => t.outcome?.toLowerCase() === "no").length;

    // Time-of-day pattern (UTC hours)
    const hourCounts = new Array(24).fill(0);
    for (const t of trades) {
      const h = new Date(t.timestamp * 1000).getUTCHours();
      hourCounts[h]++;
    }
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

    console.log(`  BUY trades         : ${buys.length}  |  SELL trades : ${sells.length}`);
    console.log(`  Avg USDC per trade : $${avgUsdcPerTrade.toFixed(2)}`);
    console.log(`  Avg buy price      : ${pct(avgBuyPrice)}`);
    console.log(`  YES buys : ${yesBuys}   NO buys : ${noBuys}`);
    console.log(`  Peak trading hour  : ${peakHour}:00 UTC`);

    // Price bucket bias on buys
    const buyBuckets: [string, (p: number) => boolean][] = [
      ["<10¢",   (p) => p < 0.10],
      ["10-30¢", (p) => p >= 0.10 && p < 0.30],
      ["30-50¢", (p) => p >= 0.30 && p < 0.50],
      ["50-70¢", (p) => p >= 0.50 && p < 0.70],
      ["70-90¢", (p) => p >= 0.70 && p < 0.90],
      [">90¢",   (p) => p >= 0.90],
    ];
    const buyCounts = buyBuckets.map(([, fn]) => buys.filter((t) => fn(t.price)).length);
    const maxBuy = Math.max(...buyCounts);
    console.log("\n  Buy price distribution:");
    buyBuckets.forEach(([label], i) => {
      console.log(`    ${label.padEnd(7)} ${bar(buyCounts[i], maxBuy, 15)} ${buyCounts[i]}`);
    });
  }

  // ── 6. Odds API cross-reference for open positions ────────────────────
  if (ODDS_API_KEY && current.length > 0) {
    console.log("\n── ODDS CROSS-REFERENCE (open positions) ─────────────────────────");
    const sports = (process.env.ODDS_API_SPORTS ?? "basketball,football,american-football,tennis,baseball").split(",");
    console.log(`  Fetching live events for: ${sports.join(", ")} …`);
    const oddsEvents = await fetchOddsEvents(sports);
    console.log(`  Got ${oddsEvents.length} events\n`);

    for (const pos of current) {
      const match = matchEventToTitle(pos.title ?? "", oddsEvents);
      if (!match) continue;

      const oddsData: any = await fetchOddsForEvent(match.event.id);
      const probs = extractMLProbs(oddsData);

      console.log(`  Market  : ${(pos.title ?? pos.slug).slice(0, 60)}`);
      console.log(`  Side    : ${pos.outcome}  avg=${pct(pos.avgPrice)}  now=${pct(pos.curPrice)}  uPnL=${usd(pos.cashPnl)}`);
      console.log(`  Matched : ${match.event.home} vs ${match.event.away} [score=${match.score}]`);

      if (probs) {
        const total = (probs.home ?? 0) + (probs.away ?? 0) + (probs.draw ?? 0);
        const normHome = total > 0 ? probs.home / total : probs.home;
        const normAway = total > 0 ? probs.away / total : probs.away;
        const titleNorm = normalize(pos.title ?? "");
        const isHome = normalize(match.event.home).split(" ").some((w) => w.length > 3 && titleNorm.includes(w));
        const sharpProb = isHome ? normHome : normAway;
        const edge = sharpProb - pos.curPrice;
        console.log(`  Sharp   : home=${pct(normHome)} away=${pct(normAway)}${probs.draw != null ? ` draw=${pct((probs.draw ?? 0) / total)}` : ""}`);
        console.log(`  Edge vs current price: ${edge >= 0 ? "+" : ""}${pct(edge)}`);
      } else {
        console.log(`  Odds    : no ML odds found (${BOOKMAKER_ID})`);
      }
      console.log();
    }
  }

  console.log("═".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
