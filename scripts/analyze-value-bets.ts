// scripts/analyze-value-bets.ts
// Compares odds-api.io value-bet signals against our own edge detection.
//
// Reads data/trades.jsonl and answers:
//   1. Signal source breakdown — how many trades came from each source?
//   2. Agreement rate — when odds-api.io flagged value, did we agree?
//   3. Rejection reasons — why did we reject odds-api.io signals?
//   4. Lead/lag — did odds-api.io flag markets before or after our WS pipeline?
//   5. Outcome comparison — do value_bet_confirmed signals perform better/worse?
//      (requires entries.jsonl for PnL join, optional)
//
// Usage:
//   npx tsx scripts/analyze-value-bets.ts
//   npx tsx scripts/analyze-value-bets.ts --after 2026-04-01
//   npx tsx scripts/analyze-value-bets.ts --before 2026-04-10
//   npx tsx scripts/analyze-value-bets.ts --slug nba-bos-mia-2026-04-05

import * as fs from "fs";
import * as path from "path";

// ── Types ────────────────────────────────────────────────────────────

interface LogEntry {
  ts: string;
  level: string;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

// SIGNAL BUY entry from coordinator
interface SignalEntry {
  ts: string;
  slug: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  edge: number;
  reason: "edge_detected" | "value_bet_confirmed" | "exit_signal";
  dryRun: boolean;
}

// VALUE_BET_REJECTED entry from coordinator
interface RejectionEntry {
  ts: string;
  slug: string;
  tokenId: string;
  sharpProb: number;
  polyPrice: number;
  grossEdge: number;
  netEdge: number;
  skipReason: string;
}

// From entries.jsonl — confirmed fills with PnL data
interface FillEntry {
  ts: string;
  slug: string;
  price: number;
  sharpProb: number;
  edgePct: number;
  usdcRisk: number;
  dryRun: boolean;
}

// ── CLI Args ─────────────────────────────────────────────────────────

function parseArgs(): { after?: Date; before?: Date; slug?: string } {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    opts[key] = args[i + 1];
  }
  return {
    after: opts.after ? new Date(opts.after) : undefined,
    before: opts.before ? new Date(opts.before) : undefined,
    slug: opts.slug,
  };
}

// ── Loaders ──────────────────────────────────────────────────────────

function loadTradesLog(): LogEntry[] {
  const file = path.resolve(import.meta.dirname, "../data/trades.jsonl");
  if (!fs.existsSync(file)) {
    console.error("data/trades.jsonl not found");
    process.exit(1);
  }
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry);
}

function loadFillEntries(): FillEntry[] {
  const file = path.resolve(import.meta.dirname, "../data/entries.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FillEntry);
}

// ── Parsing ──────────────────────────────────────────────────────────

function parseSignals(entries: LogEntry[]): SignalEntry[] {
  return entries
    .filter((e) => e.msg === "SIGNAL BUY" && e.data)
    .map((e) => ({
      ts: e.ts,
      slug: e.data!.slug as string,
      tokenId: e.data!.tokenId as string,
      side: e.data!.side as "BUY" | "SELL",
      price: e.data!.price as number,
      size: e.data!.size as number,
      edge: e.data!.edge as number,
      reason: (e.data!.reason ?? "edge_detected") as SignalEntry["reason"],
      dryRun: e.data!.dryRun as boolean,
    }));
}

function parseRejections(entries: LogEntry[]): RejectionEntry[] {
  return entries
    .filter((e) => e.msg === "VALUE_BET_REJECTED" && e.data)
    .map((e) => ({
      ts: e.ts,
      slug: e.data!.slug as string,
      tokenId: e.data!.tokenId as string,
      sharpProb: e.data!.sharpProb as number,
      polyPrice: e.data!.polyPrice as number,
      grossEdge: e.data!.grossEdge as number,
      netEdge: e.data!.netEdge as number,
      skipReason: e.data!.skipReason as string,
    }));
}

// ── Helpers ──────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return "N/A";
  return ((n / d) * 100).toFixed(1) + "%";
}

function usd(n: number): string {
  return (n >= 0 ? "+" : "") + "$" + n.toFixed(2);
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}
function rpad(s: string, n: number): string {
  return s.padStart(n);
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// How many minutes between two ISO timestamps (b - a)
function minutesBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}

// ── Analysis ─────────────────────────────────────────────────────────

function analyze(
  signals: SignalEntry[],
  rejections: RejectionEntry[],
  fills: FillEntry[],
): void {
  const edgeDetected = signals.filter((s) => s.reason === "edge_detected");
  const valueBetConfirmed = signals.filter((s) => s.reason === "value_bet_confirmed");
  const totalSignals = edgeDetected.length + valueBetConfirmed.length;
  const totalVbTouched = valueBetConfirmed.length + rejections.length;

  // ── 1. Signal Source Summary ─────────────────────────────────────
  console.log("=== Signal Source Breakdown ===");
  console.log(`  Total signals fired:         ${totalSignals}`);
  console.log(`  edge_detected:               ${edgeDetected.length}  (${pct(edgeDetected.length, totalSignals)})`);
  console.log(`  value_bet_confirmed:          ${valueBetConfirmed.length}  (${pct(valueBetConfirmed.length, totalSignals)})`);
  console.log();

  // ── 2. Value-Bet Agreement Rate ───────────────────────────────────
  console.log("=== odds-api.io Agreement Rate ===");
  console.log(`  Times odds-api.io flagged a known market:  ${totalVbTouched}`);
  console.log(`    Our calc agreed (signal fired):          ${valueBetConfirmed.length}  (${pct(valueBetConfirmed.length, totalVbTouched)})`);
  console.log(`    Our calc rejected:                       ${rejections.length}  (${pct(rejections.length, totalVbTouched)})`);
  console.log();

  // ── 3. Rejection Reasons ─────────────────────────────────────────
  if (rejections.length > 0) {
    const byReason = new Map<string, RejectionEntry[]>();
    for (const r of rejections) {
      // Normalise verbose skipReasons like "edge_too_small (0.61% < 2%)" → "edge_too_small"
      const key = r.skipReason.split(" ")[0];
      const arr = byReason.get(key) ?? [];
      arr.push(r);
      byReason.set(key, arr);
    }

    console.log("=== Rejection Reasons (when odds-api.io said value, we said no) ===");
    console.log(
      pad("Reason", 22),
      rpad("Count", 7),
      rpad("Share", 7),
      rpad("AvgGrossEdge", 14),
      rpad("AvgNetEdge", 12),
    );

    const sorted = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [reason, group] of sorted) {
      const avgGross = avg(group.map((r) => r.grossEdge)) * 100;
      const avgNet = avg(group.map((r) => r.netEdge)) * 100;
      console.log(
        pad(reason, 22),
        rpad(String(group.length), 7),
        rpad(pct(group.length, rejections.length), 7),
        rpad(avgGross.toFixed(2) + "%", 14),
        rpad(avgNet.toFixed(2) + "%", 12),
      );
    }
    console.log();

    // Deeper look: rejections where gross edge was actually positive but net didn't clear MIN_EDGE
    const nearMiss = rejections.filter(
      (r) => r.grossEdge > 0 && r.skipReason.startsWith("edge_too_small"),
    );
    if (nearMiss.length > 0) {
      console.log(`=== Near-Misses (odds-api.io flagged, gross edge > 0 but net < MIN_EDGE) ===`);
      console.log(`  Count: ${nearMiss.length}`);
      console.log(`  Avg gross edge: ${(avg(nearMiss.map((r) => r.grossEdge)) * 100).toFixed(2)}%`);
      console.log(`  Avg net edge:   ${(avg(nearMiss.map((r) => r.netEdge)) * 100).toFixed(2)}%`);
      console.log(`  These are markets where odds-api.io's EV calc is more permissive than ours.`);
      console.log();
    }
  }

  // ── 4. Lead / Lag Analysis ────────────────────────────────────────
  // For each value_bet_confirmed signal, check if our WS pipeline had already
  // fired edge_detected for the same slug within the last 10 minutes.
  // If yes → odds-api.io is lagging. If no → odds-api.io may be leading.
  if (valueBetConfirmed.length > 0) {
    // Build index: slug → sorted list of edge_detected timestamps
    const edgeTsBySlug = new Map<string, string[]>();
    for (const s of edgeDetected) {
      const arr = edgeTsBySlug.get(s.slug) ?? [];
      arr.push(s.ts);
      edgeTsBySlug.set(s.slug, arr);
    }

    let vbLedCount = 0;   // odds-api.io flagged first (no prior edge_detected in window)
    let vbLagCount = 0;   // our WS already fired before odds-api.io
    const lagMinutes: number[] = [];
    const leadMinutes: number[] = [];

    for (const vb of valueBetConfirmed) {
      const priorEdge = (edgeTsBySlug.get(vb.slug) ?? [])
        .filter((t) => t < vb.ts); // edge_detected before this value_bet_confirmed

      if (priorEdge.length === 0) {
        vbLedCount++;
        // Check if our WS fires AFTER — indicates odds-api.io discovered it first
        const laterEdge = (edgeTsBySlug.get(vb.slug) ?? [])
          .filter((t) => t > vb.ts);
        if (laterEdge.length > 0) {
          leadMinutes.push(minutesBetween(vb.ts, laterEdge[0]));
        }
      } else {
        vbLagCount++;
        // Most recent prior edge_detected — how stale is odds-api.io?
        const mostRecent = priorEdge[priorEdge.length - 1];
        lagMinutes.push(minutesBetween(mostRecent, vb.ts));
      }
    }

    console.log("=== Lead / Lag vs Our WS Pipeline ===");
    console.log(`  value_bet_confirmed signals:       ${valueBetConfirmed.length}`);
    console.log(`  odds-api.io led us (new signal):   ${vbLedCount}  (${pct(vbLedCount, valueBetConfirmed.length)})`);
    console.log(`  odds-api.io lagged us (duplicate): ${vbLagCount}  (${pct(vbLagCount, valueBetConfirmed.length)})`);
    if (lagMinutes.length > 0) {
      console.log(`  Avg lag (how stale odds-api.io was): ${avg(lagMinutes).toFixed(1)} min`);
    }
    if (leadMinutes.length > 0) {
      console.log(`  Avg lead (how early odds-api.io was): ${avg(leadMinutes).toFixed(1)} min ahead of our WS`);
    }
    console.log();
  }

  // ── 5. Outcome Comparison (requires entries.jsonl) ────────────────
  if (fills.length > 0) {
    // Build PnL lookup by slug
    // entries.jsonl has edgePct and usdcRisk but no outcome — we approximate:
    // a fill "won" if the betOn side resolved 1.0 (not directly available here).
    // Instead, just compare avg edge and capital deployed between sources.

    // Join fills to signals by slug
    const fillBySlug = new Map<string, FillEntry>();
    for (const f of fills) fillBySlug.set(f.slug, f);

    const vbFills = valueBetConfirmed
      .map((s) => fillBySlug.get(s.slug))
      .filter((f): f is FillEntry => f !== undefined);

    const edgeFills = edgeDetected
      .map((s) => fillBySlug.get(s.slug))
      .filter((f): f is FillEntry => f !== undefined);

    if (vbFills.length > 0 || edgeFills.length > 0) {
      console.log("=== Fill Comparison (signals that became confirmed fills) ===");
      console.log(
        pad("Source", 22),
        rpad("Signals", 9),
        rpad("Fills", 7),
        rpad("FillRate", 10),
        rpad("AvgEdge%", 10),
        rpad("AvgRisk$", 10),
      );

      const rows = [
        { label: "edge_detected", signals: edgeDetected, fills: edgeFills },
        { label: "value_bet_confirmed", signals: valueBetConfirmed, fills: vbFills },
      ];

      for (const row of rows) {
        const fillRate = pct(row.fills.length, row.signals.length);
        const avgEdge = avg(row.fills.map((f) => f.edgePct));
        const avgRisk = avg(row.fills.map((f) => f.usdcRisk));
        console.log(
          pad(row.label, 22),
          rpad(String(row.signals.length), 9),
          rpad(String(row.fills.length), 7),
          rpad(fillRate, 10),
          rpad(avgEdge.toFixed(2) + "%", 10),
          rpad("$" + avgRisk.toFixed(2), 10),
        );
      }
      console.log();
      if (vbFills.length === 0 && valueBetConfirmed.length > 0) {
        console.log("  (No value_bet_confirmed fills matched in entries.jsonl yet)");
        console.log();
      }
    }
  } else {
    console.log("  (No entries.jsonl found — skipping fill comparison)");
    console.log();
  }

  // ── 6. Per-slug detail for value_bet_confirmed ────────────────────
  if (valueBetConfirmed.length > 0) {
    console.log("=== value_bet_confirmed Signals (detail) ===");
    const sorted = [...valueBetConfirmed].sort((a, b) => b.edge - a.edge);
    console.log(
      pad("Slug", 40),
      rpad("Edge%", 7),
      rpad("Price", 7),
      rpad("Size", 6),
      rpad("DryRun", 8),
      "Timestamp",
    );
    for (const s of sorted.slice(0, 20)) {
      console.log(
        pad(s.slug, 40),
        rpad((s.edge * 100).toFixed(1) + "%", 7),
        rpad(s.price.toFixed(3), 7),
        rpad(String(s.size), 6),
        rpad(String(s.dryRun), 8),
        s.ts,
      );
    }
    if (sorted.length > 20) console.log(`  ... and ${sorted.length - 20} more`);
    console.log();
  }

  // ── 7. Rejections detail (top slugs) ─────────────────────────────
  if (rejections.length > 0) {
    // Group by slug, pick highest-gross-edge rejection per slug
    const bySlug = new Map<string, RejectionEntry[]>();
    for (const r of rejections) {
      const arr = bySlug.get(r.slug) ?? [];
      arr.push(r);
      bySlug.set(r.slug, arr);
    }

    const topRejected = [...bySlug.entries()]
      .map(([slug, group]) => ({
        slug,
        count: group.length,
        maxGross: Math.max(...group.map((r) => r.grossEdge)),
        avgNet: avg(group.map((r) => r.netEdge)),
        reasons: [...new Set(group.map((r) => r.skipReason.split(" ")[0]))].join(", "),
      }))
      .sort((a, b) => b.maxGross - a.maxGross)
      .slice(0, 15);

    console.log("=== Top Rejected Markets (odds-api.io saw value, we skipped) ===");
    console.log(
      pad("Slug", 40),
      rpad("Checks", 8),
      rpad("MaxGross%", 11),
      rpad("AvgNet%", 9),
      "Reasons",
    );
    for (const r of topRejected) {
      console.log(
        pad(r.slug, 40),
        rpad(String(r.count), 8),
        rpad((r.maxGross * 100).toFixed(2) + "%", 11),
        rpad((r.avgNet * 100).toFixed(2) + "%", 9),
        r.reasons,
      );
    }
    console.log();
  }
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  const raw = loadTradesLog();
  const fills = loadFillEntries();

  let signals = parseSignals(raw);
  let rejections = parseRejections(raw);

  // Apply filters
  if (opts.after) {
    const after = opts.after;
    signals = signals.filter((s) => new Date(s.ts) >= after);
    rejections = rejections.filter((r) => new Date(r.ts) >= after);
  }
  if (opts.before) {
    const before = opts.before;
    signals = signals.filter((s) => new Date(s.ts) < before);
    rejections = rejections.filter((r) => new Date(r.ts) < before);
  }
  if (opts.slug) {
    signals = signals.filter((s) => s.slug.includes(opts.slug!));
    rejections = rejections.filter((r) => r.slug.includes(opts.slug!));
  }

  const filterDesc = [
    opts.after && `after ${opts.after.toISOString().slice(0, 10)}`,
    opts.before && `before ${opts.before.toISOString().slice(0, 10)}`,
    opts.slug && `slug~=${opts.slug}`,
  ]
    .filter(Boolean)
    .join(", ");

  console.log("=== Value-Bet Source Analysis ===");
  if (filterDesc) console.log(`Filters: ${filterDesc}`);
  console.log(
    `Loaded ${signals.length} signals, ${rejections.length} value-bet rejections from trades.jsonl`,
  );
  console.log();

  if (signals.length === 0 && rejections.length === 0) {
    console.log("No matching entries. Has the bot been running with the value-bet poller?");
    return;
  }

  analyze(signals, rejections, fills);
}

main();
