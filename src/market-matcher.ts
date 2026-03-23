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

  constructor() {
    this.loadFromDisk();
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

    log.info(
      `${unmatched.length} unmatched market(s) — running LLM matcher...`,
    );

    // Build slim Odds API event list for the LLM (no marketTypes)
    const oddsEvents = [...oddsLines.values()].map((line) => ({
      id: line.eventId,
      sport: line.sportKey,
      home: line.homeTeam,
      away: line.awayTeam,
      time: new Date(line.commence).toISOString(),
    }));

    if (oddsEvents.length === 0) {
      log.warn("No odds events available — skipping LLM matcher");
      return { newMatches: 0, total: this.table.size };
    }

    // ── Sequential batching: 25 markets per round ──
    const BATCH_SIZE = 25;
    const batches = chunk(unmatched, BATCH_SIZE);
    let newCount = 0;
    let totalLlmMatches = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      log.info(
        `LLM batch ${i + 1}/${batches.length}: ${batch.length} market(s), ${oddsEvents.length} odds events`,
      );

      try {
        const matches = await this.callLlmMatcher(oddsEvents, batch);
        totalLlmMatches += matches.length;

        for (const match of matches) {
          // Validate: date within ±48h; also set commence from the odds line
          const oddsLine = oddsLines.get(match.oddsApiEventId);
          if (oddsLine) {
            const timeDiff = Math.abs(
              oddsLine.commence -
                new Date(
                  polymarkets.find((p) => p.slug === match.slug)?.endDate ?? 0,
                ).getTime(),
            );
            if (timeDiff > 48 * 60 * 60 * 1000) {
              log.warn(
                `Skipping match ${match.slug} ↔ ${match.oddsApiEventId}: date mismatch (${(timeDiff / 3600000).toFixed(0)}h)`,
              );
              continue;
            }
            match.commence = oddsLine.commence;
          }

          // Set active from the full Polymarket market record
          const pmFull = polymarkets.find((p) => p.slug === match.slug);
          if (pmFull) {
            match.active = pmFull.active;
          }

          this.table.set(match.slug, match);
          newCount++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`LLM batch ${i + 1}/${batches.length} failed: ${message}`);
        // Continue with remaining batches — don't abort the whole cycle
      }
    }

    this.saveToDisk();
    this.rebuildTokenIndex();
    log.info(
      `LLM returned ${totalLlmMatches} match(es), ${newCount} validated`,
    );

    return { newMatches: newCount, total: this.table.size };
  }

  /** Remove expired matches (events that have started AND are no longer active). */
  pruneExpired(): number {
    const now = Date.now();
    const ORPHAN_TTL_MS = 48 * 60 * 60 * 1000; // 48h
    let pruned = 0;
    for (const [slug, entry] of this.table) {
      // Prune orphan matches (never linked to an odds line) after 48h
      if (entry.commence === 0 && now - entry.matchedAt > ORPHAN_TTL_MS) {
        this.table.delete(slug);
        pruned++;
        continue;
      }
      // Only prune past-commence entries that are also inactive
      if (entry.commence > 0 && entry.commence < now && !entry.active) {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000); // 90s timeout

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: reqBody,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data: {
      content?: Array<{ type: string; input?: { matches: unknown[] } }>;
    } = await res.json();
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
      let yesIdx = outcomes.findIndex(
        (o) => o.toLowerCase() === r.outcomeMap.Yes.toLowerCase(),
      );
      let noIdx = outcomes.findIndex(
        (o) => o.toLowerCase() === r.outcomeMap.No.toLowerCase(),
      );

      // Positional fallback for h2h/spreads where outcomes are ["Yes","No"] but
      // outcomeMap contains team names (used by coordinator for sharp prob lookup)
      if ((yesIdx === -1 || noIdx === -1) && (r.marketType === "h2h" || r.marketType === "spreads")) {
        const yesPos = outcomes.findIndex((o) => o.toLowerCase() === "yes");
        const noPos = outcomes.findIndex((o) => o.toLowerCase() === "no");
        if (yesPos !== -1 && noPos !== -1) {
          yesIdx = yesPos;
          noIdx = noPos;
        }
      }

      if (yesIdx === -1 || noIdx === -1) {
        log.warn(
          `LLM match "${r.slug}" could not map outcomes (got ${JSON.stringify(outcomes)}, outcomeMap=${JSON.stringify(r.outcomeMap)}), skipping`,
        );
        return [];
      }

      return [
        {
          slug: r.slug,
          oddsApiEventId: r.oddsApiEventId,
          sportKey: r.sportKey,
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
