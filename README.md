# PaperTrade — PERN paper trading

React + Express + Node.js + PostgreSQL, with a separately runnable Node worker. The application includes cookie-based authentication, an INR paper account, instrument discovery and charts, market/limit/stop/stop-limit orders, exact accounting, portfolio valuation/history, watchlist folders, notes, alerts and notifications.

New accounts receive **₹10,00,000**. Orders use server observations, full fills, fractional quantities up to four decimals, no fees/slippage and no leverage. Pending orders reserve neither cash nor shares. Every fill atomically records the order, execution, cash movement and position changes.

## Market data modes

- `MARKET_PROVIDER=yahoo` uses real display data. Live instruments remain **view-only** until their quote/session/freshness/corporate-action metadata passes the documented acceptance gate. An available endpoint alone does not prove execution eligibility.
- `MARKET_PROVIDER=fixture` explicitly uses simulated development/test observations. It supports the complete end-to-end workflow and is rejected in production. It is never an automatic fallback after provider failure.

See [provider evidence and limitations](docs/PERN_PROVIDER_VALIDATION.md). Financial values are persisted as PostgreSQL decimals and returned as strings. Missing portfolio observations produce unavailable totals rather than invented zero values. INR accounting is independent of the selected display region/currency.

## Run the PERN stack

Use Docker with Compose. Copy the example and supply four independent random hex secrets (32 random bytes each):

```bash
cp .env.pern-compose.example .env.pern-compose.local
node --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("hex"))'
# Repeat generation for each secret, fill the file, and select yahoo or explicit fixture mode.
docker compose --env-file .env.pern-compose.local -f compose.pern.yml up --build --detach --wait
```

Browse the configured `PUBLIC_ORIGIN` (default `http://localhost:3000`). The stack uses its own `paper-pern` project and `pern_data` volume. It does not mount Oracle/Python files or old volumes. A one-shot owner-role migration must succeed before API/worker start; neither runtime process migrates or seeds users. A normal stop preserves data:

```bash
docker compose --env-file .env.pern-compose.local -f compose.pern.yml down
```

Do not add `--volumes` for data you want to keep. This is a local development setup by default. For production, use real provider acceptance, HTTPS, `NODE_ENV=production`, stable secrets, monitored backups and the trusted proxy arrangement described in [setup](docs/PERN_SETUP.md).

## Local development and checks

Use Node 24.22.2 and npm 11.19.1 (pinned in `.node-version`/`package.json`).

```bash
npm ci
npm ci --prefix frontend
npm run test:db:up
npm run typecheck
npm run test:foundation
npm run test:web
npm run build:web
npm run test:e2e
npm run test:db:down
```

Browser checks use Playwright and installed Google Chrome; set `CHROME_EXECUTABLE` when Chrome is elsewhere. They create and clean only unique databases in the isolated test instance. Backend tests include concurrency, rollback, idempotency, sessions/CSRF, cash/position reconciliation, stop/expiry/cancel races, missing data, worker coordination and compiled-process restart. Browser acceptance exercises all ten retained routes.

See the [completion verification and review record](docs/superpowers/plans/2026-11-02-pern-completion-results.md) for current acceptance evidence, provider limits and deferred minor findings.

For a separate persistent development database, configure `.env.pern.local` as described in [setup](docs/PERN_SETUP.md), then explicitly run migrations/build. Run the API on port3001, the Vite UI on3000 and the worker in another terminal. The bundled Vite proxy keeps `/api` on the browser's origin.

## Layout

- `apps/server/src/modules`: identity, accounts, market data, trading, portfolio and user tools.
- `apps/server/src/api.ts`, `worker.ts`: separate compiled runtime entrypoints.
- `apps/server/migrations`: ordered, transactional SQL upgrades with an owner/runtime role split.
- `frontend`: retained React UI and resource-API adapters.
- `packages/contracts`: shared foundation DTOs.
- `deploy/pern`, `compose.pern.yml`: static web/proxy and Node/PostgreSQL runtime.

The previous Flask/Oracle implementation is preserved under `backend`, `database`, and `docker-compose.yml` for reference; it is not used by the PERN stack. [Legacy documentation](docs/LEGACY_README.md) describes that old runtime. No Oracle data import is part of this fresh-database migration.
