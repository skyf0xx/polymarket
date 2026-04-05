# Polymarket Value-Bet Bot

TypeScript bot that buys mispriced markets on Polymarket using value-bet signals from odds-api.io, then exits when the signal disappears.

## How It Works

### Startup (`index.ts`)

1. Init ethers signer + CLOB client (Safe proxy wallet as funder, `SIGNATURE_TYPE=2`)
2. Fetch on-chain USDC bankroll from funder wallet
3. Instantiate `PositionTracker`, `OrderTracker`
4. Hydrate positions from Data API
5. Start user stream, poller, maintenance timer

### Polling Loop (`poller.ts`, every 30s)

1. `GET /v3/value-bets?bookmaker=Polymarket&includeEventDetails=true`
2. Extract slug from each bet's `bookmakerOdds.href` (e.g., `https://polymarket.com/event/nba-atl-bkn-2026-04-03` → `nba-atl-bkn-2026-04-03`)
3. Update `activeValueBetSlugs` set (used by exit logic to check thesis status)
4. For each bet: fetch event from Gamma API via `GET /events/slug/{slug}` (cached in memory)
5. Resolve token by matching bet team name against market outcomes
6. Kelly-size + dispatch order

### Signal Sizing & Dispatch (inline in `poller.ts`)

1. Skip if market inactive or token on cooldown (30s)
2. Convert decimal odds to implied probability: `bidPrice = 1 / decimalOdds`
3. Normalise EV: `ev = (expectedValue - 100) / 100` (e.g. 108.5 → 0.085)
4. Kelly sizing: `rawKelly = ev / (decimalOdds - 1)`, adjusted by `KELLY_FRACTION` (default 0.1), capped at `MAX_KELLY_PCT`
5. `size = round(bankroll × adjustedKelly / bidPrice)`, must meet per-market `orderMinSize` from Gamma
6. Stash metadata in `OrderTracker`, mark cooldown, dispatch to executor

### Order Execution (`executor.ts`)

- **BUY:** GTD limit order, price = `min(signalPrice, bookAsk - 1tick)` — posts inside the spread, 5-min expiry
- **SELL:** FAK market order at bestBid (immediate fill or cancel)
- Tracks resting order notional in `OrderTracker`

### Fill Confirmation (`user-stream.ts`)

- Authenticated Polymarket WS pushes `MATCHED` trade events
- BUY fills → update position (weighted avg price), clear pending orders
- SELL fills → reduce/close position
- Catches up missed trades via REST on reconnect

### Maintenance (every 5 min, `maintenance.ts`)

1. Re-sync positions from Data API
2. Refresh bankroll from on-chain
3. Prune expired pending orders
4. **Exit sweep** — check all open positions

### Exit Logic (`exits.ts`)

For each position, fetches live bestBid from CLOB REST, then checks if the position's slug is still in `activeValueBetSlugs`:

1. Event still in value-bets → hold (thesis intact)
2. Edge gone + profit ≥ `MIN_EDGE` → take profit
3. Edge gone + loss > `MIN_EDGE` → cut loss (thesis broken)
4. Edge gone + profit > round-trip fees → lock gain
5. Edge gone for `MAX_NEGATIVE_EDGE_CHECKS` consecutive checks → exit (underwater persistence)

## Source Files (11 files)

| File | Purpose |
|------|---------|
| `index.ts` | Entry point: init, hydrate, start services |
| `poller.ts` | Polls value-bets, resolves via Gamma slug API, sizes signals, dispatches orders |
| `executor.ts` | GTD/FAK order placement via CLOB SDK |
| `exits.ts` | Exit logic based on value-bet presence + P&L thresholds |
| `maintenance.ts` | Periodic: re-sync positions, refresh bankroll, prune, exit sweep |
| `cooldown.ts` | Per-token cooldown state |
| `order-tracker.ts` | Resting orders + signal metadata |
| `position-tracker.ts` | Position tracking (Data API + WS updates) |
| `user-stream.ts` | Authenticated WS for fill confirmations |
| `wallet.ts` | On-chain USDC balance |
| `config.ts` | Environment variable validation |
| `logger.ts` | Structured JSONL logger |
| `types.ts` | Shared interfaces |

## Key Constraints

**Wallet:** MetaMask EOA as signer, Safe proxy wallet as funder. `FUNDER_ADDRESS` = proxy wallet. `SIGNATURE_TYPE=2`.

**`tickSize`** is a `TickSize` type from `@polymarket/clob-client` — pass directly to SDK, don't convert to number until arithmetic.

## Data Persistence

No database. JSONL files in `data/`:

- `trades.jsonl` — Signal/trade log
- `errors.jsonl` — Error log

## Environment

Key env vars:

- `DRY_RUN=true` — log signals only, no execution (default)
- `ODDS_API_KEY` — for value-bet API
- Bankroll fetched on-chain from funder wallet's USDC balance

## API Documentation

When auditing or modifying API interactions, fetch live docs — do not rely on training data:

- **Polymarket**: `https://docs.polymarket.com/llms.txt` (Gamma API, CLOB API, Data API, WebSocket)
- **Odds API**: `https://docs.odds-api.io/llms.txt` (value-bets, odds, sports)

You have permission to read `.env` and make live API calls to verify data shapes and assumptions.

### Key API details

- **Odds API `expectedValue`**: `bookmakerDecimalOdds / fairDecimalOdds * 100`. A value of 108.5 means Polymarket odds are 8.5% better than fair.
- **Odds API `bookmakerOdds`**: Decimal odds (e.g. 7.143), NOT probabilities. Convert: `impliedProb = 1 / decimalOdds`.
- **Gamma `orderMinSize`**: Per-market minimum share count for CLOB orders. Currently 5 for sports markets.
- **Gamma `orderPriceMinTickSize`**: Per-market tick size (e.g. 0.01). Passed as `TickSize` type to CLOB SDK.

## Dependencies

```
@polymarket/clob-client   ethers@5   ws   dotenv
```
