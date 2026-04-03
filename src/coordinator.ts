// src/coordinator.ts
// Central event router. Listens to odds_update and price_update events,
// triggers edge calculations, manages exits, runs periodic maintenance.

import { ClobClient } from "@polymarket/clob-client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { OddsStream } from "./odds-stream.js";
import { PriceCache } from "./price-cache.js";
import {
  MarketMatcher,
  fetchPolymarketSportsMarkets,
} from "./market-matcher.js";
import {
  computeEdge,
  checkExit,
  isOnCooldown,
  markSignaled,
  logEdge,
} from "./edge-calculator.js";
import { PositionTracker } from "./position-tracker.js";
import { PendingOrders } from "./pending-orders.js";
import { PendingSignals } from "./pending-signals.js";
import { executeSignal } from "./executor.js";
import { getUsdcBalance } from "./wallet.js";
import { looseNameMatch } from "./team-knowledge.js";
import type {
  SharpLine,
  PriceEntry,
  MatchEntry,
  TradeSignal,
} from "./types.js";

const log = createLogger("coordinator");

export class Coordinator {
  private client: ClobClient;
  private odds: OddsStream;
  private prices: PriceCache;
  private matcher: MarketMatcher;
  private positions: PositionTracker;
  private pendingOrders: PendingOrders;
  private pendingSignals: PendingSignals;

  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private _bankroll: number;

  // Debounce: per-token pending edge check timers
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Consecutive ≤0 edge check counter per token (for underwater persistence exit)
  private negativeEdgeChecks = new Map<string, number>();

  private valueBetOnlyMode = false;

  // Bound event handlers (stored for targeted removal in destroy())
  private boundOnOddsUpdate = this.onOddsUpdate.bind(this);
  private boundOnPriceUpdate = this.onPriceUpdate.bind(this);

  constructor(
    client: ClobClient,
    odds: OddsStream,
    prices: PriceCache,
    matcher: MarketMatcher,
    positions: PositionTracker,
    pendingOrders: PendingOrders,
    pendingSignals: PendingSignals,
    initialBankroll: number,
  ) {
    this.client = client;
    this.odds = odds;
    this.prices = prices;
    this.matcher = matcher;
    this.positions = positions;
    this.pendingOrders = pendingOrders;
    this.pendingSignals = pendingSignals;
    this._bankroll = initialBankroll;
  }

  get bankroll(): number {
    return this._bankroll;
  }

  // ── Start / Stop ────────────────────────────────────────────────

  start(): void {
    log.info(`Starting coordinator (DRY_RUN=${config.dryRun})`);

    // Wire up event listeners
    this.odds.on("odds_update", this.boundOnOddsUpdate);
    this.prices.on("price_update", this.boundOnPriceUpdate);

    // Periodic maintenance
    this.maintenanceTimer = setInterval(
      () => this.runMaintenance(),
      config.maintenanceIntervalMs,
    );

    log.info("Coordinator listening for updates");
  }

  /**
   * Value-bet-only mode: skip WS-driven edge checks entirely.
   * Only ValueBetPoller can trigger signals via triggerEdgeEval().
   * Maintenance still runs so matches/positions stay fresh.
   */
  startValueBetOnly(): void {
    log.info(`Starting coordinator in value-bet-only mode (DRY_RUN=${config.dryRun})`);

    // No odds_update / price_update listeners — only ValueBetPoller fires signals.
    // Exit checks run during maintenance instead of on each price_update.
    this.valueBetOnlyMode = true;
    this.maintenanceTimer = setInterval(
      () => this.runMaintenance(),
      config.maintenanceIntervalMs,
    );

    log.info("Coordinator ready — awaiting value-bet signals");
  }

  destroy(): void {
    this.destroyed = true;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.odds.off("odds_update", this.boundOnOddsUpdate);
    this.prices.off("price_update", this.boundOnPriceUpdate);
    log.info("Coordinator stopped");
  }

  // ── Public API for external triggers ───────────────────────────

  /**
   * Called by ValueBetPoller when odds-api.io independently flags a market.
   * Bypasses the debounce and evaluates immediately so the confirmed signal
   * fires without delay. The reason is forwarded to the TradeSignal log so
   * we can later compare edge_detected vs value_bet_confirmed performance.
   */
  triggerEdgeEval(
    tokenId: string,
    match: MatchEntry,
    line: SharpLine,
    reason: "value_bet_confirmed",
  ): void {
    this.evaluateEdge(tokenId, match, line, reason);
  }

  /**
   * Called by ValueBetPoller in value-bet-only mode.
   * Trusts the external signal entirely — no edge recomputation.
   *
   * @param tokenId   Polymarket token to buy
   * @param match     MatchEntry for slug / token side lookup
   * @param bidPrice  Implied probability from bookmaker odds (= GTD limit price)
   * @param ev        Expected value from odds-api.io (used as edge proxy for Kelly)
   */
  placeValueBetSignal(
    tokenId: string,
    match: MatchEntry,
    bidPrice: number,
    ev: number,
  ): void {
    try {
      if (match.active === false) return;

      // Cooldown — don't double-fire on the same market within the window
      if (isOnCooldown(tokenId)) {
        log.debug(`Cooldown active for ${tokenId}, skipping value-bet signal`);
        return;
      }

      // Kelly sizing using EV as the net-edge proxy.
      // f* = ev / (1 - price)  ×  kellyFraction, capped at maxKellyPct
      const rawKelly = ev / (1 - bidPrice);
      const adjustedKelly = Math.min(rawKelly * config.kellyFraction, config.maxKellyPct);
      const suggestedUsdc = this._bankroll * adjustedKelly;

      const size = Math.round(suggestedUsdc / bidPrice);
      if (size < 1) {
        log.debug(`Value-bet signal too small (size=0) for ${match.slug}`);
        return;
      }

      const tokenSide = tokenId === match.tokenIds.yes ? "YES" : "NO";
      const signal: TradeSignal = {
        tokenId,
        slug: match.slug,
        side: "BUY",
        tokenSide,
        price: bidPrice,
        size,
        edge: ev,
        kellyFraction: rawKelly,
        reason: "value_bet_confirmed",
      };

      markSignaled(tokenId);

      // Store minimal metadata — no OddsStream line available in this path
      this.pendingSignals.store(tokenId, {
        tokenSide,
        match,
        line: null,
        sharpProb: null,
        netEdge: ev,
        kellyFraction: rawKelly,
      });

      this.dispatchSignal(signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`placeValueBetSignal error for ${tokenId}: ${message}`);
    }
  }

  // ── Event Handlers ──────────────────────────────────────────────

  /**
   * Odds API pushed a new line for an event.
   * Look up all matched Polymarket tokens for this event and check edge.
   */
  private onOddsUpdate(eventId: string, line: SharpLine): void {
    try {
      const matches = this.matcher.getMatchesByEvent(eventId);
      if (matches.length === 0) return;

      for (const match of matches) {
        // Check YES token
        this.scheduleEdgeCheck(match.tokenIds.yes, match, line);
        // Check NO token
        this.scheduleEdgeCheck(match.tokenIds.no, match, line);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`onOddsUpdate error for ${eventId}: ${message}`);
    }
  }

  /**
   * Polymarket WS pushed a new price for a token.
   * Look up the matched sharp line and check edge.
   * Also check open positions for exit signals.
   */
  private onPriceUpdate(tokenId: string, entry: PriceEntry): void {
    try {
      // Find which match this token belongs to
      const match = this.findMatchByToken(tokenId);
      if (match) {
        const line = this.odds.getLine(match.oddsApiEventId);
        if (line) {
          this.scheduleEdgeCheck(tokenId, match, line);
        }
      }

      // Exit check on any open position for this token
      this.checkExitForToken(tokenId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`onPriceUpdate error for ${tokenId}: ${message}`);
    }
  }

  // ── Debounced Edge Check ────────────────────────────────────────

  /**
   * Schedule an edge check with debounce. If both sides update within
   * debounceMs, only one calculation fires.
   */
  private scheduleEdgeCheck(
    tokenId: string,
    match: MatchEntry,
    line: SharpLine,
  ): void {
    // Clear any pending timer for this token
    const existing = this.debounceTimers.get(tokenId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(tokenId);
      this.evaluateEdge(tokenId, match, line);
    }, config.debounceMs);

    this.debounceTimers.set(tokenId, timer);
  }

  /**
   * Actually compute edge and potentially fire a trade signal.
   */
  private evaluateEdge(
    tokenId: string,
    match: MatchEntry,
    line: SharpLine,
    reason: "edge_detected" | "value_bet_confirmed" = "edge_detected",
  ): void {
    try {
      // Skip resolved/closed markets
      if (match.active === false) return;

      // Determine which sharp prob to use based on which token this is
      const sharpProb = this.getSharpProbForToken(tokenId, match, line);
      if (sharpProb === null) return;

      // Get current Polymarket price
      const priceEntry = this.prices.getPrice(tokenId);
      if (!priceEntry) return;

      // Skip if no real book data yet (REST hydration only has last trade price)
      if (!priceEntry.hasBook) {
        log.debug(`Skipping ${tokenId}: no real book data yet`);
        return;
      }

      // Compute edge — position cap is per-market (both YES + NO tokens).
      // Include pending (unfilled) order notional to avoid over-sizing.
      const yesCost = this.positions.getPositionCost(match.tokenIds.yes);
      const noCost = this.positions.getPositionCost(match.tokenIds.no);
      const yesPending = this.pendingOrders.getTokenNotional(
        match.tokenIds.yes,
      );
      const noPending = this.pendingOrders.getTokenNotional(match.tokenIds.no);
      const existingPosition = yesCost + noCost + yesPending + noPending;

      // Event-level exposure: sum positions across all markets for this event
      const existingEventExposure = this.computeEventExposure(
        match.oddsApiEventId,
      );

      const fillPrice = priceEntry.bestAsk;

      const result = computeEdge({
        sharpProb,
        polyPrice: priceEntry.price,
        takerPrice: fillPrice, // maker: midpoint; taker: best ask
        sportKey: match.sportKey,
        bankroll: this._bankroll,
        existingPosition,
        existingEventExposure,
      });

      // Always log the edge check (persisted for dry-run analysis)
      logEdge(tokenId, match.slug, sharpProb, priceEntry.price, result);

      if (!result.tradeable) {
        // When odds-api.io flagged this as a value bet but our calc disagrees,
        // record the rejection so we can compare sources in post-analysis.
        if (reason === "value_bet_confirmed") {
          log.record("VALUE_BET_REJECTED", {
            tokenId,
            slug: match.slug,
            sharpProb,
            polyPrice: priceEntry.price,
            grossEdge: result.grossEdge,
            netEdge: result.netEdge,
            skipReason: result.skipReason ?? "below_min_edge",
          });
        }
        return;
      }

      // Cooldown check
      if (isOnCooldown(tokenId)) {
        if (reason === "value_bet_confirmed") {
          log.record("VALUE_BET_REJECTED", {
            tokenId,
            slug: match.slug,
            sharpProb,
            polyPrice: priceEntry.price,
            grossEdge: result.grossEdge,
            netEdge: result.netEdge,
            skipReason: "cooldown_active",
          });
        }
        log.debug(`Cooldown active for ${tokenId}, skipping signal`);
        return;
      }

      // Build trade signal
      // Maker mode: price is midpoint (executor will snap to bestBid + tick)
      // Taker mode: price is bestAsk (cross the spread)
      const size = Math.round(result.suggestedSize / fillPrice);
      if (size < 1) return;
      const tokenSide = tokenId === match.tokenIds.yes ? "YES" : "NO";
      const signal: TradeSignal = {
        tokenId,
        slug: match.slug,
        side: "BUY",
        tokenSide,
        price: fillPrice,
        size,
        edge: result.netEdge,
        kellyFraction: result.kellyFraction,
        reason,
      };

      markSignaled(tokenId);

      // Stash signal metadata — entry will be logged on confirmed fill (user-stream)
      this.pendingSignals.store(tokenId, {
        tokenSide,
        match,
        line,
        sharpProb,
        netEdge: result.netEdge,
        kellyFraction: result.kellyFraction,
      });

      this.dispatchSignal(signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Edge evaluation error for ${tokenId}: ${message}`);
    }
  }

  // ── Exit Checks ─────────────────────────────────────────────────

  private checkExitForToken(tokenId: string): void {
    try {
      const position = this.positions.getPosition(tokenId);
      if (!position) return;

      // Find match for this position
      const match = this.findMatchByToken(tokenId);
      if (!match) return;

      // Skip resolved/closed markets
      if (match.active === false) return;

      const line = this.odds.getLine(match.oddsApiEventId);
      if (!line) return;

      const sharpProb = this.getSharpProbForToken(tokenId, match, line);
      if (sharpProb === null) return;

      const priceEntry = this.prices.getPrice(tokenId);
      if (!priceEntry) return;

      // Skip exit if best bid is below minimum price — market has effectively
      // resolved and a FOK sell order will always fail with no liquidity.
      if (priceEntry.bestBid < config.minPrice) return;

      const consecutiveNegativeEdgeChecks =
        this.negativeEdgeChecks.get(tokenId) ?? 0;
      const exitResult = checkExit({
        position,
        currentPrice: priceEntry.price,
        bestBid: priceEntry.bestBid, // selling → receive the bid
        sharpProb,
        sharpProbUpdatedAt: line.updatedAt,
        sportKey: match.sportKey,
        consecutiveNegativeEdgeChecks,
      });

      // Track consecutive non-positive edge checks
      const exitFeeApprox =
        priceEntry.bestBid *
        priceEntry.bestBid *
        (1 - priceEntry.bestBid) *
        0.03;
      const currentEdge = sharpProb - priceEntry.bestBid - exitFeeApprox;
      if (currentEdge <= 0) {
        this.negativeEdgeChecks.set(tokenId, consecutiveNegativeEdgeChecks + 1);
      } else {
        this.negativeEdgeChecks.delete(tokenId);
      }

      if (!exitResult.shouldExit) return;

      log.record("EXIT SIGNAL", {
        tokenId,
        slug: match.slug,
        avgPrice: position.avgPrice,
        currentPrice: priceEntry.price,
        sharpProb,
        edge: exitResult.edge,
        profitPerShare: exitResult.profitPerShare,
        ...(exitResult.reason && { reason: exitResult.reason }),
      });

      // Cooldown check for exits too
      if (isOnCooldown(tokenId)) {
        log.debug(`Cooldown active for exit on ${tokenId}, skipping`);
        return;
      }

      // For sells: use bestBid as the exit price (what we receive as taker).
      // Floor the size — CLOB only accepts whole integer shares for sells.
      const sellSize = Math.floor(position.size);
      if (sellSize < 1) return;

      const signal: TradeSignal = {
        tokenId,
        slug: match.slug,
        side: "SELL",
        tokenSide: tokenId === match.tokenIds.yes ? "YES" : "NO",
        price: priceEntry.bestBid,
        size: sellSize,
        edge: exitResult.edge,
        kellyFraction: 0,
        reason: "exit_signal",
      };

      markSignaled(tokenId);
      this.negativeEdgeChecks.delete(tokenId);
      this.dispatchSignal(signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Exit check error for ${tokenId}: ${message}`);
    }
  }

  private checkAllExits(): void {
    const positions = this.positions.getAllPositions();
    if (positions.length === 0) return;
    log.debug(`Exit sweep: checking ${positions.length} open position(s)`);
    for (const position of positions) {
      this.checkExitForToken(position.tokenId);
    }
  }

  // ── Signal Dispatch ─────────────────────────────────────────────

  private dispatchSignal(signal: TradeSignal): void {
    log.record(`SIGNAL ${signal.side}`, {
      tokenId: signal.tokenId,
      slug: signal.slug,
      side: signal.side,
      price: signal.price,
      size: signal.size,
      edge: signal.edge,
      kellyFraction: signal.kellyFraction,
      reason: signal.reason,
      dryRun: config.dryRun,
    });

    if (config.dryRun) {
      log.info(
        `[DRY RUN] Would ${signal.side} ${signal.size} shares of ${signal.slug} @ ${signal.price.toFixed(4)} (edge=${(signal.edge * 100).toFixed(2)}%)`,
      );
      return;
    }

    // Fire and forget — executor handles its own error logging
    executeSignal(
      this.client,
      signal,
      this.pendingOrders,
      this.positions,
    ).catch((err) => log.error(`Executor dispatch error: ${err.message}`));
  }

  // ── Maintenance ─────────────────────────────────────────────────

  private async runMaintenance(): Promise<void> {
    if (this.destroyed) return;

    log.info("Running maintenance cycle...");

    try {
      // 1. Re-hydrate odds from REST every hour (WS is delta-only)
      if (Date.now() - this.odds.lastHydrateAt >= 60 * 60_000) {
        log.info("Re-hydrating odds from REST (hourly)...");
        await this.odds.rehydrate();
      }

      // 2. Refresh Polymarket sports markets from Gamma
      const polymarkets = await fetchPolymarketSportsMarkets();
      log.info(
        `Fetched ${polymarkets.length} active sports markets from Gamma`,
      );

      // 2. Re-hydrate team knowledge (picks up new leagues / team changes)
      await this.matcher.hydrateTeams(config.gammaLeagues);

      // 3. Run matcher on new/unmatched markets
      const { newMatches, total } = await this.matcher.runMatchCycle(
        this.odds.getAllLines(),
        polymarkets,
      );
      if (newMatches > 0) {
        log.info(`Matcher found ${newMatches} new match(es) (${total} total)`);
      }

      // 2b. Refresh active status for all existing matches
      this.matcher.updateActiveStatus(polymarkets);

      // 3. Subscribe to any new token IDs on price cache
      const allTokenIds = this.matcher.getAllTokenIds();
      this.prices.addTokens(allTokenIds);

      // 4. Re-sync positions from Data API (corrects any WS drift)
      await this.positions.hydrate();

      // 5. Refresh bankroll from on-chain balance
      const freshBalance = await getUsdcBalance();
      if (freshBalance !== null) {
        this._bankroll = freshBalance;
      }

      // 6. Prune expired matches
      this.matcher.pruneExpired();

      // 7. Prune expired pending orders (GTD 5-min TTL)
      this.pendingOrders.pruneExpired();

      // 8. Prune expired pending signals (unfilled GTD orders)
      this.pendingSignals.pruneExpired();

      // 9. In value-bet-only mode, check all open positions for exit signals
      //    (replaces the WS-driven per-price-update exit check)
      if (this.valueBetOnlyMode) {
        this.checkAllExits();
      }

      log.info(
        `Maintenance complete: odds=${this.odds.size} events, prices=${this.prices.size} tokens, matches=${this.matcher.size}, positions=${this.positions.size}, pending=${this.pendingOrders.size}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Maintenance error: ${message}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Find which MatchEntry a token ID belongs to.
   */
  private findMatchByToken(tokenId: string): MatchEntry | null {
    return this.matcher.getMatchByToken(tokenId);
  }

  /**
   * Sum position cost + pending notional across all markets for one event.
   */
  private computeEventExposure(eventId: string): number {
    const siblings = this.matcher.getMatchesByEvent(eventId);
    let total = 0;
    for (const m of siblings) {
      total += this.positions.getPositionCost(m.tokenIds.yes);
      total += this.positions.getPositionCost(m.tokenIds.no);
      total += this.pendingOrders.getTokenNotional(m.tokenIds.yes);
      total += this.pendingOrders.getTokenNotional(m.tokenIds.no);
    }
    return total;
  }

  /**
   * Get the sharp probability relevant to a specific token ID.
   * Uses the direct probability for each side (no 1-p complement)
   * to avoid vig distortion from the bookmaker's overround.
   */
  private getSharpProbForToken(
    tokenId: string,
    match: MatchEntry,
    line: SharpLine,
  ): number | null {
    const isYesToken = tokenId === match.tokenIds.yes;
    const marketData = line.markets[match.marketType];
    if (!marketData) return null;

    if (match.marketType === "h2h") {
      const h2h = marketData as { home: number; away: number; draw?: number };
      const yesTeam = match.outcomeMap.Yes;
      // Use loose match — Gamma uses short names ("Mavericks") while Odds API
      // uses full names ("Dallas Mavericks")
      const yesIsHome = looseNameMatch(yesTeam, line.homeTeam);
      if (isYesToken) {
        return yesIsHome ? h2h.home : h2h.away;
      } else {
        return yesIsHome ? h2h.away : h2h.home;
      }
    }

    if (match.marketType === "spreads") {
      const allSpreads = marketData as {
        home: number;
        away: number;
        point: number;
      }[];
      const spreads = findByPoint(allSpreads, match.point);
      if (!spreads) {
        log.warn(
          `No spread line at point=${match.point} for ${match.slug} (available: ${allSpreads.map((s) => s.point).join(", ")})`,
        );
        return null;
      }
      const yesIsHome = looseNameMatch(match.outcomeMap.Yes, line.homeTeam);
      if (isYesToken) {
        return yesIsHome ? spreads.home : spreads.away;
      } else {
        return yesIsHome ? spreads.away : spreads.home;
      }
    }

    if (match.marketType === "totals") {
      const allTotals = marketData as {
        over: number;
        under: number;
        point: number;
      }[];
      const totals = findByPoint(allTotals, match.point);
      if (!totals) {
        log.warn(
          `No totals line at point=${match.point} for ${match.slug} (available: ${allTotals.map((t) => t.point).join(", ")})`,
        );
        return null;
      }
      const yesIsOver = match.outcomeMap.Yes.toLowerCase().includes("over");
      if (!yesIsOver && !match.outcomeMap.Yes.toLowerCase().includes("under")) {
        log.warn(
          `Cannot determine Over/Under mapping for ${match.slug}, outcomeMap.Yes="${match.outcomeMap.Yes}"`,
        );
        return null;
      }
      if (isYesToken) {
        return yesIsOver ? totals.over : totals.under;
      } else {
        return yesIsOver ? totals.under : totals.over;
      }
    }

    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Find a spread/totals line whose .point matches the target within 0.05.
 * Tries exact match first, then negated target to handle sign convention
 * differences between Polymarket points (often unsigned) and Betfair hdp
 * (signed, from home team's perspective).
 */
function findByPoint<T extends { point: number }>(
  lines: T[],
  target: number | undefined,
): T | undefined {
  if (target == null || lines.length === 0) return undefined;
  return (
    lines.find((l) => Math.abs(l.point - target) < 0.05) ??
    lines.find((l) => Math.abs(l.point + target) < 0.05)
  );
}
