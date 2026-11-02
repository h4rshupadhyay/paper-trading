# PERN migration audit

Audit date: 2 November 2026. Scope: the current repository, including application code, SQL, dependencies, and startup configuration. The user confirmed that the replacement can start with a fresh database.

The project is a suitable candidate for PERN. Keep the React application and replace the Python backend and Oracle database. The main work is rebuilding trading correctness and market-data processing; translating HTTP handlers is relatively straightforward. A mechanical port would retain several significant defects.

This report contains findings and proposed migration sequencing. It is not an approved implementation design, and no application code or database was changed during the audit.

## Findings to address during migration

Severity reflects impact on this paper-trading application's integrity and availability. “Reproduced” below means that the existing Python function was executed with mocked infrastructure, not against a live Oracle database.

### 1. High: callers control market execution prices

Evidence: [trading routes](../backend/routes/trading.py), lines 20–34 and 44–58; [trading module](../backend/services/trading_service.py), lines 14–25; [Oracle procedures](../database/03_procedures.sql), lines 68–104.

`POST /api/buy` and `/api/sell` accept a positive `price` from the request and pass it directly to the execution procedure. The database checks funds and holdings against that supplied value, without checking a market quote. An authenticated caller can buy cheaply and sell at an invented high price. Purchases can also create catalogue entries without validating the symbol against market data.

Reproduced: the real buy handler forwarded `AAPL`, quantity `1`, price `0.01` unchanged to the trading module.

Required outcome: resolve the execution price on the server, validate instrument identity and quote freshness, and reject execution when an acceptable quote is unavailable. Keep client limit/stop instructions distinct from execution prices. Decide the simulation's market-session and slippage rules explicitly.

### 2. High: cash and holdings use incompatible currencies

Evidence: [balance trigger](../database/02_triggers.sql), lines 128–144; [portfolio calculation](../backend/services/portfolio_service.py), lines 80–110; [currency formatting](../frontend/src/context/RegionContext.jsx), lines 158–171; [analytics allocation](../frontend/src/pages/Analytics.jsx), lines 123–129.

The UI treats cash and aggregate portfolio values as INR. Trades debit or credit raw stock-native `quantity × price`, with no conversion. Portfolio valuation then adds native values from different markets to one cash balance. For example, a US stock quoted at USD 200 debits 200 units from a balance displayed as INR. The analytics allocation additionally treats that cash balance as USD.

There are no stock currency or execution FX columns in the core schema. UI formatting cannot repair this accounting model.

Required outcome: use one explicit account currency, record each instrument's actual quote currency/unit, and store the execution FX rate and account-currency amount on each trade. Convert holdings consistently before aggregation. Display-region changes should affect presentation only. INR is a reasonable proposed default because the current cash formatter assumes it; this is not yet a user-approved design choice.

### 3. High: a pending order can execute more than once

Evidence: [pending fills](../backend/services/pending_order_service.py), lines 120–190; [trade commits](../backend/services/trading_service.py), lines 20–25 and 63–68; [procedure commits](../database/03_procedures.sql), lines 98 and 133.

The filler reads OPEN orders without claiming or locking them, executes a separately committed trade, and only then marks the order FILLED in another transaction. A crash or status-write failure leaves an already executed order OPEN. Another worker can also select the same order; cancellation can race with filling. There is no persisted order-to-transaction relationship that prevents repeat execution.

Reproduced: forcing the status update to fail after a successful mocked trade caused two calls to the real filler to execute the same order twice.

Required outcome: claim and recheck the order, execute the trade, update holdings/cash, and record the fill in one database transaction. Enforce a unique pending-order reference on the resulting ledger entry for the current single-fill model. Use consistent lock ordering and retry handling.

### 4. High: pending-order rules are incomplete

Evidence: [fill logic](../backend/services/pending_order_service.py), lines 117–190; [active ticker selection](../backend/services/scheduler.py), lines 81–100; [order input validation](../backend/routes/pending_orders.py), lines 19–30; [order schema](../backend/db/migrations/003_pending_orders.sql).

- STOP_LIMIT executes immediately at the limit whenever the stop is crossed, even if the observed market is outside that limit. There is no persisted triggered state. Reproduced: a BUY with stop 80 and limit 85 filled at 85 while the observed market was 90.
- `expires_at` is stored but never checked by the filler; no expiry transition was found.
- OPEN pending orders do not contribute tickers to the scheduler's active list. An order whose symbol is neither held, watched, nor covered by an active alert may never be evaluated, even when the full-catalogue daemon refreshes its quote.
- The HTTP handler does not enforce required positive stop/limit prices by order type or parse expiry timestamps. The schema lacks corresponding positive-value and order-type consistency checks.

Required outcome: implement explicit order transitions, including persistent stop activation, expiry and cancellation. Include pending symbols in quote scheduling, validate finite decimal inputs, and define the fill-price policy.

### 5. High: fresh Docker startup has a schema-ordering failure

Evidence: [entrypoint](../backend/entrypoint.sh), lines 2–8; [seed deletion loop](../backend/scripts/seed_demo.py), lines 306–317; [database setup](../database/setup.sql); [application migrations](../backend/app.py), lines 85–93.

The container runs the demo seed before starting Flask. The initial database setup creates only the six core tables, while the seed uses `watchlist_folders`, which is created later by Flask startup. On a fresh schema this ordering prevents startup. This conclusion follows from the code; a live Docker/Oracle run was not performed.

On later starts, the seed deletes and rebuilds history, holdings, snapshots, and watchlists for the `test` account. It also disables trading triggers during part of the seed process. This behavior should not become the new server's startup lifecycle.

Required outcome: run versioned migrations before dependent processes start. Make demo seeding a separate, explicit development command. Server restarts must preserve user state.

### 6. High: watchlist folder assignment does not verify ownership

Evidence: [watchlist insert](../backend/services/watchlist_service.py), lines 141–145; [folder move](../backend/services/watchlist_service.py), lines 240–246; [folder foreign key](../backend/db/migrations/002_watchlist_folders.sql), lines 17–20.

The watchlist entry is scoped to the authenticated user, but its destination `folder_id` is accepted without checking that the folder belongs to that user. The foreign key checks only that the folder exists. The watchlist query joins the folder name, so assigning another user's folder can expose its name through the attacker's own watchlist.

Required outcome: validate destination ownership for both add and move. Prefer also enforcing `(user_id, folder_id)` ownership through a composite foreign key, with a deliberate folder-deletion policy.

### 7. Medium: unavailable prices produce false losses and history

Evidence: [portfolio calculation](../backend/services/portfolio_service.py), lines 86–110 and 171–178; [market-data defaults](../backend/services/market_data.py), lines 35–38 and 61–92.

An unavailable quote becomes zero. The portfolio then treats the holding as worthless and can persist that valuation in a snapshot. Reproduced: two shares with average cost 100 and an unavailable quote returned a market value of zero and a holding P/L of −100%.

Additional freshness issue: [cache warmup](../backend/services/price_refresh.py), lines 79–100, does not restore the original fetch timestamp; [cache writes](../backend/services/cache.py), lines 71–78, mark entries fresh at load time. Persistence can also timestamp an old cached price as newly fetched after a failed refresh.

Required outcome: distinguish unavailable, stale, and fresh quotes; preserve provider observation time separately from fetch time. Mark incomplete valuations and prevent misleading snapshots or stale-price execution.

### 8. Medium: migrations and background work are not deployment-safe

Evidence: [application startup](../backend/app.py), lines 29–47 and 69–93; [scheduler](../backend/services/scheduler.py); [refresh daemon](../backend/services/price_refresh.py); [health endpoint](../backend/app.py), lines 106–113.

Migration failures are logged and ignored; several SQL exception blocks also suppress unexpected errors. Workers start before the migrations complete. Each API process starts its own scheduler and full-catalogue daemon with a separate in-memory cache. Scaling processes therefore duplicates work and increases the fill/alert race exposure. `/api/health` reports success without checking database or migration readiness.

Required outcome: explicit migration execution with failure propagation, separate API and worker entrypoints, shared quote storage, and readiness checks. Lock order/alert processing in the database even when only one worker is initially deployed.

### 9. Medium: dependencies and verification need attention

The existing frontend lockfile installed and built successfully in a temporary copy. `npm audit --json` reported **14 affected packages: 7 high, 6 moderate, 1 low**, with no critical findings. These are package-level advisory results, not 14 demonstrated exploits in this application. Some apply to Node adapters, build tooling, or development servers rather than browser runtime.

Direct dependencies reported by the audit include Axios, React Router DOM, and Vite. Upgrade deliberately and verify affected paths; avoid applying a forced major-version upgrade as an unattended migration shortcut. [Frontend manifest](../frontend/package.json) and [lockfile](../frontend/package-lock.json).

No automated test files or CI workflow were found. The frontend has no test or lint script. Python requirements use open lower bounds without a dependency lock. The Docker frontend runs the Vite development server, and the backend runs Flask's development server. [Python requirements](../backend/requirements.txt), [frontend Dockerfile](../frontend/Dockerfile), [backend entrypoint](../backend/entrypoint.sh).

### Other issues to resolve explicitly

- Starting cash has three definitions: the SQL default is 100,000; `Config.STARTING_BALANCE` is 1,000,000; registration hardcodes 10,000,000. Choose one value, currency, and authoritative configuration. See [schema](../database/01_schema.sql), line 27; [config](../backend/config.py), line 34; [registration](../backend/services/auth_service.py), line 19.
- JWT signing falls back to a known development secret if configuration is absent. The replacement should reject missing production secrets. Rate limiting and an existing-token account-deactivation check were not found. Logout currently means client token removal. See [config](../backend/config.py), lines 13 and 22; [auth routes](../backend/routes/auth.py).
- Pagination uses unchecked integer conversion, accepts invalid ranges, and permits `per_page=0`, which causes division by zero. Normalize errors to validated 4xx responses. See [trading routes](../backend/routes/trading.py), lines 66–68; [order history](../backend/services/trading_service.py), line 140.
- Core trigger code uses read/modify/write holdings calculations without explicit row locking. Concurrency behavior was not tested against Oracle; require concurrent-trade integration tests for the replacement. Ledger immutability is documented but is not enforced against UPDATE/DELETE by the supplied schema or triggers.
- The scheduled batch price source is `period="2d", interval="1d", auto_adjust=True`. A 15-second polling interval does not by itself establish quote observation freshness or consistent execution/history adjustment semantics. See [market data](../backend/services/market_data.py), lines 115–120.
- README statements about exclusively cached request handling and consistent starting balances do not match all execution paths. Use code and verified behavior as the migration inventory.

## Current implementation and migration scope

| Area | Current implementation | PERN treatment |
| --- | --- | --- |
| UI | React 18, Vite, React Router, Recharts; 10 pages | Retain pages and styling; repair currency semantics and execution payloads |
| HTTP backend | Flask; 8 route groups; 37 explicit method/path pairs including health | Reimplement in Express, preserving compatible paths and response shapes |
| Backend source | 30 Python files across routes, trading, quotes, background work and scripts | Replace runtime modules and supporting scripts with Node equivalents |
| Storage | Oracle; 6 core tables, 5 feature tables, 1 quote-cache table | Fresh PostgreSQL schema with migrations and constraints |
| Database behavior | 4 triggers, 2 packages, 1 standalone function, 2 views | Inventory each rule; centralize execution transaction ownership |
| Market data | yfinance/pandas; quotes, history, search, indices and FX | Node provider adapter with normalized currencies, timestamps and failures |
| Background work | Two in-process daemon loops | Dedicated Node worker with database coordination |
| Auth | bcrypt, bearer JWT, browser localStorage | Preserve intended login flow; validate secrets, token claims and user status |
| Development/deployment | Oracle/Python/Node Compose services | PostgreSQL/Node API/Node worker/frontend; separate development and production serving |

Tables to recreate: `users`, `stocks`, `transactions`, `holdings`, `watchlist`, `portfolio_snapshots`, `notes`, `watchlist_folders`, `pending_orders`, `price_alerts`, `notifications`, and `stock_price_cache`.

Existing HTTP surface, all under `/api`:

| Group | Methods and paths |
| --- | --- |
| Auth | `POST /register`, `POST /login`, `GET /me`, `POST /logout` |
| Market data | `GET /stocks/tickers`, `GET /currency/rates`, `GET /stocks/index/:ticker`, `GET /stocks/search`, `GET /stocks/:ticker`, `GET /stocks/:ticker/history` |
| Trading | `POST /buy`, `POST /sell`, `GET /orders` |
| Pending orders | `POST /orders/pending`, `GET /orders/pending`, `DELETE /orders/pending/:order_id` |
| Portfolio | `GET /portfolio`, `GET /portfolio/snapshots` |
| Watchlists | `GET /watchlist`, `POST /watchlist`, `DELETE /watchlist/:ticker`, `DELETE /watchlist/item/:watchlist_id`, `PATCH /watchlist/:watchlist_id/folder` |
| Folders | `POST /watchlist/folders`, `PATCH /watchlist/folders/:folder_id`, `DELETE /watchlist/folders/:folder_id` |
| Notes | `GET /notes`, `GET /notes/:note_id`, `POST /notes`, `PUT /notes/:note_id`, `DELETE /notes/:note_id` |
| Alerts | `GET /alerts`, `POST /alerts`, `DELETE /alerts/:alert_id`, `GET /notifications`, `POST /notifications/read` |
| Health | `GET /health` |

The ticker catalogue is fetched directly by frontend search inputs, beyond the central Axios wrapper. Preserve that endpoint too. Keep literal Express routes such as `/stocks/search` and `/stocks/tickers` ahead of `/stocks/:ticker`.

## Proposed migration direction

For this fresh-database migration, the recommended approach is to implement the new backend alongside the current one, prove feature coverage, and switch the frontend proxy and Compose configuration once the replacement passes its checks. Existing Oracle data does not need exporting; this is not permission to delete existing databases or volumes.

An alternative is to port the Oracle procedures and triggers to PostgreSQL functions and keep database-owned trading behavior. That can fit a database-focused requirement, but adds procedural SQL migration work and retains the split between application and database logic. The recommended proposal is a Node trading module with one transaction owner and PostgreSQL constraints as safeguards. These are alternatives for the next design discussion, not decisions already approved by the user.

Suggested target: Express on Node.js, PostgreSQL accessed through `pg` and versioned SQL migrations, and the current React/Vite frontend. Backend TypeScript is a proposed maintainability choice; converting the existing frontend to TypeScript is optional and outside the essential PERN migration.

Use a small trading interface shared by market-order routes and pending-order processing. Its implementation should hide quote validation, account/holding locks, decimal arithmetic, ledger insertion, weighted-average cost updates, and order completion. Avoid reproducing the current independently committing buy/sell calls inside another workflow. A `pg` transaction must use the same checked-out client for every statement. [node-postgres transaction documentation](https://node-postgres.com/features/transactions).

A separate market-data module is a useful seam because the current Python provider must be replaced and deterministic quote fixtures are needed for tests. `yahoo-finance2` is a candidate Node adapter: its own documentation lists quote, history/chart, search and quote-summary support, and quote currency metadata. Validate actual exchange/index/FX coverage and provider behavior before selecting it. [Provider documentation](https://github.com/gadicc/yahoo-finance2#quickstart).

PostgreSQL can initially hold shared quotes, worker coordination and durable order state; Redis is not a prerequisite for PERN. Revisit caching infrastructure after measuring workload.

## PostgreSQL translation details that matter

| Oracle construct | Proposed PostgreSQL treatment |
| --- | --- |
| Identity `NUMBER` keys | Deliberately sized integer/bigint identity columns; define JSON identifier serialization |
| `NUMBER(p,s)` for money and quantities | `NUMERIC(p,s)` with explicit precision and rounding rules |
| `VARCHAR2`, `CLOB` | `varchar`/`text`; normalize Oracle empty-string-as-NULL behavior where relevant |
| Numeric active/read flags | Boolean storage; map intended JSON booleans explicitly |
| `SYSTIMESTAMP`, timezone-naive timestamps | `timestamptz` for events; consistent UTC serialization |
| `:1` binds and Oracle OUT variables | `$1` parameter binding and `RETURNING` rows |
| Oracle `MERGE ... dual` | Appropriate PostgreSQL upsert, generally `INSERT ... ON CONFLICT` |
| `NVL` and `NUMTODSINTERVAL` | `COALESCE` and parameterized interval arithmetic |
| Null-folder unique expression index | Preserve uncategorized uniqueness, e.g. `UNIQUE NULLS NOT DISTINCT (user_id, stock_id, folder_id)` |
| Procedure-owned commits | One transaction owner spanning the whole execution workflow |
| Oracle exception codes | Map PostgreSQL SQLSTATE/constraint names to stable application errors |

PostgreSQL `numeric` provides exact decimal storage; JavaScript numeric conversion still needs a deliberate policy. Keep financial arithmetic exact in the backend and serialize bounded presentation values explicitly. Do not globally coerce every database numeric/bigint to a JavaScript number. Several current React pages call `.toFixed()` directly, so silently changing those response fields to strings would break them. [PostgreSQL numeric documentation](https://www.postgresql.org/docs/current/datatype-numeric.html), [node-postgres type handling](https://node-postgres.com/features/types).

PostgreSQL's ordinary unique constraint permits multiple NULL values; preserve the current null-folder rule deliberately. Row locks can serialize account/holding changes. Also define what happens when deleting a folder would merge duplicate ticker entries into the uncategorized list. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html).

## Proposed delivery order and acceptance criteria

1. **Agree on the trading model and capture contracts.** Choose starting balance/account currency, currency conversion, quote freshness, market-order and stop-limit behavior. Capture representative request/response fixtures for the 37 method/path pairs. Identify intentional contract corrections.
2. **Build the PostgreSQL foundation.** Add the fresh schema, indexes, versioned migrations, configuration validation and an opt-in development seed. Verify clean creation and restart without data resets.
3. **Establish Node auth and market data.** Implement register/login/profile and the provider adapter; verify one representative stock per supported market, indices, FX, metadata and OHLCV. Include provider failures and missing currencies.
4. **Implement execution and valuation together.** Test weighted-average buys, partial/full sells, insufficient funds, oversells, fractional precision, currency conversion, stale/missing quotes, idempotency and concurrent requests using real PostgreSQL transactions.
5. **Port worker behavior and remaining features.** Implement pending-order activation/fill/cancel/expiry and one-shot alerts with retry/concurrency checks; then watchlist ownership, folder semantics, notes, notifications and snapshots.
6. **Switch and verify the full application.** Run the retained React pages against Express, test all 37 method/path pairs, update containers and setup docs, and serve the production frontend build. Remove obsolete Python/Oracle runtime dependencies only after replacement coverage is verified.

The greatest uncertainty is market-data coverage and consistent currency/quote semantics. The smallest uncertainty is retaining the current React UI. With no data transfer required, an export/import pipeline and dual database writes add no value to the requested scope.

## Verification performed and limits

- Installed frontend dependencies from the existing lockfile in a temporary copy using `npm ci --ignore-scripts --no-audit --no-fund`; succeeded.
- Ran `npm run build` in that copy; succeeded with Vite 5.4.21. The main JavaScript chunk was approximately 730 kB minified / 207 kB gzip, with a chunk-size warning. Route-level lazy loading is a later performance improvement.
- Ran `npm audit --json`; exited 1 with the package-level counts above. Python dependency vulnerability auditing was not performed.
- Parsed all 30 Python files with `ast.parse`; no syntax errors. This does not establish successful imports or runtime behavior.
- Executed isolated probes against the real buy route, pending-order filler and portfolio calculation with mocked Flask/Oracle/provider dependencies. Reproduced the four behaviors described above; inspected the absence of expiry checks.
- Inspected SQL, ownership filters, startup order and scheduling paths. No live Oracle/PostgreSQL integration tests, full backend startup, browser flows, or market-provider calls were run. Most Python runtime dependencies are absent from this workspace environment.
- No automated regression suite or CI workflow was found. The existing application therefore has no demonstrated end-to-end baseline to rely on for the migration.
