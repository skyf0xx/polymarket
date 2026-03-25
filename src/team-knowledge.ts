// src/team-knowledge.ts
// Team abbreviation lookups and h2h outcomeMap cache persisted to disk.
// Abbreviations are merged from the Gamma Teams API on each hydration,
// accumulating across restarts so deterministic matching works immediately.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { join } from "path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { MatchEntry, PolymarketMarket, MarketType } from "./types.js";

const log = createLogger("team-knowledge");
const KNOWLEDGE_FILE = join(config.dataDir, "team-knowledge.json");

// Cached h2h outcome mappings: league → "away_abbr:home_abbr" → { Yes: team, No: team }
interface H2hCache {
  [league: string]: {
    [matchupKey: string]: { Yes: string; No: string };
  };
}

// On-disk shape: both abbreviations and h2h cache persisted together
interface KnowledgeFile {
  abbreviations: Record<string, Record<string, string>>;
  h2hCache: H2hCache;
}

export interface ParsedSlug {
  sport: string;
  team1: string; // first team abbreviation in slug (typically away)
  team2: string; // second team abbreviation in slug (typically home)
  date: string; // YYYY-MM-DD
  marketType: MarketType;
  side?: "away" | "home"; // for spreads
  point?: number;
}

interface GammaTeam {
  name: string; // e.g. "Rockets", "Thunder"
  league: string; // e.g. "nba", "epl"
  abbreviation: string; // e.g. "hou", "okc"
}

export class TeamKnowledge {
  // league → { abbreviation → team name } — populated from Gamma Teams API
  private abbreviations: Record<string, Record<string, string>> = {};
  // league → { "away_abbr:home_abbr" → outcomeMap } — learned from LLM, persisted to disk
  private h2hCache: H2hCache = {};

  constructor() {
    this.loadFromDisk();
  }

  /**
   * Fetch team abbreviations from the Gamma Teams API for the given leagues.
   * Call once at startup before running match cycles.
   */
  async hydrate(leagues: string[]): Promise<void> {
    if (leagues.length === 0) {
      log.warn("No leagues provided for team hydration");
      return;
    }

    const params = leagues.map((l) => `league=${encodeURIComponent(l)}`).join("&");
    const url = `${config.gammaApiUrl}/teams?${params}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.error(`Gamma Teams API error: ${res.status}`);
        return;
      }

      const teams: GammaTeam[] = await res.json();
      if (teams.length === 0) {
        log.warn("Gamma Teams API returned empty response — keeping existing abbreviations");
        return;
      }

      // Merge into existing abbreviations (preserves teams from prior sessions
      // whose leagues may not be in this hydration batch)
      for (const team of teams) {
        const league = team.league.toLowerCase();
        const abbr = team.abbreviation.toLowerCase();
        if (!this.abbreviations[league]) this.abbreviations[league] = {};
        this.abbreviations[league][abbr] = team.name;
      }

      this.saveToDisk();
      const s = this.stats;
      log.info(
        `Team knowledge hydrated: ${s.abbreviations} abbreviations across ${s.leagues.length} leagues`,
      );
    } catch (err: unknown) {
      log.error(
        `Failed to hydrate team knowledge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Cache an h2h outcomeMap from a successful LLM match.
   */
  learn(entry: MatchEntry): void {
    if (entry.marketType !== "h2h") return;

    const parsed = parseSlug(entry.slug);
    const league = entry.leagueSlug || entry.sportKey;
    if (!parsed || !league) return;

    const matchupKey = `${parsed.team1.toLowerCase()}:${parsed.team2.toLowerCase()}`;
    if (!this.h2hCache[league]) this.h2hCache[league] = {};

    const existing = this.h2hCache[league][matchupKey];
    if (existing?.Yes === entry.outcomeMap.Yes && existing?.No === entry.outcomeMap.No) return;

    this.h2hCache[league][matchupKey] = { Yes: entry.outcomeMap.Yes, No: entry.outcomeMap.No };
    this.saveToDisk();
    log.info(`Learned h2h outcomeMap: ${league}/${matchupKey} → Yes=${entry.outcomeMap.Yes}`);
  }

  /**
   * Attempt deterministic matching for a single market.
   * Returns a partial MatchEntry (commence=0 and active=false, caller must fill)
   * or null if deterministic matching is not possible.
   *
   * For totals/spreads: outcomeMap is derived from the slug.
   * For h2h: outcomeMap is looked up from the disk cache (learned from prior LLM matches).
   */
  tryMatch(
    pm: PolymarketMarket,
    oddsEvents: Array<{
      id: string;
      sport: string;
      league: string;
      home: string;
      away: string;
      time: string;
    }>,
    now: number,
  ): Omit<MatchEntry, "commence" | "active"> | null {
    const parsed = parseSlug(pm.slug);
    if (!parsed) return null;

    if (parsed.marketType === "spreads" && !parsed.side) return null;

    // Search all league-level buckets that match the slug's generic sport.
    const leagueKeys = Object.keys(this.abbreviations).filter((key) => {
      return key === parsed.sport || oddsEvents.some(
        (e) => e.league === key && e.sport === parsed.sport,
      );
    });

    for (const league of leagueKeys) {
      const sportAbbrs = this.abbreviations[league] ?? {};
      const awayFull = sportAbbrs[parsed.team1.toLowerCase()];
      const homeFull = sportAbbrs[parsed.team2.toLowerCase()];
      if (!awayFull || !homeFull) continue;

      // Find the matching odds event (±36h window)
      const slugDateMs = new Date(parsed.date).getTime();
      const event = oddsEvents.find((e) => {
        const eMs = new Date(e.time).getTime();
        return (
          Math.abs(eMs - slugDateMs) < 36 * 60 * 60 * 1_000 &&
          looseNameMatch(e.home, homeFull) &&
          looseNameMatch(e.away, awayFull)
        );
      });
      if (!event) continue;

      // For h2h: need cached outcomeMap from a prior LLM match
      let outcomeMap: { Yes: string; No: string };
      if (parsed.marketType === "h2h") {
        const matchupKey = `${parsed.team1.toLowerCase()}:${parsed.team2.toLowerCase()}`;
        const cached = this.h2hCache[league]?.[matchupKey];
        if (!cached) continue; // no cached h2h data — needs LLM
        outcomeMap = cached;
      } else {
        outcomeMap = buildOutcomeMap(parsed, awayFull, homeFull);
      }

      const outcomes = pm.outcomes ?? [];
      const { yesIdx, noIdx } = resolveIndices(outcomes, outcomeMap);
      if (yesIdx === -1 || noIdx === -1) continue;

      return {
        slug: pm.slug,
        oddsApiEventId: event.id,
        sportKey: event.sport,
        leagueSlug: event.league,
        homeTeam: homeFull,
        awayTeam: awayFull,
        outcomeMap,
        marketType: parsed.marketType,
        point: parsed.point,
        confidence: "high",
        matchedAt: now,
        tokenIds: {
          yes: pm.tokenIds?.[yesIdx] ?? "",
          no: pm.tokenIds?.[noIdx] ?? "",
        },
      };
    }

    return null;
  }

  get stats(): { abbreviations: number; h2hCached: number; leagues: string[] } {
    let abbreviations = 0;
    let h2hCached = 0;
    for (const league of Object.keys(this.abbreviations)) {
      abbreviations += Object.keys(this.abbreviations[league]).length;
    }
    for (const league of Object.keys(this.h2hCache)) {
      h2hCached += Object.keys(this.h2hCache[league]).length;
    }
    return {
      abbreviations,
      h2hCached,
      leagues: Object.keys(this.abbreviations),
    };
  }

  // ── Disk persistence (abbreviations + h2h cache) ────────────────

  private loadFromDisk(): void {
    if (!existsSync(KNOWLEDGE_FILE)) return;
    try {
      const raw: KnowledgeFile = JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8"));
      this.abbreviations = raw.abbreviations;
      this.h2hCache = raw.h2hCache;

      let h2hCount = 0;
      for (const league of Object.keys(this.h2hCache)) {
        h2hCount += Object.keys(this.h2hCache[league]).length;
      }
      let abbrCount = 0;
      for (const league of Object.keys(this.abbreviations)) {
        abbrCount += Object.keys(this.abbreviations[league]).length;
      }
      log.info(`Loaded from disk: ${abbrCount} abbreviations, ${h2hCount} h2h outcomeMap(s)`);
    } catch (err: unknown) {
      log.warn(
        `Could not load knowledge file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private saveToDisk(): void {
    if (!existsSync(config.dataDir))
      mkdirSync(config.dataDir, { recursive: true });
    const tmp = KNOWLEDGE_FILE + ".tmp";
    const data: KnowledgeFile = {
      abbreviations: this.abbreviations,
      h2hCache: this.h2hCache,
    };
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, KNOWLEDGE_FILE);
  }
}

// ── Exported helpers ───────────────────────────────────────────────

/**
 * Parse a Polymarket sports slug into structured fields.
 * Expected format: {sport}-{team1}-{team2}-{YYYY}-{MM}-{DD}-{type}[-{side}][-{point}]
 */
export function parseSlug(slug: string): ParsedSlug | null {
  const parts = slug.split("-");
  if (parts.length < 7) return null;

  const sport = parts[0];

  // Locate the year segment (4-digit number ≥ 2020)
  let yearIdx = -1;
  for (let i = 1; i < parts.length; i++) {
    if (/^\d{4}$/.test(parts[i]) && parseInt(parts[i]) >= 2020) {
      yearIdx = i;
      break;
    }
  }
  // Need at least sport + 2 team tokens before the year
  if (yearIdx < 3) return null;

  const teamParts = parts.slice(1, yearIdx);
  if (teamParts.length < 2) return null;

  const team1 = teamParts[0];
  const team2 = teamParts[1];
  const date = `${parts[yearIdx]}-${parts[yearIdx + 1]}-${parts[yearIdx + 2]}`;

  const afterDate = parts.slice(yearIdx + 3);
  if (afterDate.length === 0) return null;

  const typePart = afterDate[0];
  let marketType: MarketType;
  if (typePart === "spread" || typePart === "spreads") marketType = "spreads";
  else if (typePart === "moneyline" || typePart === "h2h" || typePart === "ml")
    marketType = "h2h";
  else if (typePart === "totals" || typePart === "total") marketType = "totals";
  else return null;

  let side: "away" | "home" | undefined;
  let point: number | undefined;

  for (let i = 1; i < afterDate.length; i++) {
    const p = afterDate[i];
    if (p === "away") side = "away";
    else if (p === "home") side = "home";
    else {
      // e.g. "15pt5" → 15.5, or "12" → 12
      const m = p.match(/^(\d+)(?:pt(\d+))?$/);
      if (m) point = m[2] ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]);
    }
  }

  return { sport, team1, team2, date, marketType, side, point };
}

/** Resolve outcome token indices using the full fallback chain. */
export function resolveIndices(
  outcomes: string[],
  outcomeMap: { Yes: string; No: string },
): { yesIdx: number; noIdx: number } {
  let yesIdx = outcomes.findIndex(
    (o) => o.toLowerCase() === outcomeMap.Yes.toLowerCase(),
  );
  let noIdx = outcomes.findIndex(
    (o) => o.toLowerCase() === outcomeMap.No.toLowerCase(),
  );

  // Literal "Yes"/"No" fallback (outcomes=["Yes","No"] but outcomeMap has team names)
  if (yesIdx === -1 || noIdx === -1) {
    const yp = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const np = outcomes.findIndex((o) => o.toLowerCase() === "no");
    if (yp !== -1 && np !== -1) {
      yesIdx = yp;
      noIdx = np;
    }
  }

  // Nickname fallback (outcomes=["Thunder","76ers"] but outcomeMap has full names)
  if (yesIdx === -1) {
    yesIdx = outcomes.findIndex(
      (o) =>
        outcomeMap.Yes.toLowerCase().includes(o.toLowerCase()) ||
        o.toLowerCase().includes(outcomeMap.Yes.toLowerCase()),
    );
  }
  if (noIdx === -1) {
    noIdx = outcomes.findIndex(
      (o) =>
        outcomeMap.No.toLowerCase().includes(o.toLowerCase()) ||
        o.toLowerCase().includes(outcomeMap.No.toLowerCase()),
    );
  }

  return { yesIdx, noIdx };
}

// ── Internal helpers ───────────────────────────────────────────────

function buildOutcomeMap(
  parsed: ParsedSlug,
  awayFull: string,
  homeFull: string,
): { Yes: string; No: string } {
  if (parsed.marketType === "totals") return { Yes: "Over", No: "Under" };
  // spreads: side is guaranteed non-null by tryMatch guard above
  if (parsed.side === "home") return { Yes: homeFull, No: awayFull };
  return { Yes: awayFull, No: homeFull }; // side === "away" (default)
}

function looseNameMatch(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}
