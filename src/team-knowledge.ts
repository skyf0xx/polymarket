// src/team-knowledge.ts
// Persistent team knowledge base — survives across sessions.
// Accumulates abbreviation and nickname mappings from successful LLM matches,
// enabling deterministic matching for markets involving previously-seen teams.

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

interface KnowledgeData {
  abbreviations: Record<string, Record<string, string>>; // sport → { "okc" → "Oklahoma City Thunder" }
  nicknames: Record<string, Record<string, string>>; // sport → { "Thunder" → "Oklahoma City Thunder" }
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

export class TeamKnowledge {
  private data: KnowledgeData = { abbreviations: {}, nicknames: {} };

  constructor() {
    this.load();
  }

  /**
   * Extract and persist team knowledge from a successful LLM match.
   * Call this after every validated LLM match entry.
   */
  learn(entry: MatchEntry, pm: PolymarketMarket): void {
    const parsed = parseSlug(entry.slug);
    // Use league slug (e.g. "nba", "ncaab") for granular keying; fall back to sportKey
    const league = entry.leagueSlug || entry.sportKey;
    if (!league) return;
    let changed = false;

    // Abbreviation learning: team1 in slug = away, team2 = home (Polymarket convention)
    if (parsed) {
      changed = this.setAbbr(league, parsed.team1, entry.awayTeam) || changed;
      changed = this.setAbbr(league, parsed.team2, entry.homeTeam) || changed;
    }

    // Nickname learning: if an outcome string isn't a full team name, learn the mapping
    for (const outcome of pm.outcomes ?? []) {
      for (const fullName of [entry.outcomeMap.Yes, entry.outcomeMap.No]) {
        if (isNicknameOf(outcome, fullName)) {
          changed = this.setNickname(league, outcome, fullName) || changed;
        }
      }
    }

    if (changed) this.save();
  }

  /**
   * Attempt deterministic matching for a single market.
   * Returns a partial MatchEntry (commence=0 and active=false, caller must fill)
   * or null if deterministic matching is not possible.
   *
   * Handles totals and spreads only — h2h outcomeMap cannot be inferred from
   * the slug alone without risking Yes/No inversion.
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

    // Only handle market types where outcomeMap is unambiguous from the slug
    if (parsed.marketType === "h2h") return null;
    if (parsed.marketType === "spreads" && !parsed.side) return null;

    // Search all league-level buckets that match the slug's generic sport.
    // e.g. slug sport "basketball" checks abbreviations under "nba", "ncaab", etc.
    const leagueKeys = Object.keys(this.data.abbreviations).filter((key) => {
      // Match if the league key's events share the same generic sport
      // We also accept exact match for backwards compat with old sportKey-keyed data
      return key === parsed.sport || oddsEvents.some(
        (e) => e.league === key && e.sport === parsed.sport,
      );
    });

    for (const league of leagueKeys) {
      const sportAbbrs = this.data.abbreviations[league] ?? {};
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

      const outcomeMap = buildOutcomeMap(parsed, awayFull, homeFull);
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

  /** Full team name for a short nickname, or null if not known. */
  lookupNickname(sport: string, nickname: string): string | null {
    return this.data.nicknames[sport]?.[nickname] ?? null;
  }

  get stats(): { abbreviations: number; nicknames: number; sports: string[] } {
    let abbreviations = 0;
    let nicknames = 0;
    for (const sport of Object.keys(this.data.abbreviations)) {
      abbreviations += Object.keys(this.data.abbreviations[sport]).length;
    }
    for (const sport of Object.keys(this.data.nicknames)) {
      nicknames += Object.keys(this.data.nicknames[sport]).length;
    }
    return {
      abbreviations,
      nicknames,
      sports: Array.from(
        new Set([
          ...Object.keys(this.data.abbreviations),
          ...Object.keys(this.data.nicknames),
        ]),
      ),
    };
  }

  // ── Private ────────────────────────────────────────────────────

  private setAbbr(sport: string, abbr: string, fullName: string): boolean {
    const key = abbr.toLowerCase();
    if (!this.data.abbreviations[sport]) this.data.abbreviations[sport] = {};
    if (this.data.abbreviations[sport][key] === fullName) return false;
    this.data.abbreviations[sport][key] = fullName;
    return true;
  }

  private setNickname(sport: string, nickname: string, fullName: string): boolean {
    if (!this.data.nicknames[sport]) this.data.nicknames[sport] = {};
    if (this.data.nicknames[sport][nickname] === fullName) return false;
    this.data.nicknames[sport][nickname] = fullName;
    return true;
  }

  private load(): void {
    if (!existsSync(KNOWLEDGE_FILE)) return;
    try {
      this.data = JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8"));
      const s = this.stats;
      log.info(
        `Team knowledge: ${s.abbreviations} abbrs, ${s.nicknames} nicknames across ${s.sports.length} sports`,
      );
    } catch (err: unknown) {
      log.warn(
        `Could not load team knowledge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private save(): void {
    if (!existsSync(config.dataDir))
      mkdirSync(config.dataDir, { recursive: true });
    const tmp = KNOWLEDGE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
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

/** True if `outcome` is a short-form nickname of `fullName`. */
function isNicknameOf(outcome: string, fullName: string): boolean {
  const o = outcome.toLowerCase();
  const f = fullName.toLowerCase();
  // Must be a substring match, and must NOT be identical (not a nickname then)
  return o !== f && (f.includes(o) || o.includes(f));
}

function looseNameMatch(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}
