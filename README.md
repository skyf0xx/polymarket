# Polymarket Edge Bot

Detects mispriced sports markets on Polymarket using value-bet signals from The Odds API. Buys when a statistically significant edge exists; exits positions when the signal disappears.

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

1. **Startup**: Fetches the funder wallet's USDC balance on-chain, hydrates team knowledge and open positions, fetches active Polymarket sports markets from Gamma API
2. **Polling**: Every 30s, polls `/v3/value-bets?bookmaker=Polymarket` for markets with positive expected value. Extracts odds event details and feeds them to the matcher
3. **Market matching**: Maps Polymarket markets to Odds API events using team knowledge (deterministic); falls back to Claude Haiku for new/unmatched events
4. **Sizing**: Quarter Kelly by default — `bet = bankroll × (edge / (1 − price)) × 0.25`, capped at `MAX_KELLY_PCT`
5. **Exits**: Every 5 minutes, checks open positions. If the value-bet signal disappears (event no longer in `/v3/value-bets`), evaluates P&L thresholds: take profit, cut loss, lock gains, or exit after prolonged absence
6. **Maintenance**: Every 5 minutes, refreshes Gamma markets, re-syncs positions from Data API, refreshes on-chain USDC balance, prunes expired matches

## Architecture

```
poller.ts          — Polls /v3/value-bets, sizes signals, feeds odds events to matcher
market-matcher.ts  — Deterministic + LLM fallback matching (Polymarket ↔ Odds API)
team-knowledge.ts  — Team abbreviation resolution, h2h outcomeMap cache
exits.ts           — Exit logic: value-bet presence check + P&L thresholds
executor.ts        — GTD/FAK order placement via Polymarket CLOB
user-stream.ts     — Authenticated WS for fill confirmations
position-tracker.ts — Open position tracking (Data API + WS updates)
order-tracker.ts   — Resting orders + signal metadata
```

## Storage

No database. All state is in-memory with JSON file persistence in `./data/`:

- `match-table.json` — Polymarket ↔ Odds API event mappings
- `team-knowledge.json` — Team abbreviations + h2h outcomeMap cache
- `trades.jsonl` — Append-only signal/trade log
- `errors.jsonl` — Error log

## Deploy

Long-running process on Railway. Use a Railway volume mounted at `/data/` so `match-table.json` and `trades.jsonl` survive deploys. Positions are hydrated live from the Data API on startup.
