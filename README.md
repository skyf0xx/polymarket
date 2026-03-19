# Polymarket Copy Trader

Copies trades from a target Polymarket user to your own wallet.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your private key, funder address, and target wallet
```

## Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build && npm start
```

## How it works

1. Polls `data-api.polymarket.com/activity` every 5 minutes for the target user's trades
2. Diffs against a local `seen_trades.json` to find new trades
3. For each new trade, checks current price vs target's fill price (slippage guard)
4. Places a matching order via the Polymarket CLOB API using `@polymarket/clob-client`

## Sizing modes

- **fixed** (default): Spend a fixed USD amount per trade (e.g. $10)
- **multiplier**: Multiply the target's `usdcSize` by a factor (e.g. 0.5 = half their size)

## Deploy

Runs as a long-lived process. Deploy to Railway, Render, Fly.io, or any VPS.
No database needed — state is a single JSON file.
