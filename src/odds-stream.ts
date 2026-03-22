// src/odds-stream.ts
// Manages the odds-api.io WebSocket connection and REST hydration.
// Maintains a live Map<eventId, SharpLine> and emits 'odds_update' events.

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

export class OddsStream extends EventEmitter<OddsStreamEvents> {
  private cache = new Map<string, SharpLine>();
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 60_000;
  private destroyed = false;

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

  async start(): Promise<void> {
    await this.hydrateFromRest();
    this.connectWs();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── REST Hydration ──────────────────────────────────────────────
  // Flow: GET /v3/events (get IDs) → GET /v3/odds/multi in batches of 10

  private async hydrateFromRest(): Promise<void> {
    log.info(`Hydrating odds for ${config.oddsApiSports.length} sport(s)...`);

    for (const sport of config.oddsApiSports) {
      // Hydrate pending (upcoming) events
      await this.hydrateSportEvents(sport, "pending");
      // Hydrate live (in-play) events
      await this.hydrateSportEvents(sport, "live");
    }

    log.info(`Odds cache ready: ${this.cache.size} events`);
  }

  private async hydrateSportEvents(
    sport: string,
    status: "pending" | "live",
  ): Promise<void> {
    try {
      // Step 1: fetch event IDs
      const eventsPath =
        status === "live" ? "/v3/events/live" : "/v3/events";
      const eventsUrl =
        `${config.oddsApiRestUrl}${eventsPath}` +
        `?apiKey=${config.oddsApiKey}` +
        `&sport=${sport}` +
        (status === "pending" ? `&status=pending` : "");

      const eventsRes = await fetch(eventsUrl);
      if (!eventsRes.ok) {
        log.error(`Events fetch failed for ${sport} (${status}): ${eventsRes.status}`);
        return;
      }

      const events: OddsApiIoEvent[] = await eventsRes.json();
      if (events.length === 0) {
        log.info(`No ${status} events for ${sport}`);
        return;
      }

      // Step 2: fetch odds in batches of 10
      const ids = events.map((e) => String(e.id));
      let hydrated = 0;

      for (let i = 0; i < ids.length; i += ODDS_BATCH_SIZE) {
        const batch = ids.slice(i, i + ODDS_BATCH_SIZE);
        const oddsUrl =
          `${config.oddsApiRestUrl}/v3/odds/multi` +
          `?apiKey=${config.oddsApiKey}` +
          `&eventIds=${batch.join(",")}` +
          `&bookmakers=${config.bookmakerId}`;

        const oddsRes = await fetch(oddsUrl);
        if (!oddsRes.ok) {
          log.error(
            `Odds batch fetch failed (${sport} ${status}, batch ${Math.floor(i / ODDS_BATCH_SIZE) + 1}): ${oddsRes.status}`,
          );
          continue;
        }

        const oddsData: OddsApiIoOddsResponse[] = await oddsRes.json();
        for (const item of oddsData) {
          const line = this.parseOddsResponse(item);
          if (line) {
            this.cache.set(line.eventId, line);
            hydrated++;
          }
        }
      }

      log.info(`Hydrated ${hydrated}/${events.length} ${status} events for ${sport}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`REST hydration error for ${sport} (${status}): ${message}`);
    }
  }

  // ── WebSocket Connection ────────────────────────────────────────
  // Note: bookmakers are NOT passed as a WS param — they are managed
  // server-side via PUT /v3/bookmakers/selected/select.

  private connectWs(): void {
    if (this.destroyed) return;

    const sports = config.oddsApiSports.join(",");
    const url =
      `${config.oddsApiWsUrl}` +
      `?apiKey=${config.oddsApiKey}` +
      `&markets=ML,Spread,Totals` +
      `&sport=${sports}` +
      `&status=prematch`;

    log.info(`Connecting Odds API WS: sports=${sports}`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
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
        if (
          msg.bookie.toLowerCase() !==
          config.bookmakerId.toLowerCase()
        ) {
          break;
        }

        const existing = this.cache.get(msg.id);

        if (existing) {
          this.mergeWsMarkets(existing, msg.markets);
          this.emit("odds_update", msg.id, existing);
          log.debug(`${msg.type}: updated markets for event ${msg.id}`);
        } else if (msg.type === "created") {
          // New event — fetch full details from REST
          const line = await this.fetchEventOdds(msg.id);
          if (line) {
            this.cache.set(msg.id, line);
            this.emit("odds_update", msg.id, line);
            log.debug(
              `created: added ${line.homeTeam} vs ${line.awayTeam}`,
              { eventId: msg.id },
            );
          }
        }
        break;
      }

      case "deleted":
        this.cache.delete(msg.id);
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

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;

    log.info(
      `Reconnecting Odds API WS in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );

    setTimeout(async () => {
      try {
        await this.hydrateFromRest();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`REST hydration failed on reconnect: ${message}`);
      }
      this.connectWs();
    }, delay);
  }

  // ── Parsing ─────────────────────────────────────────────────────

  /**
   * Parse an odds-api.io /v3/odds response into a SharpLine.
   */
  private parseOddsResponse(
    item: OddsApiIoOddsResponse,
  ): SharpLine | null {
    const bookmakerMarkets =
      item.bookmakers[config.bookmakerId] ?? null;

    if (!bookmakerMarkets) {
      log.warn(
        `No ${config.bookmakerId} data for event ${item.id}, skipping`,
      );
      return null;
    }

    const eventId = String(item.id);
    const line: SharpLine = {
      eventId,
      sportKey: item.sport?.slug ?? "unknown",
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

      const res = await fetch(url);
      if (!res.ok) {
        log.error(`fetchEventOdds failed for ${eventId}: ${res.status}`);
        return null;
      }

      const data: OddsApiIoOddsResponse = await res.json();
      return this.parseOddsResponse(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`fetchEventOdds error for ${eventId}: ${message}`);
      return null;
    }
  }

  /**
   * Merge markets from a WS update into an existing SharpLine.
   */
  private mergeWsMarkets(
    line: SharpLine,
    markets: OddsApiIoMarket[],
  ): void {
    this.applyMarkets(line, markets);
    line.updatedAt = Date.now();
  }

  /**
   * Apply an array of odds-api.io markets to a SharpLine's markets object.
   * Used for both REST (parsed bookmaker markets) and WS (markets array).
   */
  private applyMarkets(line: SharpLine, markets: OddsApiIoMarket[]): void {
    for (const market of markets) {
      const odds = market.odds[0];
      if (!odds) continue;

      const name = market.name.toLowerCase();

      if (name === "ml") {
        if (odds.home != null && odds.away != null) {
          line.markets.h2h = {
            home: decimalToProb(parseFloat(odds.home)),
            away: decimalToProb(parseFloat(odds.away)),
            ...(odds.draw != null && {
              draw: decimalToProb(parseFloat(odds.draw)),
            }),
          };
        }
      } else if (name === "spread") {
        if (odds.home != null && odds.away != null) {
          line.markets.spreads = {
            home: decimalToProb(parseFloat(odds.home)),
            away: decimalToProb(parseFloat(odds.away)),
            point: odds.hdp ?? 0,
          };
        }
      } else if (name === "totals") {
        if (odds.over != null && odds.under != null) {
          line.markets.totals = {
            over: decimalToProb(parseFloat(odds.over)),
            under: decimalToProb(parseFloat(odds.under)),
            point: odds.hdp ?? 0,
          };
        }
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function decimalToProb(decimal: number): number {
  if (decimal <= 0) return 0;
  return 1 / decimal;
}
