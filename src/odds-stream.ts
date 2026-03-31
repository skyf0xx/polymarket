// src/odds-stream.ts
// Manages the odds-api.io WebSocket connection and REST hydration.
// Maintains a live Map<eventId, SharpLine> and emits 'odds_update' events.
// REST hydration pre-populates the cache at startup (WS is a delta stream
// with no initial dump). REST is also used to fetch team names for new
// events that arrive via WS "created"/"updated" for unknown events.

import WebSocket from "ws";
import { EventEmitter } from "eventemitter3";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type {
  SharpLine,
  OddsApiIoEvent,
  OddsApiIoOddsResponse,
  OddsApiIoMarket,
  OddsWsMessage,
} from "./types.js";

const log = createLogger("odds-stream");

// ── Events emitted ───────────────────────────────────────────────

interface OddsStreamEvents {
  odds_update: (eventId: string, line: SharpLine) => void;
  connected: () => void;
  disconnected: () => void;
}

const PING_INTERVAL_MS = 10_000;
const ODDS_BATCH_SIZE = 10;
const HYDRATE_CONCURRENCY = 5;

export class OddsStream extends EventEmitter<OddsStreamEvents> {
  private cache = new Map<string, SharpLine>();
  private deadEvents = new Set<string>();
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 60_000;
  private destroyed = false;
  private connectedAt = 0;
  private _lastHydrateAt = 0;
  private static readonly STABLE_CONN_MS = 30_000; // 30s before resetting backoff

  // ── Public API ──────────────────────────────────────────────────

  getLine(eventId: string): SharpLine | undefined {
    return this.cache.get(eventId);
  }

  getAllLines(): Map<string, SharpLine> {
    return this.cache;
  }

  get size(): number {
    return this.cache.size;
  }

  get lastHydrateAt(): number {
    return this._lastHydrateAt;
  }

  /** Hydrate cache from REST then start WS connection. */
  async start(): Promise<void> {
    await this.hydrateFromRest();
    this.connectWs();
  }

  /** Re-hydrate from REST (called by maintenance cycle). */
  async rehydrate(): Promise<void> {
    await this.hydrateFromRest();
  }

  // ── REST Hydration ──────────────────────────────────────────────
  // Flow: GET /v3/events (get IDs) → GET /v3/odds in batches of 10

  private async hydrateFromRest(): Promise<void> {
    this._lastHydrateAt = Date.now();
    log.info(`Hydrating odds for ${config.oddsApiSports.length} sport(s)...`);

    for (const sport of config.oddsApiSports) {
      await this.hydrateSportEvents(sport, "pending");
      await this.hydrateSportEvents(sport, "live");
    }

    let withH2h = 0;
    for (const l of this.cache.values()) {
      if (l.markets.h2h) withH2h++;
    }
    log.info(`Odds cache ready: ${this.cache.size} events (${withH2h} with h2h)`);
  }

  private async hydrateSportEvents(
    sport: string,
    status: "pending" | "live",
  ): Promise<void> {
    try {
      const eventsPath = status === "live" ? "/v3/events/live" : "/v3/events";
      const eventsUrl =
        `${config.oddsApiRestUrl}${eventsPath}` +
        `?apiKey=${config.oddsApiKey}` +
        `&sport=${sport}` +
        (status === "pending" ? `&status=pending` : "");

      const eventsRes = await fetch(eventsUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!eventsRes.ok) {
        const body = await eventsRes.text().catch(() => "");
        log.error(
          `Events fetch failed for ${sport} (${status}): HTTP ${eventsRes.status} ${eventsRes.statusText} — ${body}`,
        );
        return;
      }

      const events: OddsApiIoEvent[] = await eventsRes.json();
      if (events.length === 0) {
        log.info(`No ${status} events for ${sport}`);
        return;
      }

      const ids = events.map((e) => String(e.id));
      let hydrated = 0;

      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += ODDS_BATCH_SIZE) {
        batches.push(ids.slice(i, i + ODDS_BATCH_SIZE));
      }

      for (let i = 0; i < batches.length; i += HYDRATE_CONCURRENCY) {
        const chunk = batches.slice(i, i + HYDRATE_CONCURRENCY);
        const results = await Promise.all(
          chunk.map((batch) => this.fetchOddsBatch(batch)),
        );
        for (const lines of results) {
          for (const line of lines) {
            this.cache.set(line.eventId, line);
            hydrated++;
          }
        }
      }

      log.info(
        `Hydrated ${hydrated}/${events.length} ${status} events for ${sport}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause ? ` | cause: ${err.cause}` : "";
      log.error(
        `REST hydration error for ${sport} (${status}): ${message}${cause}`,
      );
    }
  }

  private async fetchOddsBatch(eventIds: string[]): Promise<SharpLine[]> {
    try {
      const url =
        `${config.oddsApiRestUrl}/v3/odds/multi` +
        `?apiKey=${config.oddsApiKey}` +
        `&eventIds=${eventIds.join(",")}` +
        `&bookmakers=${config.bookmakerId}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error(
          `Odds batch fetch failed: HTTP ${res.status} ${res.statusText} — ${body}`,
        );
        return [];
      }

      const data: OddsApiIoOddsResponse[] = await res.json();
      return data.flatMap((item) => {
        const line = this.parseOddsResponse(item);
        return line ? [line] : [];
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`fetchOddsBatch error: ${message}`);
      return [];
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── WebSocket Connection ────────────────────────────────────────
  // Note: bookmakers are NOT passed as a WS param — they are managed
  // server-side via PUT /v3/bookmakers/selected/select.

  private connectWs(): void {
    if (this.destroyed) return;

    const sports = config.oddsApiSports.join(",");
    const leagues = config.oddsApiLeagues.join(",");
    const url =
      `${config.oddsApiWsUrl}` +
      `?apiKey=${config.oddsApiKey}` +
      `&markets=ML,Spread,Totals` +
      `&sport=${sports}` +
      (leagues ? `&leagues=${leagues}` : "");

    log.info(`Connecting Odds API WS: sports=${sports}`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.connectedAt = Date.now();
      log.info("Odds API WS connected");
      this.emit("connected");
      this.startHeartbeat();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      const text = raw.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg: OddsWsMessage = JSON.parse(trimmed);
          void this.handleMessage(msg);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to parse WS message: ${message}`);
        }
      }
    });

    this.ws.on("close", (code, reason) => {
      log.warn(`Odds API WS closed: code=${code} reason=${reason}`);
      this.stopHeartbeat();
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`Odds API WS error: ${err.message}`);
    });
  }

  private async handleMessage(msg: OddsWsMessage): Promise<void> {
    switch (msg.type) {
      case "welcome":
        log.info(
          `Odds API WS: welcome received (bookmakers: ${msg.bookmakers.join(", ")})`,
        );
        break;

      case "updated":
      case "created": {
        // Only process updates for our target bookmaker
        if (msg.bookie.toLowerCase() !== config.bookmakerId.toLowerCase()) {
          break;
        }

        const existing = this.cache.get(msg.id);

        if (existing) {
          this.mergeWsMarkets(existing, msg.markets);
          this.emit("odds_update", msg.id, existing);
          log.debug(`${msg.type}: updated markets for event ${msg.id}`);
        } else if (!this.deadEvents.has(msg.id)) {
          // Event not in cache — fetch full details (team names, sport, etc.) from REST
          const line = await this.fetchEventOdds(msg.id);
          if (line) {
            // Also merge the WS markets on top (REST may lag behind)
            this.mergeWsMarkets(line, msg.markets);
            this.cache.set(msg.id, line);
            this.emit("odds_update", msg.id, line);
            log.debug(`${msg.type}: added ${line.homeTeam} vs ${line.awayTeam}`, {
              eventId: msg.id,
            });
          }
        }
        break;
      }

      case "deleted":
        this.cache.delete(msg.id);
        this.deadEvents.delete(msg.id);
        log.debug(`Deleted event ${msg.id}`);
        break;

      case "no_markets":
        log.debug(`No markets for event ${msg.id}`);
        break;
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Reconnection ────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    // Only reset backoff if the connection was stable for 30s+
    if (
      this.connectedAt > 0 &&
      Date.now() - this.connectedAt >= OddsStream.STABLE_CONN_MS
    ) {
      this.reconnectAttempt = 0;
    }

    const delay = Math.min(
      1_000 * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;

    log.info(
      `Reconnecting Odds API WS in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );

    setTimeout(() => {
      this.connectWs();
    }, delay);
  }

  // ── Parsing ─────────────────────────────────────────────────────

  /**
   * Parse an odds-api.io /v3/odds response into a SharpLine.
   */
  private parseOddsResponse(item: OddsApiIoOddsResponse): SharpLine | null {
    const bookmakerMarkets = item.bookmakers[config.bookmakerId] ?? null;

    if (!bookmakerMarkets) {
      log.warn(`No ${config.bookmakerId} data for event ${item.id}, skipping`);
      return null;
    }

    const eventId = String(item.id);
    const line: SharpLine = {
      eventId,
      sportKey: item.sport?.slug ?? "unknown",
      leagueSlug: item.league?.slug ?? "unknown",
      homeTeam: item.home,
      awayTeam: item.away,
      commence: new Date(item.date).getTime(),
      markets: {},
      updatedAt: Date.now(),
    };

    this.applyMarkets(line, bookmakerMarkets);
    return line;
  }

  /**
   * Fetch full event + odds from REST for a single event ID.
   * Used when a WS "created" message fires for an event not in cache.
   */
  private async fetchEventOdds(eventId: string): Promise<SharpLine | null> {
    try {
      const url =
        `${config.oddsApiRestUrl}/v3/odds` +
        `?apiKey=${config.oddsApiKey}` +
        `&eventId=${eventId}` +
        `&bookmakers=${config.bookmakerId}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 404) {
          this.deadEvents.add(eventId);
          log.debug(`fetchEventOdds: event ${eventId} not found (404), suppressing future fetches`);
        } else {
          log.error(
            `fetchEventOdds failed for ${eventId}: HTTP ${res.status} ${res.statusText} — ${body}`,
          );
        }
        return null;
      }

      const data: OddsApiIoOddsResponse = await res.json();
      return this.parseOddsResponse(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause ? ` | cause: ${err.cause}` : "";
      log.error(`fetchEventOdds error for ${eventId}: ${message}${cause}`);
      return null;
    }
  }

  /**
   * Merge markets from a WS update into an existing SharpLine.
   */
  private mergeWsMarkets(line: SharpLine, markets: OddsApiIoMarket[]): void {
    this.applyMarkets(line, markets);
    line.updatedAt = Date.now();
  }

  /**
   * Apply an array of odds-api.io markets to a SharpLine's markets object.
   * Used for both REST (parsed bookmaker markets) and WS (markets array).
   */
  private applyMarkets(line: SharpLine, markets: OddsApiIoMarket[]): void {
    for (const market of markets) {
      const name = market.name.toLowerCase();

      if (name === "ml") {
        // Bookmakers may split home/away/draw across multiple odds entries.
        // Merge all entries then check for both sides.
        let mlHome: string | undefined;
        let mlAway: string | undefined;
        let mlDraw: string | undefined;
        for (const o of market.odds) {
          if (o.home != null && !mlHome) mlHome = o.home;
          if (o.away != null && !mlAway) mlAway = o.away;
          if (o.draw != null && !mlDraw) mlDraw = o.draw;
        }
        if (mlHome != null && mlAway != null) {
          line.markets.h2h = {
            home: decimalToProb(parseFloat(mlHome)),
            away: decimalToProb(parseFloat(mlAway)),
            ...(mlDraw != null && {
              draw: decimalToProb(parseFloat(mlDraw)),
            }),
          };
        }
      } else if (name === "spread") {
        // Upsert by point — WS may send partial updates (only changed lines),
        // so merge into existing array rather than replacing it outright.
        const existing = line.markets.spreads ?? [];
        const incoming = market.odds
          .filter(
            (o) =>
              o.home != null &&
              o.home !== "N/A" &&
              isRealOdds(o.home) &&
              o.away != null &&
              o.away !== "N/A" &&
              isRealOdds(o.away),
          )
          .map((o) => ({
            home: decimalToProb(parseFloat(o.home!)),
            away: decimalToProb(parseFloat(o.away!)),
            point: o.hdp ?? 0,
          }));
        // Replace matching points, append new ones
        const merged = [...existing];
        for (const inc of incoming) {
          const idx = merged.findIndex((e) => Math.abs(e.point - inc.point) < 0.05);
          if (idx >= 0) merged[idx] = inc;
          else merged.push(inc);
        }
        line.markets.spreads = merged;
      } else if (name === "totals") {
        // Upsert by point — same rationale as spreads above
        const existing = line.markets.totals ?? [];
        const incoming = market.odds
          .filter(
            (o) =>
              o.over != null &&
              o.over !== "N/A" &&
              isRealOdds(o.over) &&
              o.under != null &&
              o.under !== "N/A" &&
              isRealOdds(o.under),
          )
          .map((o) => ({
            over: decimalToProb(parseFloat(o.over!)),
            under: decimalToProb(parseFloat(o.under!)),
            point: o.hdp ?? 0,
          }));
        const merged = [...existing];
        for (const inc of incoming) {
          const idx = merged.findIndex((e) => Math.abs(e.point - inc.point) < 0.05);
          if (idx >= 0) merged[idx] = inc;
          else merged.push(inc);
        }
        line.markets.totals = merged;
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function decimalToProb(decimal: number): number {
  if (decimal <= 0) return 0;
  return 1 / decimal;
}

/** Decimal odds ≤ 1.02 are stubs, not real two-way prices. */
const MIN_REAL_DECIMAL = 1.02;

function isRealOdds(value: string): boolean {
  return parseFloat(value) > MIN_REAL_DECIMAL;
}
