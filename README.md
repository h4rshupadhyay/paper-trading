# PaperTrade

A paper-trading app for exploring stocks, practising trades, and tracking a portfolio with virtual money. Each account starts with **₹10,00,000** and includes watchlists, price alerts, and a trading journal.

## Features

- Search stocks across US, Indian, UK, European, Japanese, and Hong Kong markets, with price charts and historical data.
- Place market, limit, stop, and stop-limit orders; review order status and execution history.
- Track cash, holdings, profit and loss, and portfolio value over time.
- Organise watchlists into folders and save notes against stocks.
- Set one-shot price alerts and receive in-app notifications.
- Switch regions and display currencies while keeping account balances in INR.

**Market data:** yfinance supplies prices for browsing and paper trades. Trades use the latest price returned by the service, including prices from closed markets. Missing or invalid prices and exchange rates block execution; simulated prices are never substituted automatically.

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
| `MARKET_PROVIDER=yfinance` | Yahoo Finance prices through Python’s yfinance library, used for browsing and paper trades. |
| `MARKET_PROVIDER=fixture` | Simulated prices for trying trades, orders, alerts, and portfolio tracking locally. |
| `MARKET_PROVIDER=yahoo` | Real market data for browsing and charts; instruments are currently view-only. |

The example defaults to `yfinance`. Fixture mode is disabled in production. Indices remain view-only in every mode.

### 2. Start the app

```bash
docker compose --env-file .env.pern-compose.local up --build --detach --wait
```

The default `compose.yml` delegates to `compose.pern.yml`; both use project `paper-pern` and the existing `paper-pern_pern_data` volume. Bare `docker compose up` requires the same secrets in the shell or `.env` and fails if they are absent. Startup runs migrations only; it does not seed demo data.

Open **http://localhost:3000**, create an account, and sign in. If you change the web port, update both `PERN_WEB_PORT` and `PUBLIC_ORIGIN` in the environment file.

The stack starts the web app, API, background worker, private yfinance service, and PostgreSQL database. Database migrations run before the API and worker start. Account and trading data persist across restarts. See [local operations and backup/restore](docs/PERN_OPERATIONS.md) for deployment maintenance, recovery verification and dependency updates.

### 3. Stop the app

```bash
docker compose --env-file .env.pern-compose.local down
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
| Market data | Python, yfinance |
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

Start the [Python market-data service](docs/PERN_YFINANCE.md#standalone-development), then run the API, worker, and frontend in separate terminals with their environment configured:

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

With the market-data virtual environment activated, run `npm run test:market` for the offline Python service tests.

With Docker running, `npm run test:deploy` checks Compose entry points and trusted-ingress behavior using temporary containers and dummy secrets. It does not use the app database or volumes.

The [interaction and failure matrix](docs/testing/INTERACTION_FAILURE_MATRIX.md) maps each feature, endpoint, financial rule and failure path to its tests. See the [4 November test results](docs/testing/RESULTS_2026-11-04.md) for executed checks, seeded fixtures, discovered defects and remaining coverage limits. `npm run test:browser:interactions` runs the new form/control journeys; they also run in `npm run test:e2e`. Seeded accounting and HTTP guard tests run automatically in `npm run test:foundation`.

Browser tests use an installed Google Chrome. Set `CHROME_EXECUTABLE` if it is installed somewhere other than the default path.

Internal changes render from confirmed write responses. Alerts and notifications use a one-minute background check while the tab is visible, refresh on return, and synchronise notification reads immediately. Other internal lists load on navigation/actions. See the [refresh policy and regressions](docs/testing/INTERNAL_API_REFRESH_2026-11-04.md).

The [GitHub Actions workflow](.github/workflows/ci.yml) runs these checks on pull requests, pushes to `main`, and manual dispatch. It uses the repository’s Node/npm versions, Python 3.12.16, lockfile installs for both npm projects, and package-matched Playwright Chromium. It also runs the offline Python and Docker deployment tests. Test PostgreSQL is isolated and cleaned up after the checks; application secrets and live market-data access are unnecessary. See the [CI verification record](docs/superpowers/plans/2026-11-04-ci.md) for validation and hosted-run limitations.

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
services/yfinance/         Private Python market-data service and offline tests
deploy/pern/               Dockerfiles, nginx configuration, and database role setup
docs/                      Setup, operations, and design documentation
```

## Documentation

- [Version history](CHANGELOG.md) — project changes, dependency upgrades, and verification results.
- [Setup and operations](docs/PERN_SETUP.md) — local configuration, deployment, health checks, and backups.
- [yfinance paper trading](docs/PERN_YFINANCE.md) — current price policy, service setup, and six-region verification.
- [Quote streaming](docs/PERN_STREAMING.md) — shared Yahoo feed, UI updates, validation and fallback.
- [Strict Yahoo validation](docs/PERN_PROVIDER_VALIDATION.md) — historical evaluation of the separate view-only Yahoo adapter.
- [Provider alternatives](docs/PERN_PROVIDER_RESEARCH.md) — official-source coverage, delays, and evidence still needed for trading.
- [Known issues and verification](docs/superpowers/plans/2026-11-02-pern-completion-results.md) — test coverage and deferred fixes.

The earlier Flask/Oracle application remains in `backend/`, `database/`, and `compose.legacy.yml` for reference. See the [legacy README](docs/LEGACY_README.md) for that version; the current app uses the default `compose.yml` or explicit `compose.pern.yml`. The archived stack is incompatible with the current frontend and must not be used to start this app.
