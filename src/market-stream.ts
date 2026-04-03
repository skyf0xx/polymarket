// src/market-stream.ts
// Public WebSocket for real-time market lifecycle events.
// Handles new_market (feeds matcher) and market_resolved (marks inactive).

import WebSocket from "ws";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { MarketMatcher } from "./market-matcher.js";
import type { PolymarketMarket } from "./types.js";

const log = createLogger("market-stream");
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

interface NewMarketEvent {
  event_type: "new_market";
  slug: string;
  question: string;
  market: string; // condition ID
  assets_ids: string[];
  outcomes: string[];
  active?: boolean;
  clob_token_ids?: string[];
  sports_market_type?: string;
  game_start_time?: string;
  group_item_title?: string;
  order_price_min_tick_size?: string;
  tags?: string[];
}

interface MarketResolvedEvent {
  event_type: "market_resolved";
  market: string; // condition ID
  assets_ids: string[];
  winning_asset_id: string;
  winning_outcome: string;
}

export class MarketStream {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  constructor(private readonly matcher: MarketMatcher) {}

  start(): void {
    this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.destroyed) return;

    log.info("Connecting market WS...");
    this.ws = new WebSocket(MARKET_WS_URL);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      log.info("Market WS connected");
      this.subscribe();
      this.startPing();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      const text = raw.toString();
      if (text === "PONG") return;

      let events: unknown[];
      try {
        const msg = JSON.parse(text);
        events = Array.isArray(msg) ? msg : [msg];
      } catch {
        return;
      }

      for (const event of events) {
        try {
          this.handleEvent(event);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Market WS event error: ${message}`);
        }
      }
    });

    this.ws.on("close", (code, reason) => {
      log.warn(`Market WS closed: code=${code} reason=${reason}`);
      this.clearPing();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`Market WS error: ${err.message}`);
    });
  }

  private subscribe(): void {
    // Subscribe with a dummy asset ID to receive global new_market / market_resolved
    // events. custom_feature_enabled enables those event types.
    const payload = {
      type: "market",
      assets_ids: [],
      initial_dump: false,
      custom_feature_enabled: true,
    };
    this.ws?.send(JSON.stringify(payload));
  }

  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, unknown>;

    if (e.event_type === "new_market") {
      this.handleNewMarket(e as unknown as NewMarketEvent);
    } else if (e.event_type === "market_resolved") {
      this.handleMarketResolved(e as unknown as MarketResolvedEvent);
    }
  }

  private handleNewMarket(e: NewMarketEvent): void {
    // Only care about sports markets — filter by sports_market_type presence
    // or configured tag IDs (tags array contains sport tag names).
    const tokenIds = e.clob_token_ids ?? e.assets_ids;
    if (tokenIds.length < 2) return;

    const pm: PolymarketMarket = {
      slug: e.slug,
      question: e.question,
      outcomes: e.outcomes,
      outcomePrices: e.outcomes.map(() => "0.5"),
      tokenIds,
      endDate: e.game_start_time ?? "",
      active: e.active ?? true,
      closed: false,
      acceptingOrders: true,
      groupItemTitle: e.group_item_title,
      conditionId: e.market,
    };

    log.info(`New market via WS: ${e.slug}`);
    this.matcher.addMarket(pm);

    // Trigger a match attempt immediately with current odds events
    this.matcher.runMatchCycle([pm]).catch((err: Error) => {
      log.warn(`Match cycle for new market failed: ${err.message}`);
    });
  }

  private handleMarketResolved(e: MarketResolvedEvent): void {
    log.info(`Market resolved via WS: conditionId=${e.market} winner=${e.winning_outcome}`);
    for (const tokenId of e.assets_ids) {
      this.matcher.markResolvedByTokenId(tokenId);
    }
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("PING");
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = Math.min(
      1_000 * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt++;
    log.info(`Market WS reconnecting in ${(delay / 1_000).toFixed(1)}s (attempt ${this.reconnectAttempt})`);
    setTimeout(() => this.connect(), delay);
  }
}

