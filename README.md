# PaperTrade

A paper-trading app for exploring stocks, practising trades, and tracking a portfolio with virtual money. Each account starts with **₹10,00,000** and includes watchlists, price alerts, and a trading journal.

## Features

- Search stocks across US, Indian, UK, European, Japanese, and Hong Kong markets, with price charts and historical data.
- Place market, limit, stop, and stop-limit orders; review order status and execution history.
- Track cash, holdings, profit and loss, and portfolio value over time.
- Organise watchlists into folders and save notes against stocks.
- Set one-shot price alerts and receive in-app notifications.
- Switch regions and display currencies while keeping account balances in INR.

**Market-data availability:** real market data is currently available for viewing. Trading against it remains disabled until the provider meets the app's data requirements. To try the full trading workflow locally, select the simulated-data mode described below.

## Getting started

You'll need Docker with Docker Compose. Run these commands from the repository root.

### 1. Configure the environment

```bash
cp .env.pern-compose.example .env.pern-compose.local
```

Open `.env.pern-compose.local` and fill in `PAPER_ADMIN_PASSWORD`, `PAPER_OWNER_PASSWORD`, `PAPER_APP_PASSWORD`, and `CSRF_SECRET` with four independently generated random hex values. For example, run this once for each value:

```bash
openssl rand -hex 32
```

Choose a data mode in the same file:

| Setting | Behaviour |
| --- | --- |
| `MARKET_PROVIDER=fixture` | Simulated prices for trying trades, orders, alerts, and portfolio tracking locally. |
| `MARKET_PROVIDER=yahoo` | Real market data for browsing and charts; instruments are currently view-only. |

The example defaults to `yahoo`. Set it to `fixture` for a working trading demo. Simulated data is never used automatically when a provider fails, and fixture mode is disabled in production.

### 2. Start the app

```bash
docker compose --env-file .env.pern-compose.local -f compose.pern.yml up --build --detach --wait
```

Open **http://localhost:3000**, create an account, and sign in. If you change the web port, update both `PERN_WEB_PORT` and `PUBLIC_ORIGIN` in the environment file.

The stack starts the web app, API, background worker, and PostgreSQL database. Database migrations run before the API and worker start. Account and trading data persist across restarts.

### 3. Stop the app

```bash
docker compose --env-file .env.pern-compose.local -f compose.pern.yml down
```

This preserves the database volume. Adding `--volumes` deletes its stored data.

## Trading rules

- Accounts use INR; changing the display currency does not change the account balance.
- Long positions only, with full fills and quantities up to four decimal places.
- No fees, slippage, leverage, or short selling.
- Pending orders reserve neither cash nor shares. Available funds and holdings are checked when an order fills.
- Trades use server-side prices. Missing or unsuitable market data blocks execution; missing valuation data is shown as unavailable.
- Automatic split and dividend adjustments are not supported.

## Tech stack

| Component | Tools |
| --- | --- |
| Web app | React, Vite, React Router, Recharts |
| API | Node.js, Express, TypeScript |
| Database | PostgreSQL, `pg`, versioned SQL migrations |
| Background jobs | Node.js worker for orders, alerts, market refreshes, and portfolio snapshots |
| Authentication | Server-side cookie sessions with CSRF protection |
| Deployment | Docker Compose, nginx |
| Tests | Vitest, Supertest, Playwright |

## Development

Use **Node.js 24.22.2** and **npm 11.19.1**. Install the backend and frontend dependencies:

```bash
npm ci
npm ci --prefix frontend
```

For development outside Docker, follow the [local database and environment setup](docs/PERN_SETUP.md). With the database configured, apply migrations and build the backend:

```bash
npm run db:migrate
npm run build
```

Run the API, worker, and frontend in separate terminals with their environment configured:

```bash
npm run start:api
npm run start:worker
npm run dev --prefix frontend
```

The frontend runs on port 3000 and proxies `/api` to the API on port 3001.

### Running checks

Backend integration and browser tests use a separate disposable PostgreSQL instance:

```bash
npm run test:db:up
npm run typecheck
npm run test:foundation
npm run test:web
npm run build:web
npm run test:e2e
npm run test:db:down
```

Browser tests use an installed Google Chrome. Set `CHROME_EXECUTABLE` if it is installed somewhere other than the default path.

## Project structure

```text
frontend/                  React app
apps/server/src/
  modules/                 Identity, accounts, market data, trading, portfolio, and user tools
  platform/                Database, configuration, logging, and HTTP utilities
  api.ts                   API entrypoint
  worker.ts                Background worker entrypoint
apps/server/migrations/    Database migrations
apps/server/test/          Backend and browser tests
packages/contracts/        Shared API types
deploy/pern/               Dockerfiles, nginx configuration, and database role setup
docs/                      Setup, operations, and design documentation
```

## Documentation

- [Setup and operations](docs/PERN_SETUP.md) — local configuration, deployment, health checks, and backups.
- [Market-data support](docs/PERN_PROVIDER_VALIDATION.md) — provider coverage and requirements for enabling trading with real data.
- [Provider alternatives](docs/PERN_PROVIDER_RESEARCH.md) — official-source coverage, delays, and evidence still needed for trading.
- [Known issues and verification](docs/superpowers/plans/2026-11-02-pern-completion-results.md) — test coverage and deferred fixes.

The earlier Flask/Oracle application remains in `backend/`, `database/`, and `docker-compose.yml` for reference. See the [legacy README](docs/LEGACY_README.md) for that version; the current app uses `compose.pern.yml`.
