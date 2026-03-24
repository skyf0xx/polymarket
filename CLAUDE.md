# Polymarket Edge Detection Bot

TypeScript bot that detects mispriced sports markets on Polymarket by comparing against sportsbook lines (via The Odds API), then places Kelly-sized bets via the Polymarket CLOB.

## Architecture

Fully event-driven — no polling loop. Two persistent WebSocket connections feed a central coordinator:

- **`odds-stream.ts`** — The Odds API WS + REST hydration → emits `odds_update`
- **`price-cache.ts`** — Polymarket WS + REST hydration → emits `price_update`
- **`coordinator.ts`** — Routes updates, triggers edge calc, manages exit checks, runs maintenance timer
- **`market-matcher.ts`** — Maps Polymarket slugs to Odds API events (local cache + Haiku LLM fallback)
- **`edge-calculator.ts`** — `sharpProb - polyPrice`, fee adjustment, Kelly sizing, cooldown state
- **`position-tracker.ts`** — Open positions persisted to `data/positions.json`
- **`executor.ts`** — orders via `@polymarket/clob-client`
- **`index.ts`** — Entry point: init CLOB client → hydrate → match → start coordinator

## Key Constraints

**Wallet setup:** MetaMask EOA as signer, Safe proxy wallet as funder. `FUNDER_ADDRESS` must be the proxy wallet. `SIGNATURE_TYPE=2` for Gnosis Safe.

**`tickSize` is a `TickSize` type** from `@polymarket/clob-client` — pass it directly to `createAndPostOrder`, don't convert to number until needed for arithmetic.

**Polymarket Data API vs CLOB SDK:** The activity feed returns a different shape than the SDK's `Trade` type. Use custom types.

## Edge & Sizing

```
gross_edge = sharp_prob - polymarket_price
fee = 0.03 × price² × (1 - price)    // all sports markets
net_edge = gross_edge - fee
kelly_fraction = net_edge / (1 - price)
bet_size = bankroll × kelly_fraction × KELLY_FRACTION  // default 0.25 (quarter Kelly)
bet_size = min(bet_size, liquidity_cap, position_cap)
```

Minimum net edge to trade: `MIN_EDGE` (default 2%). Per-market cooldown after signal: `COOLDOWN_SECONDS` (default 30s).

## Data Persistence

No database. In-memory Maps backed by JSON files in `data/` (Railway volume mount):

- `data/match-table.json` — Polymarket slug ↔ Odds API event ID mappings
- `data/positions.json` — open positions for exit logic + sizing caps
- `data/trades.jsonl` — append-only edge/trade log for dry-run validation

## Environment

See `env_example.txt` for all vars. Key ones:

- `DRY_RUN=true` — log signals only, no execution (default)
- Bankroll is fetched on-chain from the funder wallet's USDC balance at startup and refreshed every maintenance cycle
- `SPORTS` — comma-separated Odds API sport keys (e.g. `basketball_nba,soccer_epl`)
- `ANTHROPIC_API_KEY` — used by market-matcher for Haiku LLM matching only

## Dependencies

```
@polymarket/clob-client   ethers@5   ws   eventemitter3   @anthropic-ai/sdk
```
