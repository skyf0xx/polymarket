// src/market-matcher.ts
// Two-tier matching: local cache (fast path) + LLM fallback (new events).
// Maps Polymarket sports markets to Odds API events.

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
import { TeamKnowledge, resolveIndices } from "./team-knowledge.js";
import type {
  MatchEntry,
  MarketType,
  MatchConfidence,
  SharpLine,
  PolymarketMarket,
} from "./types.js";
const log = createLogger("matcher");

const MATCH_TABLE_FILE = join(config.dataDir, "match-table.json");

export class MarketMatcher {
  private table = new Map<string, MatchEntry>();
  private tokenIndex = new Map<string, MatchEntry>(); // tokenId → MatchEntry
  private knowledge = new TeamKnowledge();
  constructor() {
    this.loadFromDisk();
  }

  /** Hydrate team knowledge from the Gamma Teams API. Call before runMatchCycle. */
  async hydrateTeams(leagues: string[]): Promise<void> {
    await this.knowledge.hydrate(leagues);
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Look up a match by Polymarket slug. */
  getMatch(slug: string): MatchEntry | null {
    return this.table.get(slug) ?? null;
  }

  /** Look up a match by Odds API event ID. Returns all matching entries. */
  getMatchesByEvent(eventId: string): MatchEntry[] {
    return [...this.table.values()].filter((m) => m.oddsApiEventId === eventId);
  }

  /** Get all high-confidence, active matches. */
  getTradeableMatches(): MatchEntry[] {
    return [...this.table.values()].filter(
      (m) => m.confidence === "high" && m.active,
    );
  }

  /** Get all matches regardless of confidence or active status. */
  getAllMatches(): MatchEntry[] {
    return [...this.table.values()];
  }

  /** O(1) lookup of MatchEntry by token ID (yes or no). */
  getMatchByToken(tokenId: string): MatchEntry | null {
    return this.tokenIndex.get(tokenId) ?? null;
  }

  /** All token IDs from high-confidence matches. */
  getAllTokenIds(): string[] {
    const ids: string[] = [];
    for (const m of this.getTradeableMatches()) {
      ids.push(m.tokenIds.yes, m.tokenIds.no);
    }
    return ids;
  }

  get size(): number {
    return this.table.size;
  }

  /**
   * Run a full match cycle:
   * 1. Check which Polymarket markets are already matched (Tier 1)
   * 2. Send unmatched ones to the LLM in sequential batches (Tier 2)
   * 3. Validate and persist results
   */
  async runMatchCycle(
    oddsLines: Map<string, SharpLine>,
    polymarkets: PolymarketMarket[],
  ): Promise<{ newMatches: number; total: number }> {
    const unmatched: PolymarketMarket[] = [];
    for (const pm of polymarkets) {
      if (this.table.has(pm.slug)) continue;
      unmatched.push(pm);
    }

    if (unmatched.length === 0) {
      return { newMatches: 0, total: this.table.size };
    }

    // Build slim Odds API event list — deduplicated by eventId (oddsLines has one
    // entry per market type per event, so h2h/spreads/totals all share the same game).
    const seenEventIds = new Set<string>();
    const oddsEvents: Array<{ id: string; sport: string; league: string; home: string; away: string; time: string }> = [];
    for (const line of oddsLines.values()) {
      if (seenEventIds.has(line.eventId)) continue;
      seenEventIds.add(line.eventId);
      oddsEvents.push({
        id: line.eventId,
        sport: line.sportKey,
        league: line.leagueSlug,
        home: line.homeTeam,
        away: line.awayTeam,
        time: new Date(line.commence).toISOString(),
      });
    }

    if (oddsEvents.length === 0) {
      log.warn("No odds events available — skipping matcher");
      return { newMatches: 0, total: this.table.size };
    }

    // ── Tier 1.5: Deterministic match from team knowledge ──────────
    const now = Date.now();
    const needsLlm: PolymarketMarket[] = [];
    let deterministicCount = 0;

    for (const pm of unmatched) {
      const det = this.knowledge.tryMatch(pm, oddsEvents, now);
      if (det) {
        const oddsLine = oddsLines.get(det.oddsApiEventId);
        const timeDiff = Math.abs(
          (oddsLine?.commence ?? 0) - new Date(pm.endDate ?? 0).getTime(),
        );
        if (oddsLine && timeDiff <= 48 * 60 * 60 * 1_000) {
          const entry: MatchEntry = {
            ...det,
            commence: oddsLine.commence,
            active: pm.active,
          };
          this.table.set(pm.slug, entry);
          deterministicCount++;
          continue;
        }
      }
      needsLlm.push(pm);
    }

    if (deterministicCount > 0) {
      log.info(
        `Deterministic: ${deterministicCount} market(s) matched from team knowledge`,
      );
      this.saveToDisk();
      this.rebuildTokenIndex();
    }

    if (needsLlm.length === 0) {
      return { newMatches: deterministicCount, total: this.table.size };
    }

    // ── Tier 2: LLM for remaining unmatched ────────────────────────
    log.info(`${needsLlm.length} market(s) need LLM matching...`);

    const BATCH_SIZE = 10;
    // Anthropic free tier: 50k input tokens/min. Haiku prompt ~1500 tokens/batch.
    // Allow max 30k tokens/min (60% of limit) → 20s/batch minimum.
    const TOKEN_BUDGET_PER_MIN = 30_000;
    const APPROX_TOKENS_PER_BATCH = 1_500;
    const MIN_DELAY_MS = Math.ceil((APPROX_TOKENS_PER_BATCH / TOKEN_BUDGET_PER_MIN) * 60_000); // ~3s
    const LLM_INTER_BATCH_DELAY_MS = Math.max(MIN_DELAY_MS, 20_000); // floor at 20s to be safe
    const batches = chunk(needsLlm, BATCH_SIZE);
    let newCount = deterministicCount;
    let totalLlmMatches = 0;

    for (let i = 0; i < batches.length; i++) {
      if (i > 0) {
        log.info(`Waiting ${LLM_INTER_BATCH_DELAY_MS / 1000}s before next LLM batch (rate limit guard)...`);
        await new Promise((r) => setTimeout(r, LLM_INTER_BATCH_DELAY_MS));
      }

      const batch = batches[i];
      log.info(
        `LLM batch ${i + 1}/${batches.length}: ${batch.length} market(s), ${oddsEvents.length} odds events total`,
      );

      try {
        // Pre-filter odds events to only dates present in this batch's slugs
        const batchDates = new Set(
          batch.map((pm) => pm.slug.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean),
        );
        const filteredOddsEvents = oddsEvents.filter((e) =>
          batchDates.has(e.time.slice(0, 10)),
        );
        const matches = await this.callLlmMatcher(filteredOddsEvents, batch);
        totalLlmMatches += matches.length;

        for (const match of matches) {
          // Validate: slug date matches odds event date (±1 day for UTC rollover); also set commence from the odds line
          const oddsLine = oddsLines.get(match.oddsApiEventId);
          if (oddsLine) {
            const slugDate = match.slug.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
            const oddsDate = new Date(oddsLine.commence).toISOString().slice(0, 10);
            if (!slugDate) {
              log.warn(`No date found in slug ${match.slug}, skipping date validation`);
            } else {
              // Allow ±1 day drift: games tipping late in local evening (10pm+) roll into next calendar day in UTC.
              // E.g., a game on March 25 at 10:30pm ET is March 26 in UTC, so slug=2026-03-25 matches odds=2026-03-26.
              const slugMs = new Date(slugDate).getTime();
              const oddsMs = new Date(oddsDate).getTime();
              const dayDiff = Math.abs(slugMs - oddsMs) / (24 * 60 * 60 * 1000);
              if (dayDiff > 1) {
                log.warn(
                  `Skipping match ${match.slug} ↔ ${match.oddsApiEventId}: date mismatch (slug=${slugDate}, odds=${oddsDate}, diff=${dayDiff.toFixed(1)}d)`,
                );
                continue;
              }
            }
            match.commence = oddsLine.commence;
          }

          const pmFull = polymarkets.find((p) => p.slug === match.slug);
          if (pmFull) {
            match.active = pmFull.active;
            this.knowledge.learn(match);
          }

          this.table.set(match.slug, match);
          newCount++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`LLM batch ${i + 1}/${batches.length} failed: ${message}`);
      }
    }

    this.saveToDisk();
    this.rebuildTokenIndex();
    log.info(
      `LLM returned ${totalLlmMatches} match(es), ${newCount} total validated`,
    );

    // DEBUG: if no new LLM matches, dump sample input/output for inspection
    if (totalLlmMatches === 0 && needsLlm.length > 0) {
      const marketTypeCounts: Record<string, number> = {};
      for (const pm of needsLlm) {
        // Infer market type from slug
        const typeMatch = pm.slug.match(/(spread|h2h|moneyline|ml|total)/);
        const type = typeMatch?.[1] ?? "unknown";
        marketTypeCounts[type] = (marketTypeCounts[type] ?? 0) + 1;
      }

      const debugPayload = {
        ts: new Date().toISOString(),
        oddsEventsSample: oddsEvents.slice(0, 5),
        polymarketsSample: needsLlm.slice(0, 5),
      };
      import("fs").then(({ writeFileSync }) => {
        writeFileSync("data/debug-matcher.json", JSON.stringify(debugPayload, null, 2));
      });
      const typeSummary = Object.entries(marketTypeCounts)
        .map(([type, count]) => `${count}x ${type}`)
        .join(", ");
      log.warn(
        `⚠ No LLM matches for ${needsLlm.length} market(s) [${typeSummary}] — debug sample: data/debug-matcher.json (${oddsEvents.length} odds events available)`,
      );
    }

    return { newMatches: newCount, total: this.table.size };
  }

  /** Remove expired matches: orphans after 48h, commenced events after 4h grace window. */
  pruneExpired(): number {
    const now = Date.now();
    const ORPHAN_TTL_MS = 48 * 60 * 60 * 1_000; // 48h
    let pruned = 0;
    for (const [slug, entry] of this.table) {
      // Prune orphan matches (never linked to an odds line) after 48h
      if (entry.commence === 0 && now - entry.matchedAt > ORPHAN_TTL_MS) {
        this.table.delete(slug);
        pruned++;
        continue;
      }
      // Prune past-commence entries after a 4h grace window (covers long games)
      const GAME_GRACE_MS = 4 * 60 * 60 * 1_000;
      if (entry.commence > 0 && entry.commence + GAME_GRACE_MS < now) {
        this.table.delete(slug);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.saveToDisk();
      this.rebuildTokenIndex();
      log.info(`Pruned ${pruned} expired match(es)`);
    }
    return pruned;
  }

  /**
   * Refresh the active flag for all matched entries from the latest Gamma data.
   * Called during maintenance after re-fetching market metadata.
   */
  updateActiveStatus(polymarkets: PolymarketMarket[]): void {
    let changed = false;
    const activeSlugs = new Set(polymarkets.map((pm) => pm.slug));

    for (const pm of polymarkets) {
      const entry = this.table.get(pm.slug);
      if (entry && entry.active !== pm.active) {
        entry.active = pm.active;
        changed = true;
        if (!pm.active) {
          log.info(`Market ${pm.slug} marked inactive (resolved/closed)`);
        }
      }
    }

    // Mark matches inactive if they no longer appear in the Gamma active list
    for (const [slug, entry] of this.table) {
      if (entry.active && !activeSlugs.has(slug)) {
        entry.active = false;
        changed = true;
        log.info(
          `Market ${slug} no longer in Gamma active list — marked inactive`,
        );
      }
    }

    if (changed) this.saveToDisk();
  }

  // ── Token Index ────────────────────────────────────────────────

  private rebuildTokenIndex(): void {
    this.tokenIndex.clear();
    for (const entry of this.table.values()) {
      if (entry.tokenIds.yes) this.tokenIndex.set(entry.tokenIds.yes, entry);
      if (entry.tokenIds.no) this.tokenIndex.set(entry.tokenIds.no, entry);
    }
  }

  // ── LLM Matching (Tier 2) ──────────────────────────────────────

  private async callLlmMatcher(
    oddsEvents: Array<{
      id: string;
      sport: string;
      league: string;
      home: string;
      away: string;
      time: string;
    }>,
    polymarkets: PolymarketMarket[],
  ): Promise<MatchEntry[]> {
    if (!config.anthropicApiKey) {
      log.warn("No ANTHROPIC_API_KEY — skipping LLM matching");
      return [];
    }

    const systemPrompt = `You are a sports event matching engine. Given a list of sportsbook events and Polymarket prediction markets, match each Polymarket market to its corresponding sportsbook event.

Rules:
- Match by team names, date proximity, and sport
- Each Polymarket market has an "outcomes" array
- For totals: use exact outcome strings — outcomeMap={Yes:"Over",No:"Under"}
- For h2h/spreads: always use the SPORTSBOOK team name in outcomeMap (e.g. outcomeMap={Yes:"Los Angeles Lakers",No:"Boston Celtics"}), even if Polymarket outcomes are ["Yes","No"] — the team name tells the system which side "Yes" represents
- Set confidence=high only when team names clearly match and dates align
- If no match exists, omit that market from the matches array entirely`;

    // Slim projection: only fields the LLM needs for matching
    const polySlim = polymarkets.map((pm) => ({
      slug: pm.slug,
      question: pm.question,
      groupItemTitle: pm.groupItemTitle ?? null,
      outcomes: pm.outcomes ?? ["Yes", "No"],
      endDate: pm.endDate,
    }));

    const userPrompt = `Sportsbook events:\n${JSON.stringify(oddsEvents)}\n\nPolymarket markets:\n${JSON.stringify(polySlim)}`;

    const reqBody = JSON.stringify({
      model: config.matcherModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [
        {
          name: "submit_matches",
          description:
            "Submit the list of matched Polymarket markets to sportsbook events",
          input_schema: {
            type: "object",
            properties: {
              matches: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    slug: {
                      type: "string",
                      description: "Polymarket market slug",
                    },
                    oddsApiEventId: {
                      type: "string",
                      description: "Odds API event ID",
                    },
                    sportKey: {
                      type: "string",
                      description: "Odds API sport key",
                    },
                    homeTeam: {
                      type: "string",
                      description: "Full home team name",
                    },
                    awayTeam: {
                      type: "string",
                      description: "Full away team name",
                    },
                    outcomeMap: {
                      type: "object",
                      properties: {
                        Yes: {
                          type: "string",
                          description: "Team/side that Yes outcome maps to",
                        },
                        No: {
                          type: "string",
                          description: "Team/side that No outcome maps to",
                        },
                      },
                      required: ["Yes", "No"],
                    },
                    marketType: {
                      type: "string",
                      enum: ["h2h", "spreads", "totals"],
                    },
                    point: {
                      type: ["number", "null"],
                      description: "Spread or total point value, null for h2h",
                    },
                    confidence: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                    },
                  },
                  required: [
                    "slug",
                    "oddsApiEventId",
                    "sportKey",
                    "homeTeam",
                    "awayTeam",
                    "outcomeMap",
                    "marketType",
                    "confidence",
                  ],
                },
              },
            },
            required: ["matches"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_matches" },
    });

    console.log(
      `[matcher] LLM payload: ${oddsEvents.length} odds events, ${polymarkets.length} markets, ${(reqBody.length / 1024).toFixed(1)}KB (${reqBody.length} bytes)`,
    );

    let res: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: reqBody,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (res.status !== 429) break;

      // Respect retry-after header if present, else exponential backoff
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1_000 : (attempt + 1) * 30_000;
      log.warn(`Rate limited (429). Waiting ${waitMs / 1000}s before retry ${attempt + 1}/3...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!res!.ok) {
      const errText = await res!.text();
      throw new Error(`Anthropic API error ${res!.status}: ${errText}`);
    }

    const data: {
      content?: Array<{ type: string; input?: { matches: unknown[] } }>;
    } = await res!.json();
    const block = data.content?.find((c) => c.type === "tool_use");
    if (!block?.input) {
      throw new Error(
        `Unexpected Anthropic response shape: ${JSON.stringify(data.content)}`,
      );
    }

    interface LlmMatchResult {
      slug: string;
      oddsApiEventId: string;
      sportKey: string;
      homeTeam: string;
      awayTeam: string;
      outcomeMap: { Yes: string; No: string };
      marketType: MarketType;
      point?: number | null;
      confidence: MatchConfidence;
    }

    const raw: LlmMatchResult[] = block.input.matches as LlmMatchResult[];

    // Convert to MatchEntry objects
    const now = Date.now();
    return raw.flatMap((r): MatchEntry[] => {
      // Find the polymarket to get tokenIds
      const pm = polymarkets.find((p) => p.slug === r.slug);
      if (!pm) {
        log.warn(`LLM returned unknown slug "${r.slug}", skipping`);
        return [];
      }
      const outcomes = pm.outcomes ?? [];
      const { yesIdx, noIdx } = resolveIndices(outcomes, r.outcomeMap);

      if (yesIdx === -1 || noIdx === -1) {
        log.warn(
          `LLM match "${r.slug}" could not map outcomes (got ${JSON.stringify(outcomes)}, outcomeMap=${JSON.stringify(r.outcomeMap)}), skipping`,
        );
        return [];
      }

      // Derive sportKey/leagueSlug from the matched odds event — the LLM's value is unreliable
      const matchedEvent = oddsEvents.find((e) => e.id === r.oddsApiEventId);
      if (!matchedEvent) {
        log.warn(`LLM match "${r.slug}" references unknown event "${r.oddsApiEventId}", skipping`);
        return [];
      }

      return [
        {
          slug: r.slug,
          oddsApiEventId: r.oddsApiEventId,
          sportKey: matchedEvent.sport,
          leagueSlug: matchedEvent.league,
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          outcomeMap: r.outcomeMap,
          marketType: r.marketType,
          point: r.point ?? undefined,
          confidence: r.confidence,
          matchedAt: now,
          commence: 0, // overridden in runMatchCycle once oddsLine is found
          active: pm.active, // overridden in runMatchCycle from full market data
          tokenIds: {
            yes: pm.tokenIds?.[yesIdx] ?? "",
            no: pm.tokenIds?.[noIdx] ?? "",
          },
        },
      ];
    });
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadFromDisk(): void {
    if (!existsSync(MATCH_TABLE_FILE)) return;
    try {
      const raw = JSON.parse(readFileSync(MATCH_TABLE_FILE, "utf-8"));
      for (const entry of raw) {
        this.table.set(entry.slug, entry);
      }
      this.rebuildTokenIndex();
      log.info(`Loaded ${this.table.size} match(es) from disk`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not read match table: ${message}`);
    }
  }

  private saveToDisk(): void {
    if (!existsSync(config.dataDir)) {
      mkdirSync(config.dataDir, { recursive: true });
    }
    const tmpFile = MATCH_TABLE_FILE + ".tmp";
    const data = JSON.stringify([...this.table.values()], null, 2);
    writeFileSync(tmpFile, data);
    renameSync(tmpFile, MATCH_TABLE_FILE);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ── Gamma API Helper ──────────────────────────────────────────────

/** Fetch active sports markets from the Gamma API (paginated). */
export async function fetchPolymarketSportsMarkets(): Promise<
  PolymarketMarket[]
> {
  const PAGE_SIZE = 200;
  const all: PolymarketMarket[] = [];
  const seenSlugs = new Set<string>();

  // Build repeated params: sports_market_types=moneyline&sports_market_types=spreads&...
  const typeParams = config.polymarketSportsTypes
    .map((t) => `sports_market_types=${encodeURIComponent(t)}`)
    .join("&");

  // Tag IDs filter specific leagues (e.g., 745=NBA, 82=EPL)
  const tagIds = config.polymarketTagIds;
  let offset = 0;

  // If multiple tag IDs, fetch per-tag (API accepts single tag_id per request)
  const tagQueries = tagIds.length > 0 ? tagIds : [null];

  for (const tagId of tagQueries) {
    offset = 0;
    let tagCount = 0;

    while (true) {
      let url =
        `${config.gammaApiUrl}/markets` +
        `?${typeParams}` +
        `&closed=false` +
        `&liquidity_num_min=${config.polymarketMinLiquidity}` +
        `&limit=${PAGE_SIZE}` +
        `&offset=${offset}`;

      if (tagId) {
        url += `&tag_id=${tagId}`;
      }

      const res = await fetch(url);
      if (!res.ok) {
        log.error(`Gamma API error (tag_id=${tagId ?? "all"}): ${res.status}`);
        break;
      }

      interface GammaMarketResponse {
        slug: string;
        question: string;
        outcomes: string | string[];
        outcomePrices: string | string[];
        clobTokenIds: string | string[];
        endDate: string;
        active: boolean;
        closed: boolean;
        groupItemTitle?: string;
        conditionId: string;
      }

      const raw: GammaMarketResponse[] = await res.json();
      if (raw.length === 0) break;

      for (const m of raw) {
        if (seenSlugs.has(m.slug)) continue;
        seenSlugs.add(m.slug);
        all.push({
          slug: m.slug,
          question: m.question,
          outcomes:
            typeof m.outcomes === "string"
              ? JSON.parse(m.outcomes)
              : (m.outcomes ?? ["Yes", "No"]),
          outcomePrices:
            typeof m.outcomePrices === "string"
              ? JSON.parse(m.outcomePrices)
              : (m.outcomePrices ?? ["0.5", "0.5"]),
          tokenIds:
            typeof m.clobTokenIds === "string"
              ? JSON.parse(m.clobTokenIds)
              : Array.isArray(m.clobTokenIds)
                ? m.clobTokenIds
                : [],
          endDate: m.endDate,
          active: m.active,
          closed: m.closed,
          groupItemTitle: m.groupItemTitle,
          conditionId: m.conditionId,
        });
        tagCount++;
      }

      if (raw.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    log.info(`Gamma: ${tagCount} market(s) for tag_id=${tagId ?? "all"}`);
  }

  log.info(
    `Gamma total: ${all.length} market(s) (types=[${config.polymarketSportsTypes}], min_liq=${config.polymarketMinLiquidity})`,
  );
  return all;
}
