# Polymarket Value-Bet Bot

TypeScript bot that buys mispriced sports markets on Polymarket using value-bet signals from odds-api.io, then exits when the signal disappears.

## How It Works

### Startup (`index.ts`)

1. Init ethers signer + CLOB client (Safe proxy wallet as funder, `SIGNATURE_TYPE=2`)
2. Fetch on-chain USDC bankroll from funder wallet
3. Instantiate modules: `MarketMatcher`, `PositionTracker`, `OrderTracker`
4. Hydrate: team knowledge → positions (lightweight — no bulk odds fetch)
5. Fetch Gamma sports markets (one-time REST), run initial match cycle, seed `_knownMarkets` cache
6. Start user stream, market stream, poller, maintenance timer

### Polling Loop (`poller.ts`, every 30s)

1. `GET /v3/value-bets?bookmaker=Polymarket&includeEventDetails=true`
2. Extract odds events from value-bet results → feed to matcher via `setOddsEvents()`
3. Update `activeValueBetEvents` set (used by exit logic to check thesis status)
4. Partition results into **new** vs **known** events (by checking match table)
5. **New events** → use `matcher.getKnownMarkets()` (WS-maintained cache) → `matcher.runMatchCycle()` to discover + match
6. **Known events** → parse bookmaker decimal odds → implied probability → resolve token via outcomeMap → Kelly sizing → dispatch order

### Signal Sizing & Dispatch (inline in `poller.ts`)

1. Skip if market inactive or token on cooldown (30s)
2. Kelly sizing: `rawKelly = ev / (1 - bidPrice)`, adjusted by `KELLY_FRACTION` (default 0.25), capped at `MAX_KELLY_PCT`
3. `size = round(bankroll × adjustedKelly / bidPrice)`
4. Stash metadata in `OrderTracker`, mark cooldown, dispatch to executor

### Order Execution (`executor.ts`)

- **BUY:** GTD limit order, price = `min(signalPrice, bookAsk - 1tick)` — posts inside the spread, 5-min expiry
- **SELL:** FAK market order at bestBid (immediate fill or cancel)
- Tracks resting order notional in `OrderTracker`

### Fill Confirmation (`user-stream.ts`)

- Authenticated Polymarket WS pushes `MATCHED` trade events
- BUY fills → update position (weighted avg price), clear pending orders
- SELL fills → reduce/close position
- Catches up missed trades via REST on reconnect

### Market Stream (`market-stream.ts`)

Public Polymarket WS (`wss://ws-subscriptions-clob.polymarket.com/ws/market`) with `custom_feature_enabled: true`:
- `new_market` event → `matcher.addMarket()` + immediate `runMatchCycle()` — no Gamma polling needed for new markets
- `market_resolved` event → `matcher.markResolvedByTokenId()` — marks match inactive instantly
- Replaces the periodic Gamma re-fetch that maintenance used to do

### Maintenance (every 5 min, `maintenance.ts`)

1. Re-sync positions from Data API
2. Refresh bankroll from on-chain
3. Prune expired matches + pending orders
4. **Exit sweep** — check all open positions

### Exit Logic (`exits.ts`)

For each position, fetches live bestBid from CLOB REST, then checks if the position's event still has an active value-bet signal (from the poller's `activeValueBetEvents` set):

1. Event still in value-bets → hold (thesis intact)
2. Edge gone + profit ≥ `MIN_EDGE` → take profit
3. Edge gone + loss > `MIN_EDGE` → cut loss (thesis broken)
4. Edge gone + profit > round-trip fees → lock gain
5. Edge gone for `MAX_NEGATIVE_EDGE_CHECKS` consecutive checks → exit (underwater persistence)

### Market Matching (`market-matcher.ts` + `team-knowledge.ts`)

- **Tier 1 (deterministic):** Parse slug abbreviations → resolve via team knowledge DB → match by team name + date (±36h)
- **Tier 2 (LLM):** Send unmatched markets + odds events to Claude Haiku in batches of 10. Pre-filtered by sport + date + team names to minimize tokens. On success, learned into team knowledge for future Tier 1 hits
- Odds events come from the poller (extracted from `/v3/value-bets` event details) via `matcher.setOddsEvents()`
- `_knownMarkets` cache seeded by initial Gamma fetch + `new_market` WS events — poller uses `getKnownMarkets()` for discovery instead of re-fetching Gamma
- Persisted to `data/match-table.json`. H2h outcomeMap cached in `data/team-knowledge.json` for future deterministic matching
- Team knowledge hydrated once at startup — static data, LLM handles any unknown teams automatically

## Source Files (16 files, ~3400 lines)

| File | Purpose |
|------|---------|
| `index.ts` | Entry point: init, hydrate, start services |
| `poller.ts` | Polls value-bets, sizes signals, dispatches orders, feeds odds events to matcher |
| `executor.ts` | GTD/FAK order placement via CLOB SDK |
| `exits.ts` | Exit logic based on value-bet presence + P&L thresholds |
| `maintenance.ts` | Periodic: re-sync positions, refresh bankroll, prune, exit sweep |
| `cooldown.ts` | Per-token cooldown state |
| `market-matcher.ts` | Polymarket ↔ Odds API matching (deterministic + LLM); maintains `_knownMarkets` cache |
| `market-stream.ts` | Public Polymarket WS — pushes new markets and resolved events into matcher |
| `order-tracker.ts` | Resting orders + signal metadata |
| `position-tracker.ts` | Position tracking (Data API + WS updates) |
| `user-stream.ts` | Authenticated WS for fill confirmations |
| `team-knowledge.ts` | Team abbreviations + h2h outcomeMap (disk-persisted) |
| `wallet.ts` | On-chain USDC balance |
| `config.ts` | Environment variable validation |
| `logger.ts` | Structured JSONL logger |
| `types.ts` | Shared interfaces |

## Key Constraints

**Wallet:** MetaMask EOA as signer, Safe proxy wallet as funder. `FUNDER_ADDRESS` = proxy wallet. `SIGNATURE_TYPE=2`.

**`tickSize`** is a `TickSize` type from `@polymarket/clob-client` — pass directly to SDK, don't convert to number until arithmetic.

## Data Persistence

No database. JSON files in `data/`:

- `match-table.json` — Polymarket slug ↔ Odds API event mappings
- `team-knowledge.json` — Abbreviations + h2h outcomeMap cache
- `trades.jsonl` — Signal/trade log
- `errors.jsonl` — Error log

## Environment

See `env_example.txt`. Key vars:

- `DRY_RUN=true` — log signals only, no execution (default)
- `ODDS_API_SPORTS` — comma-separated sport keys
- `ANTHROPIC_API_KEY` — for Haiku LLM matching
- Bankroll fetched on-chain from funder wallet's USDC balance

## Dependencies

```
@polymarket/clob-client   ethers@5   ws   @anthropic-ai/sdk   dotenv
```
