// src/price-cache.ts
// Manages Polymarket WebSocket connection for live prices.
// Maintains Map<tokenId, PriceEntry> and emits 'price_update' events.
// No REST hydration — subscribes with initial_dump=true so the WS sends
// a full book snapshot for each token on connect.

import WebSocket from "ws";
import { EventEmitter } from "eventemitter3";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { PriceEntry } from "./types.js";

const log = createLogger("price-cache");

// ── Polymarket WS Message Types ─────────────────────────────────

interface BookLevel {
  price: string;
  size: string;
}

interface WsBook {
  event_type: "book";
  asset_id: string;
  market: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: string;
}

interface PriceChangeItem {
  asset_id: string;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  best_bid: string;
  best_ask: string;
}

interface WsPriceChange {
  event_type: "price_change";
  market: string;
  price_changes: PriceChangeItem[];
  timestamp: string;
}

interface WsLastTradePrice {
  event_type: "last_trade_price";
  asset_id: string;
  market: string;
  price: string;
  side: "BUY" | "SELL";
  timestamp: string;
}

type PolymarketWsMessage =
  | WsBook
  | WsPriceChange
  | WsLastTradePrice
  | { event_type: string };

// ── Events emitted ───────────────────────────────────────────────

interface PriceCacheEvents {
  price_update: (tokenId: string, entry: PriceEntry) => void;
  connected: () => void;
  disconnected: () => void;
}

export class PriceCache extends EventEmitter<PriceCacheEvents> {
  private cache = new Map<string, PriceEntry>();
  private subscribedTokens = new Set<string>();
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 60_000;
  private destroyed = false;

  // ── Public API ──────────────────────────────────────────────────

  /** Get current price for a token. */
  getPrice(tokenId: string): PriceEntry | undefined {
    return this.cache.get(tokenId);
  }

  /** Get all cached prices. */
  getAllPrices(): Map<string, PriceEntry> {
    return this.cache;
  }

  get size(): number {
    return this.cache.size;
  }

  /** Start with initial set of token IDs. Connect WS and subscribe (initial_dump gives snapshots). */
  start(tokenIds: string[]): void {
    for (const id of tokenIds) this.subscribedTokens.add(id);
    if (tokenIds.length === 0) {
      log.info(
        "No tokens to subscribe — deferring WS connection until tokens are added",
      );
      return;
    }
    this.connectWs();
  }

  /** Subscribe to additional tokens (e.g. after new matches found). */
  addTokens(tokenIds: string[]): void {
    const newIds = tokenIds.filter((id) => !this.subscribedTokens.has(id));
    if (newIds.length === 0) return;

    for (const id of newIds) this.subscribedTokens.add(id);

    // Connect WS if not yet started, otherwise subscribe on existing connection
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connectWs();
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(newIds);
    }
  }

  /** Clean shutdown. */
  destroy(): void {
    this.destroyed = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── WebSocket Connection ────────────────────────────────────────

  private connectWs(): void {
    if (this.destroyed) return;

    log.info("Connecting Polymarket WS...");

    this.ws = new WebSocket(config.polyWsUrl);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      log.info("Polymarket WS connected");
      this.emit("connected");

      // Subscribe to all tracked tokens
      const tokens = [...this.subscribedTokens];
      if (tokens.length > 0) {
        this.sendSubscribe(tokens);
      }

      // Start heartbeat
      this.startHeartbeat();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      const text = raw.toString();
      if (text === "PONG") return;
      try {
        const parsed = JSON.parse(text);
        // Polymarket WS wraps messages in an array: [{event_type: "book", ...}]
        const msgs: PolymarketWsMessage[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of msgs) {
          this.handleMessage(msg);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to parse WS message: ${message}`);
      }
    });

    this.ws.on("close", (code, reason) => {
      log.warn(`Polymarket WS closed: code=${code} reason=${reason}`);
      this.stopHeartbeat();
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`Polymarket WS error: ${err.message}`);
    });
  }

  private sendSubscribe(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = JSON.stringify({
      type: "market",
      assets_ids: tokenIds,
      initial_dump: true,
      level: 2,
      custom_feature_enabled: false,
    });
    this.ws.send(msg);
    log.debug(`Subscribed to ${tokenIds.length} token(s)`);
  }

  private handleMessage(msg: PolymarketWsMessage): void {
    switch (msg.event_type) {
      case "price_change": {
        const pc = msg as WsPriceChange;
        for (const change of pc.price_changes) {
          if (!this.subscribedTokens.has(change.asset_id)) continue;
          const bid = parseFloat(change.best_bid);
          const ask = parseFloat(change.best_ask);
          if (bid > 0 || ask > 0) {
            this.updateCache(change.asset_id, bid, ask);
          }
        }
        break;
      }

      case "last_trade_price": {
        const ltp = msg as WsLastTradePrice;
        if (!this.subscribedTokens.has(ltp.asset_id)) break;
        const price = parseFloat(ltp.price);
        if (price > 0) {
          // No bid/ask available — use last trade as both sides (conservative fallback)
          const existing = this.cache.get(ltp.asset_id);
          this.updateCache(
            ltp.asset_id,
            existing?.bestBid ?? price,
            existing?.bestAsk ?? price,
          );
        }
        break;
      }

      case "book": {
        const book = msg as WsBook;
        if (!this.subscribedTokens.has(book.asset_id)) break;
        // Bids/asks are NOT guaranteed sorted by the API — find best manually
        const bid = bestPrice(book.bids, "max");
        const ask = bestPrice(book.asks, "min");
        if (bid > 0 || ask > 0) {
          this.updateCache(book.asset_id, bid, ask);
        }
        break;
      }

      default:
        break;
    }
  }

  private updateCache(tokenId: string, bestBid: number, bestAsk: number): void {
    const price =
      bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const entry: PriceEntry = {
      tokenId,
      price,
      bestBid,
      bestAsk,
      hasBook: true,
      updatedAt: Date.now(),
    };
    this.cache.set(tokenId, entry);
    this.emit("price_update", tokenId, entry);
  }

  // ── Heartbeat ───────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("PING");
      }
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ── Reconnection ────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    const delay = Math.min(
      1_000 * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;

    log.info(
      `Reconnecting Polymarket WS in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );

    setTimeout(() => {
      this.connectWs();
    }, delay);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Find the best price from an unsorted array of book levels. */
function bestPrice(levels: BookLevel[], side: "max" | "min"): number {
  if (levels.length === 0) return 0;
  let best = parseFloat(levels[0].price);
  for (let i = 1; i < levels.length; i++) {
    const p = parseFloat(levels[i].price);
    if (side === "max" ? p > best : p < best) best = p;
  }
  return best;
}
