// src/user-stream.ts
// Authenticated WebSocket for real-time order and trade updates.
// Listens for MATCHED trades and records them in the position tracker.

import WebSocket from "ws";
import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { PositionTracker } from "./position-tracker.js";
import { MarketMatcher } from "./market-matcher.js";

const log = createLogger("user-stream");
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

interface TradeEvent {
  event_type: "trade";
  type: "TRADE";
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  status: string;
  owner: string;
  timestamp: string;
  [key: string]: unknown;
}

export class UserStream {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  private creds: ApiCreds;
  private lastTradeTimestamp = 0; // tracks latest processed trade for catch-up

  constructor(
    private readonly positions: PositionTracker,
    private readonly matcher: MarketMatcher,
    credsFile: string,
  ) {
    this.creds = JSON.parse(readFileSync(credsFile, "utf-8")) as ApiCreds;
  }

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

  // ── WebSocket Connection ─────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;

    log.info("Connecting user WS...");
    this.ws = new WebSocket(config.userWsUrl);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      log.info("User WS connected");
      this.sendAuth();
      this.startPing();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      const text = raw.toString();
      log.info(`User WS raw message: ${text}`);
      if (text === "PONG") return;

      let events: unknown[];
      try {
        const msg = JSON.parse(text);
        events = Array.isArray(msg) ? msg : [msg];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to parse user WS message: ${message}`);
        return;
      }

      for (const event of events) {
        try {
          this.handleEvent(event);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`Failed to process trade event: ${message}`, {
            event: event as Record<string, unknown>,
          });
        }
      }
    });

    this.ws.on("close", (code, reason) => {
      log.warn(`User WS closed: code=${code} reason=${reason}`);
      this.clearPing();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`User WS error: ${err.message}`);
    });
  }

  private sendAuth(): void {
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const message = timestamp + "GET" + "/ws/user";
    const base64Secret = Buffer.from(this.creds.secret, "base64");
    const sig = createHmac("sha256", base64Secret)
      .update(message)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const payload = {
      type: "user",
      auth: {
        apiKey: this.creds.key,
        secret: this.creds.secret,
        passphrase: this.creds.passphrase,
        timestamp,
        signature: sig,
      },
    };
    log.info(`Sending auth: ts=${timestamp} sig=${sig.slice(0, 3)}...`);
    this.ws?.send(JSON.stringify(payload));
  }

  // ── Ping / Keepalive ─────────────────────────────────────────────

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

  // ── Message Handling ─────────────────────────────────────────────

  private handleEvent(event: unknown): void {
    if (
      typeof event !== "object" ||
      event === null ||
      (event as Record<string, unknown>).event_type !== "trade"
    ) {
      return;
    }

    const trade = event as TradeEvent;

    if (trade.status !== "MATCHED") return;

    const tokenId = trade.asset_id;
    const size = Number(trade.size);
    const price = Number(trade.price);

    if (!tokenId || Number.isNaN(size) || Number.isNaN(price)) {
      log.warn("Received trade event with invalid fields", { trade });
      return;
    }

    const tradeTs = new Date(trade.timestamp).getTime();
    if (tradeTs > this.lastTradeTimestamp) {
      this.lastTradeTimestamp = tradeTs;
    }

    log.info(`Trade MATCHED: ${trade.side} ${size} @ ${price}`, {
      tradeId: trade.id,
      tokenId,
    });

    if (trade.side === "BUY") {
      const existing = this.positions.getPosition(tokenId);
      if (existing) {
        // Adding to an existing position
        this.positions.recordBuy(
          tokenId,
          existing.slug,
          existing.side,
          price,
          size,
        );
      } else {
        // New position — look up match to get slug and token side
        const match = this.findMatchForToken(tokenId);
        if (!match) {
          log.warn(
            `BUY trade matched for unmatched token, cannot record: ${tokenId}`,
          );
          return;
        }
        const tokenSide = tokenId === match.tokenIds.yes ? "YES" : "NO";
        this.positions.recordBuy(tokenId, match.slug, tokenSide, price, size);
      }
    } else {
      this.positions.recordSell(tokenId, price, size);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private findMatchForToken(tokenId: string) {
    return this.matcher.getMatchByToken(tokenId);
  }

  // ── REST Trade Catch-Up ─────────────────────────────────────────

  /**
   * Fetch recent trades from CLOB REST API and replay any MATCHED trades
   * that occurred after our last processed timestamp (i.e. during WS outage).
   */
  private async catchUpMissedTrades(): Promise<void> {
    if (this.lastTradeTimestamp === 0) return; // no baseline — first connect

    try {
      const res = await fetch(
        `${config.clobApiUrl}/trades?maker_address=${config.funderAddress}&limit=100`,
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      if (!res.ok) {
        log.warn(`Trade catch-up: REST returned ${res.status}`);
        return;
      }

      interface RestTrade {
        id?: string;
        taker_order_id?: string;
        market?: string;
        asset_id?: string;
        side: "BUY" | "SELL";
        size: string | number;
        price: string | number;
        status?: string;
        owner?: string;
        created_at?: string;
        match_time?: string;
      }

      const trades: RestTrade[] = await res.json();
      let caught = 0;

      for (const t of trades) {
        const ts = new Date(t.created_at ?? t.match_time ?? 0).getTime();
        if (ts <= this.lastTradeTimestamp) continue;
        if (t.status !== "MATCHED") continue;

        const synthetic: TradeEvent = {
          event_type: "trade",
          type: "TRADE",
          id: t.id ?? "",
          taker_order_id: t.taker_order_id ?? "",
          market: t.market ?? "",
          asset_id: t.asset_id ?? "",
          side: t.side,
          size: String(t.size),
          price: String(t.price),
          status: "MATCHED",
          owner: t.owner ?? "",
          timestamp: t.created_at ?? t.match_time ?? new Date().toISOString(),
        };

        this.handleEvent(synthetic);
        caught++;
      }

      if (caught > 0) {
        log.info(`Trade catch-up: replayed ${caught} missed trade(s)`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Trade catch-up error: ${message}`);
    }
  }

  // ── Reconnection ─────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    const delay = Math.min(
      1_000 * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt++;

    log.info(
      `User WS reconnecting in ${(delay / 1_000).toFixed(1)}s (attempt ${this.reconnectAttempt})`,
    );
    setTimeout(async () => {
      try {
        await this.catchUpMissedTrades();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Trade catch-up failed on reconnect: ${message}`);
      }
      this.connect();
    }, delay);
  }
}
