// scripts/analyze-trades.ts
// Trade analysis: joins local entry log with Polymarket closed positions
// to compute win/loss, PnL, edge calibration, and breakdowns by sport/type.
//
// Usage:
//   npx tsx scripts/analyze-trades.ts                     # all trades
//   npx tsx scripts/analyze-trades.ts --after 2026-03-27  # trades after date
//   npx tsx scripts/analyze-trades.ts --before 2026-03-28 # trades before date
//   npx tsx scripts/analyze-trades.ts --sport nba         # filter by sport
//   npx tsx scripts/analyze-trades.ts --type spreads      # filter by market type

import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

// ── Types ───────────────────────────────────────────────────────────

interface Entry {
  ts: string;
  slug: string;
  homeTeam: string;
  awayTeam: string;
  betOn: string;
  tokenSide: "YES" | "NO";
  marketType: string;
  point?: number;
  price: number;
  sharpProb: number;
  edgePct: number;
  kellyFraction: number;
  shares: number;
  usdcRisk: number;
  dryRun: boolean;
}

interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number; // 1 = won, 0 = lost
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  timestamp: number;
}

interface AnalyzedTrade {
  entry: Entry;
  closed?: ClosedPosition;
  sport: string;
  won: boolean | null; // null = still open
  pnl: number | null;
}

// ── CLI Args ────────────────────────────────────────────────────────

function parseArgs(): { after?: Date; before?: Date; sport?: string; type?: string } {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    opts[key] = args[i + 1];
  }
  return {
    after: opts.after ? new Date(opts.after) : undefined,
    before: opts.before ? new Date(opts.before) : undefined,
    sport: opts.sport,
    type: opts.type,
  };
}

// ── Data Loading ────────────────────────────────────────────────────

function loadEntries(): Entry[] {
  const file = path.resolve(import.meta.dirname, "../data/entries.jsonl");
  if (!fs.existsSync(file)) {
    console.error("No entries.jsonl found");
    process.exit(1);
  }
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

async function fetchAllClosedPositions(wallet: string): Promise<ClosedPosition[]> {
  const all: ClosedPosition[] = [];
  const limit = 50;
  let offset = 0;

  while (true) {
    const url = `https://data-api.polymarket.com/closed-positions?user=${wallet}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`API error: ${res.status}`);
      break;
    }
    const batch: ClosedPosition[] = await res.json();
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

// ── Helpers ─────────────────────────────────────────────────────────

function sportFromSlug(slug: string): string {
  const prefix = slug.split("-")[0];
  const map: Record<string, string> = {
    nba: "NBA", nfl: "NFL", mlb: "MLB", cbb: "CBB", cfb: "CFB",
    wnba: "WNBA", epl: "EPL", atp: "ATP", wta: "WTA",
    aus: "AUS", mls: "MLS",
  };
  return map[prefix] ?? prefix.toUpperCase();
}

function dedup(entries: Entry[]): Entry[] {
  // Dedup by slug — keep first entry per slug as representative signal
  // Sum usdcRisk and shares across all fires for the same slug
  const bySlug = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = bySlug.get(e.slug) ?? [];
    arr.push(e);
    bySlug.set(e.slug, arr);
  }

  const result: Entry[] = [];
  for (const [, group] of bySlug) {
    // Use first entry as the representative (first signal that fired)
    const first = group[0];
    result.push({
      ...first,
      // Sum total capital deployed across all fires for this market
      usdcRisk: group.reduce((s, e) => s + e.usdcRisk, 0),
      shares: group.reduce((s, e) => s + e.shares, 0),
    });
  }
  return result;
}

function pct(n: number, d: number): string {
  if (d === 0) return "N/A";
  return ((n / d) * 100).toFixed(1) + "%";
}

function usd(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}
function rpad(s: string, n: number): string {
  return s.padStart(n);
}

// ── Analysis ────────────────────────────────────────────────────────

function analyze(trades: AnalyzedTrade[]): void {
  const resolved = trades.filter((t) => t.won !== null);
  const open = trades.filter((t) => t.won === null);
  const wins = resolved.filter((t) => t.won === true);
  const losses = resolved.filter((t) => t.won === false);

  const totalPnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalRisked = resolved.reduce((s, t) => s + t.entry.usdcRisk, 0);
  const totalRiskedAll = trades.reduce((s, t) => s + t.entry.usdcRisk, 0);

  // ── Config context ──
  console.log("=== Bot Config at Analysis Time ===");
  console.log(`  MIN_EDGE:         ${process.env.MIN_EDGE ?? "?"}`);
  console.log(`  KELLY_FRACTION:   ${process.env.KELLY_FRACTION ?? "?"}`);
  console.log(`  MAX_KELLY_PCT:    ${process.env.MAX_KELLY_PCT ?? "?"}`);
  console.log(`  MAX_POSITION_PCT: ${process.env.MAX_POSITION_PCT ?? "?"}`);
  console.log(`  MAX_EVENT_PCT:    ${process.env.MAX_EVENT_PCT ?? "?"}`);
  console.log(`  MARKET_MAKER:     ${process.env.MARKET_MAKER ?? "?"}`);
  console.log(`  DRY_RUN:          ${process.env.DRY_RUN ?? "?"}`);
  console.log(`  BOOKMAKER_ID:     ${process.env.BOOKMAKER_ID ?? "?"}`);
  console.log();

  // ── Summary ──
  console.log("=== Summary ===");
  console.log(`  Total entries:  ${trades.length}`);
  console.log(`  Resolved:       ${resolved.length}  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Open:           ${open.length}`);
  console.log(`  Win rate:       ${pct(wins.length, resolved.length)}`);
  console.log(`  Total PnL:      ${usd(totalPnl)}`);
  console.log(`  Total risked:   $${totalRisked.toFixed(2)}  (resolved only)`);
  console.log(`  ROI:            ${pct(totalPnl, totalRisked)}`);
  console.log(`  Total deployed: $${totalRiskedAll.toFixed(2)}  (all entries)`);
  console.log();

  if (resolved.length === 0) {
    console.log("No resolved trades to analyze.\n");
    return;
  }

  // ── By Sport ──
  printBreakdown("By Sport", resolved, (t) => t.sport);

  // ── By Market Type ──
  printBreakdown("By Market Type", resolved, (t) => t.entry.marketType);

  // ── By Price Tier ──
  // Longshots (low price) behave very differently from favorites — reveals systematic bias
  printBreakdown("By Price Tier", resolved, (t) => {
    const p = t.entry.price;
    if (p < 0.30) return "0-30% (long)";
    if (p < 0.50) return "30-50% (dog)";
    if (p < 0.70) return "50-70% (fav)";
    return "70%+ (heavy)";
  });

  // ── Edge Calibration ──
  // Are our edge estimates predictive? Group by edge bucket, compare expected vs actual win rate
  console.log("=== Edge Calibration ===");
  console.log(
    pad("Edge Bucket", 14),
    rpad("Trades", 8),
    rpad("Wins", 6),
    rpad("WinRate", 9),
    rpad("AvgEdge", 9),
    rpad("AvgPrice", 10),
    rpad("ExpWR", 8),
    rpad("CalGap", 9),
    rpad("PnL", 10),
  );

  const edgeBuckets = [
    { label: "2-5%", min: 2, max: 5 },
    { label: "5-10%", min: 5, max: 10 },
    { label: "10-15%", min: 10, max: 15 },
    { label: "15-25%", min: 15, max: 25 },
    { label: "25-50%", min: 25, max: 50 },
    { label: "50%+", min: 50, max: Infinity },
  ];

  for (const b of edgeBuckets) {
    const group = resolved.filter((t) => t.entry.edgePct >= b.min && t.entry.edgePct < b.max);
    if (group.length === 0) continue;

    const w = group.filter((t) => t.won).length;
    const avgEdge = avg(group.map((t) => t.entry.edgePct));
    const avgPrice = avg(group.map((t) => t.entry.price));
    // Expected win rate = sharp probability (what we thought)
    const expWR = avg(group.map((t) => t.entry.sharpProb));
    const actualWR = w / group.length;
    // Calibration gap: positive = we're winning more than expected (sharp line was conservative)
    //                  negative = we're losing more than expected (sharp line was too generous)
    const calGap = actualWR - expWR;
    const calGapStr = (calGap >= 0 ? "+" : "") + (calGap * 100).toFixed(1) + "%";
    const pnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);

    console.log(
      pad(b.label, 14),
      rpad(String(group.length), 8),
      rpad(String(w), 6),
      rpad(pct(w, group.length), 9),
      rpad(avgEdge.toFixed(1) + "%", 9),
      rpad(avgPrice.toFixed(3), 10),
      rpad((expWR * 100).toFixed(1) + "%", 8),
      rpad(calGapStr, 9),
      rpad(usd(pnl), 10),
    );
  }
  console.log();

  // ── Biggest Wins / Losses ──
  const byPnl = [...resolved].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));

  console.log("=== Top 5 Wins ===");
  for (const t of byPnl.slice(0, 5)) {
    console.log(
      `  ${usd(t.pnl!).padStart(8)}  edge=${t.entry.edgePct.toFixed(1)}%  price=${t.entry.price.toFixed(3)}  ${t.entry.betOn} (${t.entry.marketType})  ${t.entry.slug}`,
    );
  }
  console.log();

  console.log("=== Top 5 Losses ===");
  for (const t of byPnl.slice(-5).reverse()) {
    console.log(
      `  ${usd(t.pnl!).padStart(8)}  edge=${t.entry.edgePct.toFixed(1)}%  price=${t.entry.price.toFixed(3)}  ${t.entry.betOn} (${t.entry.marketType})  ${t.entry.slug}`,
    );
  }
  console.log();

  // ── Daily PnL ──
  const byDate = new Map<string, AnalyzedTrade[]>();
  for (const t of resolved) {
    const date = t.entry.ts.slice(0, 10);
    const arr = byDate.get(date) ?? [];
    arr.push(t);
    byDate.set(date, arr);
  }

  const sortedDates = [...byDate.keys()].sort();
  if (sortedDates.length > 0) {
    let cumPnl = 0;
    console.log("=== Daily PnL ===");
    console.log(
      pad("Date", 14),
      rpad("Trades", 8),
      rpad("W/L", 8),
      rpad("PnL", 10),
      rpad("Cumul", 10),
      rpad("AvgEdge", 9),
    );
    for (const date of sortedDates) {
      const group = byDate.get(date)!;
      const w = group.filter((t) => t.won).length;
      const l = group.length - w;
      const dayPnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
      cumPnl += dayPnl;
      const ae = avg(group.map((t) => t.entry.edgePct));
      console.log(
        pad(date, 14),
        rpad(String(group.length), 8),
        rpad(`${w}/${l}`, 8),
        rpad(usd(dayPnl), 10),
        rpad(usd(cumPnl), 10),
        rpad(ae.toFixed(1) + "%", 9),
      );
    }
    console.log();
  }

  // ── Open positions ──
  if (open.length > 0) {
    console.log(`=== Open Positions (${open.length}) ===`);
    for (const t of open.slice(0, 15)) {
      console.log(
        `  edge=${t.entry.edgePct.toFixed(1)}%  price=${t.entry.price.toFixed(3)}  risk=$${t.entry.usdcRisk.toFixed(2)}  ${t.entry.betOn} (${t.entry.marketType})  ${t.entry.slug}`,
      );
    }
    if (open.length > 15) console.log(`  ... and ${open.length - 15} more`);
    console.log();
  }
}

function printBreakdown(
  title: string,
  resolved: AnalyzedTrade[],
  keyFn: (t: AnalyzedTrade) => string,
): void {
  const groups = new Map<string, AnalyzedTrade[]>();
  for (const t of resolved) {
    const key = keyFn(t);
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  console.log(`=== ${title} ===`);
  console.log(
    pad("Group", 14),
    rpad("Trades", 8),
    rpad("W/L", 8),
    rpad("WinRate", 9),
    rpad("PnL", 10),
    rpad("Risked", 10),
    rpad("ROI", 8),
    rpad("AvgEdge", 9),
  );

  // Sort by trade count descending
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [key, group] of sorted) {
    const w = group.filter((t) => t.won).length;
    const l = group.length - w;
    const pnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const risked = group.reduce((s, t) => s + t.entry.usdcRisk, 0);
    const ae = avg(group.map((t) => t.entry.edgePct));

    console.log(
      pad(key, 14),
      rpad(String(group.length), 8),
      rpad(`${w}/${l}`, 8),
      rpad(pct(w, group.length), 9),
      rpad(usd(pnl), 10),
      rpad(`$${risked.toFixed(2)}`, 10),
      rpad(pct(pnl, risked), 8),
      rpad(ae.toFixed(1) + "%", 9),
    );
  }
  console.log();
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const wallet = process.env.FUNDER_ADDRESS;
  if (!wallet) {
    console.error("FUNDER_ADDRESS not set in .env");
    process.exit(1);
  }

  // Load local entries
  let entries = dedup(loadEntries());
  console.log(`Loaded ${entries.length} unique entries from entries.jsonl\n`);

  // Apply filters
  if (opts.after) {
    entries = entries.filter((e) => new Date(e.ts) >= opts.after!);
  }
  if (opts.before) {
    entries = entries.filter((e) => new Date(e.ts) < opts.before!);
  }
  if (opts.sport) {
    const s = opts.sport.toLowerCase();
    entries = entries.filter((e) => sportFromSlug(e.slug).toLowerCase() === s);
  }
  if (opts.type) {
    entries = entries.filter((e) => e.marketType === opts.type);
  }

  if (entries.length === 0) {
    console.log("No entries match filters.");
    return;
  }

  const filterDesc = [
    opts.after && `after ${opts.after.toISOString().slice(0, 10)}`,
    opts.before && `before ${opts.before.toISOString().slice(0, 10)}`,
    opts.sport && `sport=${opts.sport}`,
    opts.type && `type=${opts.type}`,
  ]
    .filter(Boolean)
    .join(", ");

  if (filterDesc) console.log(`Filters: ${filterDesc}`);
  console.log(`Analyzing ${entries.length} entries...\n`);

  // Fetch closed positions from Polymarket
  console.log("Fetching closed positions from Polymarket...");
  const closedPositions = await fetchAllClosedPositions(wallet);
  console.log(`Found ${closedPositions.length} closed positions\n`);

  // Index closed positions by slug — multiple positions per slug possible (YES + NO tokens)
  const closedBySlug = new Map<string, ClosedPosition[]>();
  for (const cp of closedPositions) {
    const arr = closedBySlug.get(cp.slug) ?? [];
    arr.push(cp);
    closedBySlug.set(cp.slug, arr);
  }

  // Aggregate PnL per slug (sum across both outcome tokens)
  const pnlBySlug = new Map<string, number>();
  const wonBySlug = new Map<string, boolean>();
  for (const [slug, positions] of closedBySlug) {
    const totalPnl = positions.reduce((s, p) => s + p.realizedPnl, 0);
    pnlBySlug.set(slug, totalPnl);
    wonBySlug.set(slug, totalPnl >= 0);
  }

  // Join entries with closed positions
  const trades: AnalyzedTrade[] = entries.map((entry) => {
    const candidates = closedBySlug.get(entry.slug) ?? [];
    const closed = candidates[0]; // use first for metadata

    let won: boolean | null = null;
    let pnl: number | null = null;

    if (candidates.length > 0) {
      pnl = pnlBySlug.get(entry.slug)!;
      won = wonBySlug.get(entry.slug)!;
    }

    return {
      entry,
      closed: closed ?? undefined,
      sport: sportFromSlug(entry.slug),
      won,
      pnl,
    };
  });

  analyze(trades);
}

main().catch(console.error);
