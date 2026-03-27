# Polymarket Edge Bot

Detects mispriced sports markets on Polymarket by comparing live Polymarket prices against sharp sportsbook odds (configurable bookmaker via The Odds API). Bets when a statistically significant edge exists; exits positions when edge disappears.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — see required vars below
```

## Required env vars

```env
PRIVATE_KEY=0x...
FUNDER_ADDRESS=0x...          # Proxy/Safe wallet address
SIGNATURE_TYPE=2              # 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE

ODDS_API_KEY=...
ANTHROPIC_API_KEY=...         # Used for market matching (Haiku)
ODDS_API_SPORTS=basketball,football,american-football,tennis,baseball

DRY_RUN=true                  # Set false to enable live execution
```

See `.env.example` for full list with defaults.

## Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

## How it works

1. **Startup**: Fetches the funder wallet's USDC balance on-chain, active Polymarket sports markets, and sharp odds snapshots (bookmaker set via `BOOKMAKER_ID`) via REST, then opens persistent WebSocket connections to both Polymarket and The Odds API
2. **Market matching**: Maps Polymarket markets to Odds API events using a local cache; falls back to Claude Haiku for new/unmatched events
3. **Edge detection**: On every odds or price update, computes `edge = sharp_prob − polymarket_price`. Fires a trade signal when net edge exceeds the minimum threshold
4. **Sizing**: Quarter Kelly by default — `bet = bankroll × (edge / (1 − price)) × 0.25`
5. **Exits**: Checks open positions on every price update; sells when edge flips negative (market has corrected or overshot)
6. **Maintenance**: Every 5 minutes, refreshes market list, runs matcher on new events, resubscribes WebSocket to new token IDs, and re-fetches the on-chain USDC balance

## Architecture

```
odds-stream.ts    — Odds API WS + REST hydration → sharp odds cache
price-cache.ts    — Polymarket WS + REST hydration → live price cache
market-matcher.ts — Local cache + LLM fallback matching
edge-calculator.ts — Edge formula, Kelly sizing, cooldown
position-tracker.ts — Open position tracking, persisted to disk
coordinator.ts    — Wires all modules, routes signals
executor.ts       — Places orders via Polymarket CLOB
```

## Storage

No database. All state is in-memory with JSON file persistence in `./data/`:

- `match-table.json` — Polymarket ↔ Odds API event mappings
- `trades.jsonl` — Append-only edge/trade log for dry-run analysis

## Deploy

Long-running process on Railway. Use a Railway volume mounted at `/data/` so `match-table.json` and `trades.jsonl` survive deploys. Positions are hydrated live from the CLOB API on startup.
