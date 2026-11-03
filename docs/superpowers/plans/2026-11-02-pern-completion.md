# PERN Completion Implementation Plan

Status: implemented, independently reviewed, locally merged into `main` and verified on3 November2026. All Important findings are fixed. Live execution remains gated by provider acceptance. See [results, limits and deferred minors](2026-11-02-pern-completion-results.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace all Flask/Oracle runtime dependencies with a complete tested React/Express/Node/PostgreSQL application, retaining the current user-facing features.
**Architecture:** Continue the accepted modular backend, cookie sessions and durable ledger. Provider observations feed shared trading/worker services; React uses explicit adapters for the resource API. Keep legacy source/data intact while providing a separate PERN Compose stack.
**Tech Stack:** Existing pinned Node/TypeScript/Express/pg/Vitest stack, existing React/Vite frontend, SQL numeric arithmetic, fetch-based provider adapter.
**Spec:** `docs/superpowers/specs/2026-11-02-paper-trading-pern-design.md`.

## Global Constraints

- Existing databases and volumes must remain untouched during development.
- No application financial arithmetic through binary JavaScript floating point. Public decimal values are JSON strings.
- One INR account per user; INR 1,000,000 opening credit; long positions, full fills, four-place quantities, zero fees/slippage.
- Execution quote <=60 seconds, FX <=24 hours, future skew <=5 seconds, confirmed regular session. No synthetic fallback in production.
- No pending reservations; account-before-order locks; immutable executions/cash movements; idempotent submission.
- Unsafe requests require Origin and authenticated CSRF. Every owned resource is scoped by user/account.
- API/worker never migrate or reset data at startup. Explicit migrations; restricted runtime role.

## Review Focus

1. Quote units/session/action metadata and stale FX must fail closed; missing valuation inputs yield null.
2. Concurrent trades, retries and fills reconcile ledger and positions exactly, with no duplicate execution.
3. Stop activation survives restart; expiry precedes prices; cancellation and fills serialize.
4. Cross-user tools and folder deletion preserve ownership/default/dedup; competing alerts notify once.
5. Retained pages use cookies/CSRF, display exact source currencies/quality, and run without Python/Oracle.

## Ownership and fixed interfaces

Root coordinator owns manifests, lockfiles, migration runner/version/config, app composition, common HTTP middleware, legacy foundation-test version isolation, frontend, deployment and final integration. Agent-owned files never overlap root-owned files. Parallel work is permitted only on separate modules with these frozen interfaces. No agent stages/commits shared index changes; coordinator integrates commits sequentially.

Migration sequence: 001 immutable foundation; 002 market; 003 tools; 004 trading/portfolio/worker. `migrate(pool:Pool,targetVersion?:number)` defaults latest; historical foundation tests explicitly target 1. New tables use public UUID `id` and snake_case DB columns; REST returns camelCase names. Monetary SQL numerics remain strings. Instrument `id,symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider`; latest quote `instrument_id,price,observed_at,fetched_at,session,raw_currency,raw_price,action_key`; latest FX `currency,rate,observed_at,fetched_at` means INR per one unit of currency. Quotes/session/action metadata are validated before persistence.

Shared market exports from `modules/market-data/service.ts`: `refreshInstrument(pool:Pool,id:string,provider?:MarketProvider):Promise<void>`, `refreshActive(pool:Pool,provider?:MarketProvider):Promise<void>`, `getProvider():MarketProvider`. Router `marketRoutes(deps:HttpDependencies):Router` mounted under `/api`; routes instruments search/detail/quote/history and fx-rates. Provider types in `provider.ts`; fixture mode only when explicit env and non-production. Production provider must fail closed for unvalidated markets. Refresh locking is a dedicated session advisory lock across bounded network calls. Worker can call refreshActive with all held/live/watched/alert IDs once trading tables exist.

Trading service exports `submitOrder(pool,userId,input,idempotencyKey)`, `cancelOrder(pool,userId,orderId)`, `evaluatePending(pool):Promise<void>`; `tradingRoutes(deps)` mounted `/api`. Portfolio exports `readPortfolio(pool,userId)`, `sampleSnapshots(pool):Promise<void>` and `portfolioRoutes(deps)`. Use SQL numeric; account lock then order/position. Inputs are strict camelCase: `{instrumentId,side,type,quantity,limitPrice?,stopPrice?,expiresAt?}`. Routes orders POST/GET/detail/cancel, executions GET, portfolio GET/snapshots. Responses `{order,replayed}` internally, HTTP `{order}`, lists `{items,nextCursor}`. Order fields camelCase incl instrumentId,symbol,currency,quantity,side,type,status,limitPrice,stopPrice,expiresAt,rejectionReason,createdAt. Portfolio `{account,positions,totalValue,holdingsValue,unrealizedPl,quality,observedAt}` with null aggregate on incompleteness. Positions include instrumentId,symbol,name,currency,quantity,nativeCost,baseCost,price,value,unrealizedPl,quality.

Tools service/router exports `toolsRoutes(deps):Router`, `evaluateAlerts(pool):Promise<void>`, mounted `/api`. Routes: GET/POST watchlists/folders, PATCH/DELETE folders/:id; GET/POST watchlists/entries, PATCH/DELETE entries/:id; CRUD notes; GET/POST/DELETE alerts; GET notifications; POST notifications/read. Inputs camelCase IDs; lists `{items,nextCursor}` except watchlist GET `{folders,items}`. Full owner scope and CSRF. Alert thresholds decimal strings, notifications exactly once. No changes to app.ts by module agents.

### Task 1: Integration platform and contract evolution
**Files:** platform migration/config/http; old tests; plan/spec/progress.
**Interfaces:** migration targetVersion optional, latest version 4; shared requireMutation verifies session+CSRF.
- [x] Write failing upgrade/HTTP encoding tests, run red.
- [x] Extend ordered migrations without modifying 001, allow explicit historical targets; version-check readiness.
- [x] Preserve historical tests at target1, compiled acceptance at latest; map encoding failures to415.
- [x] Verify baseline and upgrade tests; commit platform changes.

### Task 2: Market data and provider acceptance
**Files:** `migrations/002_market.sql`, `modules/market-data/*`, `test/market*.test.ts`, `docs/PERN_PROVIDER_VALIDATION.md` only.
**Interfaces:** frozen market tables/exports above. No root/manifest edits; use native fetch with bounded timeout, explicit fixture provider.
- [x] Write red normalization/freshness/monotonic persistence/locking/provider-failure tests with real DB.
- [x] Implement instruments, quotes/FX, discovery/history, safe live provider adapter and explicit deterministic fixture mode; identify sources and live acceptance status for six regions.
- [x] Live probes never claim successful validation when blocked; per-market trading stays unavailable without complete proof. Preserve known observations on outage.
- [x] Verify focused tests/typecheck, report files and actual checks.

### Task 3: Owned user tools
**Files:** `migrations/003_tools.sql`, `modules/user-tools/*`, `test/tools*.test.ts` only.
**Interfaces:** frozen routes/exports above; consume market instrument IDs and requireMutation.
- [x] Red tests for every CRUD family, second-owner attacks, default-folder deletion, move/dedup and concurrent one-shot alerts.
- [x] Implement ownership SQL constraints and atomic operations. Validate strict IDs/text/decimal input; bounded cursor pagination, timestamps, exact decimal comparisons in SQL.
- [x] Verify real DB tests/typecheck, report files and actual checks.

### Task 4: Trading, portfolio and worker
**Files:** `migrations/004_trading.sql`, `modules/trading/*`, `modules/portfolio/*`, worker entrypoint/tests; coordinator composes app/scripts.
**Interfaces:** frozen trading/portfolio above; tables orders,executions,positions,portfolio_snapshots,worker_status. Ledger reasons BUY/SELL with execution FK, restricted UPDATE accounts columns only; no ledger mutations.
- [x] Red tests: idempotency replay during outage; concurrent insufficient buys/sells; partial/full cost basis, FX and rounding; injected rollback; limit/stop/gap/expiry/cancel races; null valuation; snapshots/restart.
- [x] Implement exact SQL arithmetic, account serialization and bounded retries; validate inputs before accepting, fetch outside transaction then recheck observations inside. Expiry even without quote; inactive account rejects live orders.
- [x] Implement bounded worker loop, refresh -> pending -> alerts -> snapshots, heartbeat and graceful stop. No overlapping loops or startup DDL/seed.
- [x] Verify focused tests, then full backend suite/typecheck/build; commit.

### Task 5: Retained React integration
**Files:** `frontend/src` network/context/pages/components, Vite config, frontend tests; coordinator-owned only.
**Interfaces:** resource API via adapters; cookie/CSRF with real logout, decimal input strings, canonical IDs and per-intent idempotency key. All ten existing routes retained.
- [x] Add failing adapter/route smoke tests with actual API or controlled network boundary.
- [x] Replace bearer/localStorage auth, add adapters, retain styles and navigation, update currencies/quality/nulls and order policy. No suffix-based accounting, hardcoded FX or browser price authority.
- [x] Verify frontend build and all ten routed flows with real PostgreSQL/fixture API, cross-owner and failed provider states.

### Task 6: Deployment and final acceptance
**Files:** new PERN compose/Dockerfiles/nginx/setup docs/environment examples, root scripts; preserve legacy Compose/data.
**Interfaces:** same-origin web/API, compiled API+worker, explicit migration one-shot owner service, persistent new PostgreSQL volume. Secrets supplied explicitly; fixtures prohibited in production.
- [x] Add/run failing process acceptance for complete order lifecycle, worker restart, data persistence and retained API contracts.
- [x] Wire clean dev start, explicit migrations, build/run/health/backup procedures; no deploy to external host.
- [x] Run full typecheck/unit/integration/build, clean Compose validation and page smoke checks; fresh whole-branch SOL review and resolve blockers.
- [x] Record truthful provider acceptance limits and test evidence. Keep reviewable feature branch until integration is chosen.
