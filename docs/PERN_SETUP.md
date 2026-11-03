# PERN setup and operations

The primary [README](../README.md) describes Docker startup and the explicit live/fixture provider modes. This document covers persistent local development and deployment responsibilities. All database commands below refer only to a new PostgreSQL instance; do not run them against existing application data.

## Owner and runtime roles

The bundled Compose init script creates `paper_owner` for migration and `paper_app` for runtime, both without superuser/createdb/createrole rights. `paper_admin` initializes the new instance. Passwords are independent required values. Generate hex passwords for Compose URL interpolation; URL-encode arbitrary passwords for manual connection URLs. Never grant the runtime membership in the owner/admin roles.

For manual setup, use the role-provisioning instructions in [foundation setup](PERN_FOUNDATION_SETUP.md), targeting a new persistent database. `.env.pern.example` contains empty credentials deliberately. Use port3001 and `PUBLIC_ORIGIN=http://localhost:3000` for the retained UI. The default `MARKET_PROVIDER=yfinance` uses Yahoo prices for paper trades; start the [Python service](PERN_YFINANCE.md#standalone-development) at `YFINANCE_URL`. Select `yahoo` for the separate view-only adapter or explicitly `fixture` for simulated development.

```bash
set -a
. ./.env.pern.local
set +a
npm run db:migrate || exit 1
npm run build || exit 1
unset MIGRATION_DATABASE_URL
npm run start:api
```

In another shell, load only the runtime URL/origin/secret/provider and run `npm run start:worker`. Run `npm run dev --prefix frontend` for the web UI. API and worker require schema version4. Migrations from foundation1 through4 preserve existing users, opening cash, sessions and folders; newer schema versions are refused. Do not edit an applied migration in a deployed database. Future changes require a new version.

Sessions last24 hours unless revoked, and survive process restarts. Keep CSRF_SECRET stable across restarts. All unsafe requests require the exact configured Origin; authenticated mutations additionally require `X-CSRF-Token` from `/api/auth/csrf`. There are no bearer tokens in browser localStorage. Decimal input quantities/prices must be strings and unsupported fields fail validation. Every order requires an `Idempotency-Key`; reuse it for a retry of the same intent, and use a new key for a different intent.

## Deployment

The default `compose.yml` includes `compose.pern.yml`; either entry uses project `paper-pern` and the unchanged `paper-pern_pern_data` persistent volume. Required secrets must be supplied explicitly; missing secrets stop Compose before startup. Neither entry seeds demo data. `compose.legacy.yml` archives the incompatible Oracle/Flask stack and must not be used with the current frontend.

`compose.pern.yml` builds static React assets into nginx and runs compiled Node API/worker images plus a private Python yfinance service. The Python service has no database credentials or published host port. Only the web port is exposed, bound to loopback by default. Terminate public HTTPS with a trusted edge, use `NODE_ENV=production`, set PUBLIC_ORIGIN to that HTTPS origin, and retain persistent storage/backups. Production prohibits fixture selection and execution using persisted fixture instruments.

The bundled nginx accepts forwarded client addresses only from the explicitly configured `TRUSTED_INGRESS_CIDR` (loopback by default), then forwards one verified address to the private API. The API trusts exactly one proxy hop: bundled nginx. For the supported HTTPS edge → nginx → API chain and spoofing protections, follow [HTTPS ingress and client addresses](PERN_INGRESS.md). Keep the API port private. Manual API startup trusts no proxy by default; only set `TRUST_PROXY_HOPS=1` behind this configured nginx. Authentication throttling is per-process; add a shared limiter before running multiple API replicas. Keep one API/worker for initial sizing. Financial SQL locks and execution uniqueness still protect independent competing calls.

Provider requests are bounded. The worker refreshes active observations, evaluates pending orders/alerts and samples valuations. Stop/limit prices use the provider-normalized quote currency. For yfinance, execution requires a successful quote receipt within60s and FX receipt within24h; older source observations and unknown sessions are accepted for paper trading. Identical source observations can renew receipt time after a successful fetch; conflicting values at the same source timestamp cannot. Original source timestamps remain stored, and source times over5s in the future are rejected. Other providers retain regular-session/observation-age checks; the separate Yahoo adapter remains view-only. These checks are enforced in SQL at execution. A provider outage leaves pending orders live; expiry proceeds without prices. Paused instruments cannot execute. Changed yfinance currency/unit metadata pauses an instrument; complete split/dividend monitoring and automatic adjustments are not supported.

Health: `/api/health/live` requires no database; `/api/health/ready` checks connectivity and schema version. Worker state is persisted in `worker_status` with heartbeat, per-task success times, last error and incomplete valuation count. GET `/api/account/reconciliation` independently compares the authenticated account's cash and position projections with execution/cash records. Investigate discrepancies; never repair by deleting ledger rows or resetting balances. Structured logs omit secrets and request bodies.

API and worker drain on SIGINT/SIGTERM. Compose gives15s; API enforces a10s shutdown deadline. Do not run startup seeds. Restart services against the same volume to retain financial and session history.

## Backups

Create a database dump from only this new PERN instance using its administrator or owner credentials. For example, from a private shell with the Compose env file:

```bash
docker compose --env-file .env.pern-compose.local -f compose.pern.yml exec -T db \
  sh -c 'PGPASSWORD="$PAPER_OWNER_PASSWORD" pg_dump -h 127.0.0.1 -U paper_owner -d paper_pern --format=custom' > paper-pern.dump
```

Protect dumps as financial/identity data. Store them off-instance with retention, and test restoration to a newly provisioned PostgreSQL database with the owner/runtime roles recreated. A process restart test is not a backup/restore or power-loss guarantee. Do not stop/delete legacy Oracle volumes during this migration. Database volume deletion is an explicit data-destructive operator action and is not a normal reset/setup step.

## Resource API

The resource API covers auth/session/account; instruments/quotes/history/FX; orders/detail/cancel/executions; portfolio/snapshots; watchlist folders/entries; notes; alerts; notifications/read. Owner resources use canonical UUIDs, bounded cursor pagination and camelCase responses. Lists return `{items,nextCursor}`. Default folders cannot be deleted; deleting named folders atomically moves/deduplicates entries into the default. Limits are100 folders and1000 entries per user, with explicit409 errors. Notes have200-character titles and10000-character bodies. The React adapters map these resources to retained page fields without changing accounting authority.
