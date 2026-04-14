#!/usr/bin/env npx ts-node
/**
 * Trade Analysis Script
 * Analyzes trades.jsonl for performance, edge correlation, behavioral patterns,
 * and price movement quality.
 *
 * Usage: npx ts-node scripts/analyze-trades.ts [path/to/trades.jsonl]
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────────────────

interface Trade {
  ts: string;
  slug: string;
  side: "YES" | "NO";
  entryPrice: number;
  exitPrice: number;
  size: number;
  edgeAtEntry: number | null;
  kellyAtEntry: number | null;
  exitReason: string | null;
  profitPerShare: number;
  totalProfit: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function stddev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function pct(n: number, d: number): string {
  return d === 0 ? "N/A" : `${((n / d) * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function maxDrawdown(profits: number[]): number {
  let peak = 0,
    cumulative = 0,
    maxDD = 0;
  for (const p of profits) {
    cumulative += p;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function correlate(xs: number[], ys: number[]): number {
  const mx = mean(xs),
    my = mean(ys);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(
    xs.reduce((s, x) => s + (x - mx) ** 2, 0) *
      ys.reduce((s, y) => s + (y - my) ** 2, 0)
  );
  return den === 0 ? 0 : num / den;
}

function table(
  rows: Array<Record<string, string | number>>,
  title: string
): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  );
  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const header = cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│");
  console.log(`\n  ${title}`);
  console.log(`  ┌${sep.replace(/┼/g, "┬")}┐`);
  console.log(`  │${header}│`);
  console.log(`  ├${sep}┤`);
  for (const row of rows) {
    const line = cols
      .map((c, i) => ` ${String(row[c]).padEnd(widths[i])} `)
      .join("│");
    console.log(`  │${line}│`);
  }
  console.log(`  └${sep.replace(/┼/g, "┴")}┘`);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

/**
 * Duplicate pattern: same slug appears twice within ~100ms, one with exitReason=null.
 * Keep the record WITH exitReason (the canonical exit event).
 * If both have null exitReason, keep the later one.
 */
function deduplicate(trades: Trade[]): Trade[] {
  const seen = new Map<string, Trade>();
  for (const t of trades) {
    const key = `${t.slug}|${t.side}|${t.entryPrice}|${t.exitPrice}|${t.size}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, t);
    } else {
      // prefer the one with a real exitReason
      if (t.exitReason !== null && existing.exitReason === null) {
        seen.set(key, t);
      }
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
}

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadTrades(filePath: string): Promise<Trade[]> {
  const trades: Trade[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) trades.push(JSON.parse(line));
  }
  return trades;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

function analyze(raw: Trade[]): void {
  const deduped = deduplicate(raw);
  // Include all closed trades (exitReason present), regardless of whether edgeAtEntry is set.
  // Open positions (exitReason === null) are excluded from P&L analysis.
  const trades = deduped.filter((t) => t.exitReason !== null);
  const openCount = deduped.filter((t) => t.exitReason === null).length;
  const profits = trades.map((t) => t.totalProfit);
  const dupeCount = raw.length - deduped.length;

  // ── 1. Summary Metrics ────────────────────────────────────────────────────

  const totalPnL = profits.reduce((a, b) => a + b, 0);
  const wins = trades.filter((t) => t.totalProfit > 0);
  const losses = trades.filter((t) => t.totalProfit < 0);
  const breakeven = trades.filter((t) => t.totalProfit === 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? mean(wins.map((t) => t.totalProfit)) : 0;
  const avgLoss = losses.length ? mean(losses.map((t) => t.totalProfit)) : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const profitFactor =
    losses.length && avgLoss !== 0
      ? Math.abs((winRate * avgWin) / ((1 - winRate) * avgLoss))
      : Infinity;
  const dd = maxDrawdown(profits);
  const sharpeApprox =
    mean(profits) / (stddev(profits) === 0 ? 1 : stddev(profits));

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  POLYMARKET TRADE ANALYSIS");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Dataset : ${raw.length} records → ${trades.length} closed trades, ${openCount} open (${dupeCount} dupes removed)`);
  console.log(`  Period  : ${trades[0]?.ts?.slice(0, 10)} to ${trades[trades.length - 1]?.ts?.slice(0, 10)}`);

  console.log("\n  ┌─ PERFORMANCE SUMMARY ──────────────────────────────────┐");
  console.log(`  │  Total PnL        : ${fmt(totalPnL).padEnd(12)}                    │`);
  console.log(`  │  Win Rate         : ${pct(wins.length, trades.length).padEnd(12)} (${wins.length}W / ${losses.length}L / ${breakeven.length}BE)    │`);
  console.log(`  │  Avg Win          : ${fmt(avgWin).padEnd(12)}                    │`);
  console.log(`  │  Avg Loss         : ${fmt(avgLoss).padEnd(12)}                    │`);
  console.log(`  │  Win/Loss Ratio   : ${(avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0).toFixed(2).padEnd(12)}                    │`);
  console.log(`  │  Expectancy/trade : ${fmt(expectancy).padEnd(12)}                    │`);
  console.log(`  │  Profit Factor    : ${(profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)).padEnd(12)}                    │`);
  console.log(`  │  Max Drawdown     : ${("$" + dd.toFixed(2)).padEnd(12)}                    │`);
  console.log(`  │  Sharpe (approx)  : ${sharpeApprox.toFixed(3).padEnd(12)}                    │`);
  console.log(`  │  Mean profit      : ${fmt(mean(profits)).padEnd(12)}                    │`);
  console.log(`  │  Median profit    : ${fmt(median(profits)).padEnd(12)}                    │`);
  console.log(`  │  StdDev profit    : $${stddev(profits).toFixed(3).padEnd(11)}                    │`);
  console.log(`  │  Best trade       : ${fmt(Math.max(...profits)).padEnd(12)}                    │`);
  console.log(`  │  Worst trade      : ${fmt(Math.min(...profits)).padEnd(12)}                    │`);
  console.log("  └────────────────────────────────────────────────────────┘");

  // ── 2. Exit Reason Breakdown ──────────────────────────────────────────────

  const exitGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = t.exitReason
      ? t.exitReason.startsWith("lock_gain")
        ? "lock_gain"
        : t.exitReason.startsWith("take_profit")
        ? "take_profit"
        : t.exitReason.startsWith("underwater")
        ? "underwater_persistence"
        : t.exitReason.startsWith("stop_loss")
        ? "stop_loss"
        : t.exitReason.startsWith("loss_cut")
        ? "loss_cut"
        : t.exitReason.startsWith("fill_below_entry")
        ? "fill_below_entry"
        : t.exitReason
      : "no_reason";
    if (!exitGroups.has(key)) exitGroups.set(key, []);
    exitGroups.get(key)!.push(t);
  }

  const exitRows = Array.from(exitGroups.entries())
    .map(([reason, ts]) => {
      const pnl = ts.reduce((a, t) => a + t.totalProfit, 0);
      const wr = ts.filter((t) => t.totalProfit > 0).length / ts.length;
      return {
        "Exit Reason": reason,
        Count: ts.length,
        "Total PnL": fmt(pnl),
        "Win Rate": pct(ts.filter((t) => t.totalProfit > 0).length, ts.length),
        "Avg PnL": fmt(mean(ts.map((t) => t.totalProfit))),
      };
    })
    .sort((a, b) => b.Count - a.Count);

  table(exitRows, "EXIT REASON ANALYSIS");

  // ── 3. Side (YES vs NO) ───────────────────────────────────────────────────

  const sides = ["YES", "NO"] as const;
  const sideRows = sides.map((side) => {
    const ts = trades.filter((t) => t.side === side);
    if (ts.length === 0) return { Side: side, Count: 0, "Total PnL": "$0.00", "Win Rate": "N/A", "Avg PnL": "$0.00" };
    const pnl = ts.reduce((a, t) => a + t.totalProfit, 0);
    return {
      Side: side,
      Count: ts.length,
      "Total PnL": fmt(pnl),
      "Win Rate": pct(ts.filter((t) => t.totalProfit > 0).length, ts.length),
      "Avg PnL": fmt(mean(ts.map((t) => t.totalProfit))),
    };
  });

  table(sideRows, "YES vs NO");

  // ── 4. Edge Correlation ───────────────────────────────────────────────────

  const edgeTrades = trades.filter((t) => t.edgeAtEntry !== null) as (Trade & {
    edgeAtEntry: number;
  })[];

  if (edgeTrades.length > 0) {
    const edgeValues = edgeTrades.map((t) => t.edgeAtEntry);
    const edgeProfits = edgeTrades.map((t) => t.totalProfit);
    const corr = correlate(edgeValues, edgeProfits);

    const edgePnL = edgeTrades.reduce((a, t) => a + t.totalProfit, 0);
    const noEdgeTrades = trades.filter((t) => t.edgeAtEntry === null);
    const noEdgePnL = noEdgeTrades.reduce((a, t) => a + t.totalProfit, 0);

    console.log("\n  ┌─ EDGE CORRELATION ─────────────────────────────────────┐");
    console.log(`  │  Trades with edgeAtEntry : ${edgeTrades.length} (${pct(edgeTrades.length, trades.length)})                 │`);
    console.log(`  │  Edge ↔ Profit corr (r)  : ${corr.toFixed(4).padEnd(8)}                       │`);
    console.log(`  │  PnL (edge trades)        : ${fmt(edgePnL).padEnd(10)}                     │`);
    console.log(`  │  PnL (no-edge trades)     : ${fmt(noEdgePnL).padEnd(10)}                     │`);
    console.log(`  │  Avg PnL edge vs no-edge  : ${fmt(mean(edgeProfits))} vs ${fmt(mean(noEdgeTrades.map(t => t.totalProfit)))}         │`);
    console.log("  └────────────────────────────────────────────────────────┘");

    // Bucket by edge quartiles
    const sorted = [...edgeTrades].sort((a, b) => a.edgeAtEntry - b.edgeAtEntry);
    const q = Math.floor(sorted.length / 4);
    const buckets = [
      { label: "Q1 (lowest edge)", ts: sorted.slice(0, q) },
      { label: "Q2", ts: sorted.slice(q, q * 2) },
      { label: "Q3", ts: sorted.slice(q * 2, q * 3) },
      { label: "Q4 (highest edge)", ts: sorted.slice(q * 3) },
    ];

    const bucketRows = buckets.map(({ label, ts }) => ({
      "Edge Bucket": label,
      Count: ts.length,
      "Edge Range": ts.length
        ? `${ts[0].edgeAtEntry.toFixed(3)}–${ts[ts.length - 1].edgeAtEntry.toFixed(3)}`
        : "—",
      "Avg PnL": ts.length ? fmt(mean(ts.map((t) => t.totalProfit))) : "$0",
      "Win Rate": ts.length
        ? pct(ts.filter((t) => t.totalProfit > 0).length, ts.length)
        : "N/A",
    }));

    table(bucketRows, "EDGE QUARTILE BUCKETS");
  } else {
    console.log("\n  [Edge Correlation] — No trades with edgeAtEntry found.");
  }

  // ── 5. Price Movement Analysis ────────────────────────────────────────────

  // Directional correctness:
  // YES trade: we need price to go UP (exitPrice > entryPrice to profit)
  // NO trade: we need price to go DOWN (exitPrice < entryPrice to profit)
  //   But NO shares resolve at 1.0 if event doesn't happen, so exitPrice > entryPrice = profit too
  //   The profitPerShare directly captures this — don't second-guess it

  const directionallyCorrect = trades.filter((t) => t.profitPerShare > 0);
  const directionallyWrong = trades.filter((t) => t.profitPerShare < 0);
  const flat = trades.filter((t) => t.profitPerShare === 0);

  // Trades that were correct but only marginally (price moved right but tiny PnL)
  const correctButTiny = directionallyCorrect.filter(
    (t) => t.totalProfit > 0 && t.totalProfit < 0.1
  );
  const correctBigWin = directionallyCorrect.filter(
    (t) => t.totalProfit >= 1.0
  );

  // Poor-timing check: exited at a loss despite correct thesis
  // (we only have entry/exit snapshots, not full price path — use price direction as proxy)
  const priceMovedFavorably = trades.filter((t) => {
    const moved = t.exitPrice - t.entryPrice;
    return t.side === "YES" ? moved > 0 : moved < 0;
  });
  const priceFavorableButLoss = priceMovedFavorably.filter(
    (t) => t.totalProfit < 0
  );

  console.log("\n  ┌─ PRICE MOVEMENT QUALITY ───────────────────────────────┐");
  console.log(`  │  Directionally correct (pps > 0)  : ${directionallyCorrect.length} (${pct(directionallyCorrect.length, trades.length)})      │`);
  console.log(`  │  Directionally wrong  (pps < 0)   : ${directionallyWrong.length} (${pct(directionallyWrong.length, trades.length)})      │`);
  console.log(`  │  Flat (pps = 0)                   : ${flat.length} (${pct(flat.length, trades.length)})      │`);
  console.log(`  │  Correct thesis but big loss (≥$1): ${trades.filter(t => t.profitPerShare > 0 && t.totalProfit < -1).length}               │`);
  console.log(`  │  Wrong direction but profitable   : ${trades.filter(t => t.profitPerShare < 0 && t.totalProfit > 0).length} (rounding artefacts)   │`);
  console.log(`  │  Tiny wins (<$0.10) — fee leakage : ${correctButTiny.length} (${pct(correctButTiny.length, trades.length)})      │`);
  console.log(`  │  Big wins (≥$1.00)                : ${correctBigWin.length} (${pct(correctBigWin.length, trades.length)})      │`);
  console.log("  └────────────────────────────────────────────────────────┘");

  // ── 6. Entry Price Distribution ───────────────────────────────────────────

  const priceRanges = [
    { label: "0.00–0.20 (long shots)", min: 0, max: 0.2 },
    { label: "0.20–0.40", min: 0.2, max: 0.4 },
    { label: "0.40–0.60 (near-even)", min: 0.4, max: 0.6 },
    { label: "0.60–0.80", min: 0.6, max: 0.8 },
    { label: "0.80–1.00 (heavy favs)", min: 0.8, max: 1.0 },
  ];

  const priceRows = priceRanges.map(({ label, min, max }) => {
    const ts = trades.filter((t) => t.entryPrice >= min && t.entryPrice < max);
    if (ts.length === 0) return { "Entry Range": label, Count: 0, "Total PnL": "$0.00", "Win Rate": "N/A", "Avg PnL": "$0.00" };
    const pnl = ts.reduce((a, t) => a + t.totalProfit, 0);
    return {
      "Entry Range": label,
      Count: ts.length,
      "Total PnL": fmt(pnl),
      "Win Rate": pct(ts.filter((t) => t.totalProfit > 0).length, ts.length),
      "Avg PnL": fmt(mean(ts.map((t) => t.totalProfit))),
    };
  });

  table(priceRows, "PERFORMANCE BY ENTRY PRICE RANGE");

  // ── 7. Size Analysis ──────────────────────────────────────────────────────

  const sizeRanges = [
    { label: "micro (≤1)", min: 0, max: 1.01 },
    { label: "small (2–5)", min: 1.01, max: 5.01 },
    { label: "medium (6–15)", min: 5.01, max: 15.01 },
    { label: "large (16–30)", min: 15.01, max: 30.01 },
    { label: "XL (>30)", min: 30.01, max: Infinity },
  ];

  const sizeRows = sizeRanges.map(({ label, min, max }) => {
    const ts = trades.filter((t) => t.size > min && t.size <= max);
    if (ts.length === 0) return { "Size Bucket": label, Count: 0, "Total PnL": "$0.00", "Win Rate": "N/A", "Avg PnL": "$0.00" };
    const pnl = ts.reduce((a, t) => a + t.totalProfit, 0);
    return {
      "Size Bucket": label,
      Count: ts.length,
      "Total PnL": fmt(pnl),
      "Win Rate": pct(ts.filter((t) => t.totalProfit > 0).length, ts.length),
      "Avg PnL": fmt(mean(ts.map((t) => t.totalProfit))),
    };
  });

  table(sizeRows, "PERFORMANCE BY POSITION SIZE");

  // ── 8. Sport / League Breakdown ───────────────────────────────────────────

  // Extract sport prefix from slug (e.g. "nba", "atp", "wta", "nhl", "mlb")
  const sportMap = new Map<string, Trade[]>();
  for (const t of trades) {
    const sport = t.slug.split("-")[0].toUpperCase();
    if (!sportMap.has(sport)) sportMap.set(sport, []);
    sportMap.get(sport)!.push(t);
  }

  const sportRows = Array.from(sportMap.entries())
    .map(([sport, ts]) => {
      const pnl = ts.reduce((a, t) => a + t.totalProfit, 0);
      return {
        Sport: sport,
        Count: ts.length,
        "Total PnL": fmt(pnl),
        "Win Rate": pct(ts.filter((t) => t.totalProfit > 0).length, ts.length),
        "Avg PnL": fmt(mean(ts.map((t) => t.totalProfit))),
      };
    })
    .sort((a, b) => b.Count - a.Count);

  table(sportRows, "PERFORMANCE BY SPORT/LEAGUE");

  // ── 9. Top/Bottom Trades ──────────────────────────────────────────────────

  const topTrades = [...trades]
    .sort((a, b) => b.totalProfit - a.totalProfit)
    .slice(0, 5);
  const botTrades = [...trades]
    .sort((a, b) => a.totalProfit - b.totalProfit)
    .slice(0, 5);

  const tradeRow = (t: Trade) => ({
    Slug: t.slug.substring(0, 30),
    Side: t.side,
    Entry: t.entryPrice.toFixed(3),
    Exit: t.exitPrice.toFixed(3),
    Size: t.size,
    "PnL": fmt(t.totalProfit),
    Reason: (t.exitReason ?? "—").substring(0, 20),
  });

  table(topTrades.map(tradeRow), "TOP 5 TRADES");
  table(botTrades.map(tradeRow), "BOTTOM 5 TRADES");

  // ── 10. KEY INSIGHTS ──────────────────────────────────────────────────────

  // Compute net by exit type for the narrative
  const pnlByExit: Record<string, number> = {};
  for (const [key, ts] of exitGroups) {
    pnlByExit[key] = ts.reduce((a, t) => a + t.totalProfit, 0);
  }

  // fee leak estimate: tiny lock_gain exits that went slightly negative
  const feeLeak = trades
    .filter(
      (t) =>
        t.exitReason?.startsWith("lock_gain") &&
        t.totalProfit < 0 &&
        t.totalProfit > -0.2
    )
    .reduce((a, t) => a + t.totalProfit, 0);

  // resolved_or_manual analysis
  const resolved = exitGroups.get("resolved_or_manual") ?? [];
  const resolvedPnL = resolved.reduce((a, t) => a + t.totalProfit, 0);
  const resolvedWinPct =
    resolved.filter((t) => t.totalProfit > 0).length / (resolved.length || 1);

  // underwater exits
  const underwater = exitGroups.get("underwater_persistence") ?? [];
  const underwaterPnL = underwater.reduce((a, t) => a + t.totalProfit, 0);

  // take_profit exits
  const takeProfitTrades = exitGroups.get("take_profit") ?? [];
  const takeProfitPnL = takeProfitTrades.reduce((a, t) => a + t.totalProfit, 0);

  // lock_gain exits
  const lockGainTrades = exitGroups.get("lock_gain") ?? [];
  const lockGainPnL = lockGainTrades.reduce((a, t) => a + t.totalProfit, 0);

  // large position performance
  const largeTrades = trades.filter((t) => t.size > 15);
  const largePnL = largeTrades.reduce((a, t) => a + t.totalProfit, 0);
  const largeWinRate =
    largeTrades.filter((t) => t.totalProfit > 0).length /
    (largeTrades.length || 1);

  // YES vs NO edge
  const yesTrades = trades.filter((t) => t.side === "YES");
  const noTrades = trades.filter((t) => t.side === "NO");
  const yesPnL = yesTrades.reduce((a, t) => a + t.totalProfit, 0);
  const noPnL = noTrades.reduce((a, t) => a + t.totalProfit, 0);

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  KEY INSIGHTS");
  console.log("════════════════════════════════════════════════════════════\n");

  const insights: string[] = [];

  // Net PnL verdict
  if (totalPnL > 0) {
    insights.push(`✓ Net profitable: ${fmt(totalPnL)} over ${trades.length} trades. Expectancy ${fmt(expectancy)}/trade.`);
  } else {
    insights.push(`✗ Net loss: ${fmt(totalPnL)} over ${trades.length} trades. Strategy is underwater.`);
  }

  // Win rate vs expectancy mismatch
  if (winRate < 0.4 && expectancy > 0) {
    insights.push(`△ Low win rate (${fmtPct(winRate)}) offset by large winners — right-tail dependent strategy.`);
  } else if (winRate > 0.6 && expectancy < 0) {
    insights.push(`✗ High win rate (${fmtPct(winRate)}) but negative expectancy — small wins are not covering big losses.`);
  }

  // Exit reason quality
  if (resolvedPnL > 0 && resolvedWinPct > 0.5) {
    insights.push(`✓ resolved_or_manual exits are the best exits: ${fmt(resolvedPnL)} PnL, ${fmtPct(resolvedWinPct)} win rate. These are correct-thesis holds.`);
  } else if (resolvedPnL < 0) {
    insights.push(`✗ resolved_or_manual exits are underwater (${fmt(resolvedPnL)}) — either wrong theses or bad entry timing.`);
  }

  if (lockGainPnL < -1) {
    insights.push(`✗ lock_gain exits are net negative (${fmt(lockGainPnL)}) — fee leakage is real. ~${fmt(Math.abs(feeLeak))} from tiny negative exits that triggered early.`);
  } else if (lockGainPnL > 0) {
    insights.push(`✓ lock_gain exits marginally positive (${fmt(lockGainPnL)}). Fee logic working.`);
  }

  if (takeProfitPnL > 0) {
    insights.push(`✓ take_profit exits generated ${fmt(takeProfitPnL)} — active exits are capturing value.`);
  } else if (takeProfitTrades.length > 0) {
    insights.push(`✗ take_profit exits are net negative (${fmt(takeProfitPnL)}) — premature profit-taking or bad signal reads.`);
  }

  if (underwaterPnL < -0.5) {
    insights.push(`△ underwater_persistence exits cost ${fmt(underwaterPnL)} — expected cost of carrying dead positions.`);
  }

  // YES vs NO
  if (Math.abs(yesPnL - noPnL) > 1) {
    const better = yesPnL > noPnL ? "YES" : "NO";
    const worse = better === "YES" ? "NO" : "YES";
    insights.push(`${yesPnL > noPnL ? "✓" : "△"} ${better} trades outperform: ${fmt(Math.max(yesPnL, noPnL))} vs ${fmt(Math.min(yesPnL, noPnL))} for ${worse}.`);
  }

  // Fee leakage from tiny exits
  const tinyExitCount = trades.filter(
    (t) => Math.abs(t.totalProfit) < 0.06 && t.totalProfit !== 0
  ).length;
  if (tinyExitCount > trades.length * 0.3) {
    insights.push(`✗ ${tinyExitCount} trades (${pct(tinyExitCount, trades.length)}) have |PnL| < $0.06 — transaction fee overhead is significant relative to position sizes.`);
  }

  // Size vs outcome
  if (largeTrades.length > 0) {
    if (largeWinRate > 0.55) {
      insights.push(`✓ Large positions (>15 shares) win ${fmtPct(largeWinRate)} of the time — concentration is working.`);
    } else {
      insights.push(`✗ Large positions (>15 shares) win only ${fmtPct(largeWinRate)} — concentration is not being rewarded.`);
    }
  }

  // Edge signal quality
  if (edgeTrades.length > 0) {
    const corrLabel =
      Math.abs(correlate(edgeTrades.map((t) => t.edgeAtEntry!), edgeTrades.map((t) => t.totalProfit))) < 0.1
        ? "no meaningful correlation"
        : Math.abs(correlate(edgeTrades.map((t) => t.edgeAtEntry!), edgeTrades.map((t) => t.totalProfit))) < 0.3
        ? "weak correlation"
        : "moderate correlation";
    insights.push(`△ edgeAtEntry shows ${corrLabel} with realised PnL (r=${correlate(edgeTrades.map((t) => t.edgeAtEntry!), edgeTrades.map((t) => t.totalProfit)).toFixed(3)}).`);
  } else {
    insights.push(`⚠ Most trades have no edgeAtEntry recorded — edge tracking is not being populated for majority of signals.`);
  }

  for (const i of insights) {
    console.log(`  ${i}`);
  }

  // ── 11. What to Do More Of / Stop Doing ───────────────────────────────────

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  WHAT TO DO MORE OF");
  console.log("════════════════════════════════════════════════════════════\n");

  const doMore: string[] = [];
  const doStop: string[] = [];
  const improvements: string[] = [];

  // resolved_or_manual is the gold standard — hold more
  if (resolvedPnL > 0 && resolvedWinPct > 0.5) {
    doMore.push(`Hold to resolution: resolved_or_manual exits have ${fmtPct(resolvedWinPct)} win rate and ${fmt(resolvedPnL)} total PnL.`);
  }

  // Look at best performing sport
  const bestSport = sportRows.reduce((best, row) =>
    Number(row["Avg PnL"].replace(/[+$]/g, "")) > Number(best["Avg PnL"].replace(/[+$]/g, "")) ? row : best
  );
  if (parseFloat(String(bestSport["Avg PnL"]).replace(/[+$]/g, "")) > 0.1) {
    doMore.push(`Focus on ${bestSport.Sport}: highest avg PnL per trade (${bestSport["Avg PnL"]}), ${bestSport["Win Rate"]} win rate.`);
  }

  if (takeProfitPnL > 0 && takeProfitTrades.length > 0) {
    doMore.push(`Active take_profit exits: generating ${fmt(takeProfitPnL)} — this logic is working.`);
  }

  if (largeTrades.length > 0 && largeWinRate > 0.55) {
    doMore.push(`Concentrate in high-conviction positions: large trades (>15 shares) win at ${fmtPct(largeWinRate)}.`);
  }

  // Best price range
  const bestRange = priceRows.reduce((best, row) => {
    if (row.Count === 0) return best;
    const a = parseFloat(String(row["Avg PnL"]).replace(/[$+]/g, ""));
    const b = parseFloat(String(best["Avg PnL"]).replace(/[$+]/g, ""));
    return a > b ? row : best;
  });
  if (parseFloat(String(bestRange["Avg PnL"]).replace(/[$+]/g, "")) > 0.1) {
    doMore.push(`Target entry price range ${bestRange["Entry Range"]}: ${bestRange["Avg PnL"]} avg PnL, ${bestRange["Win Rate"]} win rate.`);
  }

  for (const d of doMore.length ? doMore : ["— insufficient data for clear recommendation"]) {
    console.log(`  + ${d}`);
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  WHAT TO STOP DOING");
  console.log("════════════════════════════════════════════════════════════\n");

  if (lockGainPnL < -0.5) {
    doStop.push(`Early lock_gain exits on sub-5-cent positions — they net negative due to fees (${fmt(lockGainPnL)}).`);
  }

  if (tinyExitCount > trades.length * 0.25) {
    doStop.push(`Trading minimum-size positions ($0.05–$0.10 exposure) — fee overhead eliminates edge. Set a floor of $0.50 min exposure.`);
  }

  const worstSport = sportRows.reduce((worst, row) =>
    Number(String(row["Total PnL"]).replace(/[+$]/g, "")) < Number(String(worst["Total PnL"]).replace(/[+$]/g, "")) ? row : worst
  );
  if (parseFloat(String(worstSport["Total PnL"]).replace(/[+$]/g, "")) < -1) {
    doStop.push(`Heavy allocation to ${worstSport.Sport}: ${worstSport["Total PnL"]} total loss, ${worstSport["Win Rate"]} win rate.`);
  }

  const worstRange = priceRows.reduce((worst, row) => {
    if (row.Count === 0) return worst;
    const a = parseFloat(String(row["Total PnL"]).replace(/[$+]/g, ""));
    const b = parseFloat(String(worst["Total PnL"]).replace(/[$+]/g, ""));
    return a < b ? row : worst;
  });
  if (parseFloat(String(worstRange["Total PnL"]).replace(/[$+]/g, "")) < -1) {
    doStop.push(`Entries in range ${worstRange["Entry Range"]}: ${worstRange["Total PnL"]} total PnL (${worstRange["Win Rate"]} win rate).`);
  }

  for (const d of doStop.length ? doStop : ["— no strong negative patterns detected"]) {
    console.log(`  - ${d}`);
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  OPTIONAL STRATEGY IMPROVEMENTS");
  console.log("════════════════════════════════════════════════════════════\n");

  improvements.push("edgeAtEntry coverage: Only a fraction of trades record edge. Populate this for all signals — without it, Kelly sizing is blind and backtesting is impossible.");
  improvements.push("Minimum notional floor: Many positions are 1–5 shares at low prices ($0.05–$0.35 exposure). These can't cover bid-ask spread + fees. Floor at $1 notional.");
  improvements.push("Duplicate record cleanup: " + dupeCount + " duplicate entries found (same trade logged with/without exitReason). Fix at write time, not analysis time.");
  improvements.push("Holding time analysis: All trades share the same date — introduce session-relative timestamps or log entryTs separately from exitTs to compute hold duration.");

  if (edgeTrades.length > 0 && Math.abs(correlate(edgeTrades.map(t => t.edgeAtEntry!), edgeTrades.map(t => t.totalProfit))) < 0.2) {
    improvements.push("Edge signal calibration: Low edge↔profit correlation suggests the bookmaker-implied edge isn't predictive of actual price movement. Consider using market depth / liquidity as an additional filter.");
  }

  if (noTrades.length > yesTrades.length * 1.5 || yesTrades.length > noTrades.length * 1.5) {
    improvements.push(`Side bias: ${yesTrades.length} YES vs ${noTrades.length} NO trades — heavy skew detected. Verify this is intentional, not a signal matching artefact.`);
  }

  for (const imp of improvements) {
    console.log(`  ◆ ${imp}`);
  }

  console.log("\n════════════════════════════════════════════════════════════\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath =
    process.argv[2] ??
    path.join(path.dirname(__dirname), "data", "trades.jsonl");

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = await loadTrades(filePath);
  analyze(raw);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
