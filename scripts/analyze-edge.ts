import * as fs from "fs";
import * as path from "path";

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

const file = path.resolve(import.meta.dirname, "../data/entries.jsonl");
const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
const entries: Entry[] = lines.map((l) => JSON.parse(l));

console.log(`Total entries: ${entries.length}\n`);

// --- Basic stats ---
const edges = entries.map((e) => e.edgePct);
edges.sort((a, b) => a - b);

console.log("=== Edge Distribution ===");
console.log(`Min:    ${edges[0].toFixed(2)}%`);
console.log(`Max:    ${edges[edges.length - 1].toFixed(2)}%`);
console.log(`Mean:   ${(edges.reduce((s, e) => s + e, 0) / edges.length).toFixed(2)}%`);
console.log(`Median: ${edges[Math.floor(edges.length / 2)].toFixed(2)}%`);
console.log(`P25:    ${edges[Math.floor(edges.length * 0.25)].toFixed(2)}%`);
console.log(`P75:    ${edges[Math.floor(edges.length * 0.75)].toFixed(2)}%`);
console.log();

// --- Bucket by edge range ---
const buckets = [
  { label: "0-5%", min: 0, max: 5 },
  { label: "5-10%", min: 5, max: 10 },
  { label: "10-15%", min: 10, max: 15 },
  { label: "15-20%", min: 15, max: 20 },
  { label: "20-30%", min: 20, max: 30 },
  { label: "30-50%", min: 30, max: 50 },
  { label: "50%+", min: 50, max: Infinity },
];

console.log("=== Entries by Edge Bucket ===");
console.log(
  "Bucket".padEnd(10),
  "Count".padStart(7),
  "AvgEdge".padStart(9),
  "AvgPrice".padStart(10),
  "AvgSharp".padStart(10),
  "AvgKelly".padStart(10),
  "TotalRisk".padStart(11),
  "AvgShares".padStart(11)
);

for (const b of buckets) {
  const group = entries.filter((e) => e.edgePct >= b.min && e.edgePct < b.max);
  if (group.length === 0) continue;

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  console.log(
    b.label.padEnd(10),
    String(group.length).padStart(7),
    avg(group.map((e) => e.edgePct)).toFixed(2).padStart(9),
    avg(group.map((e) => e.price)).toFixed(4).padStart(10),
    avg(group.map((e) => e.sharpProb)).toFixed(4).padStart(10),
    avg(group.map((e) => e.kellyFraction)).toFixed(4).padStart(10),
    group.map((e) => e.usdcRisk).reduce((s, v) => s + v, 0).toFixed(2).padStart(11),
    avg(group.map((e) => e.shares)).toFixed(0).padStart(11)
  );
}
console.log();

// --- By market type ---
const byType = new Map<string, Entry[]>();
for (const e of entries) {
  const arr = byType.get(e.marketType) || [];
  arr.push(e);
  byType.set(e.marketType, arr);
}

console.log("=== By Market Type ===");
console.log(
  "Type".padEnd(12),
  "Count".padStart(7),
  "AvgEdge".padStart(9),
  "AvgPrice".padStart(10),
  "TotalRisk".padStart(11)
);

for (const [type, group] of byType) {
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  console.log(
    type.padEnd(12),
    String(group.length).padStart(7),
    avg(group.map((e) => e.edgePct)).toFixed(2).padStart(9),
    avg(group.map((e) => e.price)).toFixed(4).padStart(10),
    group.map((e) => e.usdcRisk).reduce((s, v) => s + v, 0).toFixed(2).padStart(11)
  );
}
console.log();

// --- Suspicious patterns: very high edge likely means bad match ---
const suspicious = entries.filter((e) => e.edgePct > 50);
if (suspicious.length > 0) {
  console.log(`=== Suspicious (edge > 50%) — likely bad matches ===`);
  console.log(`Count: ${suspicious.length}`);
  for (const e of suspicious.slice(0, 10)) {
    console.log(
      `  ${e.edgePct.toFixed(1)}% edge | price=${e.price} sharp=${e.sharpProb.toFixed(3)} | ${e.betOn} (${e.marketType}) | ${e.slug}`
    );
  }
  if (suspicious.length > 10) console.log(`  ... and ${suspicious.length - 10} more`);
  console.log();
}

// --- Very low price trades (likely mispriced token, not real edge) ---
const lowPrice = entries.filter((e) => e.price < 0.05);
if (lowPrice.length > 0) {
  console.log(`=== Low Price Trades (price < 0.05) — likely noise ===`);
  console.log(`Count: ${lowPrice.length}`);
  for (const e of lowPrice.slice(0, 10)) {
    console.log(
      `  price=${e.price} edge=${e.edgePct.toFixed(1)}% | ${e.betOn} (${e.marketType}) | ${e.slug}`
    );
  }
  if (lowPrice.length > 10) console.log(`  ... and ${lowPrice.length - 10} more`);
  console.log();
}

// --- Recommendation ---
console.log("=== Recommendation ===");
const cleanEntries = entries.filter((e) => e.price >= 0.05 && e.edgePct <= 50);
const cleanEdges = cleanEntries.map((e) => e.edgePct).sort((a, b) => a - b);

if (cleanEdges.length > 0) {
  console.log(`Clean entries (0.05 <= price, edge <= 50%): ${cleanEntries.length}`);
  console.log(`Clean edge range: ${cleanEdges[0].toFixed(2)}% - ${cleanEdges[cleanEdges.length - 1].toFixed(2)}%`);
  console.log(`Clean median edge: ${cleanEdges[Math.floor(cleanEdges.length / 2)].toFixed(2)}%`);
  console.log(`Clean P25 edge: ${cleanEdges[Math.floor(cleanEdges.length * 0.25)].toFixed(2)}%`);
  console.log();

  // Cumulative analysis: if we set MIN_EDGE to X, how many trades do we keep?
  console.log("=== Cumulative: If MIN_EDGE were set to X ===");
  console.log("MinEdge".padEnd(10), "Trades".padStart(8), "% of Total".padStart(12), "AvgEdge".padStart(9), "TotalRisk".padStart(11));
  for (const threshold of [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20]) {
    const kept = cleanEntries.filter((e) => e.edgePct >= threshold);
    if (kept.length === 0) continue;
    const avg = kept.map((e) => e.edgePct).reduce((s, v) => s + v, 0) / kept.length;
    const totalRisk = kept.map((e) => e.usdcRisk).reduce((s, v) => s + v, 0);
    const pct = ((kept.length / cleanEntries.length) * 100).toFixed(1);
    console.log(
      `${threshold}%`.padEnd(10),
      String(kept.length).padStart(8),
      `${pct}%`.padStart(12),
      avg.toFixed(2).padStart(9),
      totalRisk.toFixed(2).padStart(11)
    );
  }
}
