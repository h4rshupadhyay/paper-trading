# Codebase audit — 4 November 2026

For the subsequent feature-by-feature interaction inventory and seeded logic/browser testing, see the [interaction matrix](testing/INTERACTION_FAILURE_MATRIX.md) and [execution results](testing/RESULTS_2026-11-04.md). The findings below retain their original review context.

The pre-PERN files cited in finding 7 were removed after cutover. Their exact
contents remain available in the [pre-cleanup Git tree](https://github.com/h4rshupadhyay/paper-trading/tree/b5729b7).

**Current status:** the [re-audit fixes](CODEBASE_REAUDIT_2026-11-04.md#implementation-results) are implemented and deployed locally with schema 005. Restart policies, locked deployment inputs and an isolated backup/restore drill are complete; see the [deployment record](PERN_OPERATIONS.md#verified-deployment--4-november-2026). Findings below retain the historical baseline.

**Implementation status:** the nine approved fixes are complete on `fix/audit-tdd`, each with a separate task commit and an observed failing regression before implementation. The findings below describe the reviewed baseline; see [implementation results](#implementation-results) for current status. The lower-priority restart-policy finding and cleanup suggestions remain follow-up work.

## Assessment

The current architecture is a reasonable size for this product: React, an Express API and worker, PostgreSQL, and a private yfinance bridge. Keep that structure. The highest-value work is to fix UI failure paths, make shared rules consistent, and make the existing code easier to read and check.

The accounting implementation is stronger than the frontend state management. Account locking, transactional execution/position/ledger updates, PostgreSQL decimal arithmetic, owner scoping, restricted database privileges, and independent reconciliation are worth preserving. No additional accounting or authorization defect was substantiated in this review; that is not a claim of exhaustive security verification.

Scope: the current working tree, including the uncommitted yfinance and visual cleanup, active server/frontend/bridge, tests, deployment, contracts, documentation, and retained legacy entry points. The legacy Oracle/Flask implementation was assessed for isolation and startup confusion, not requalified as a supported runtime. The requested yfinance policy—paper trades at the latest valid received price, including old observations and unknown sessions, without a delayed-data label—is intentional and was not treated as a defect.

Application code, configuration, credentials, and the existing app database were not changed during the audit. This report is the only added repository artifact. Findings below are supported by code paths; the existing suites were run separately. New reproducer/regression tests for the findings remain follow-up work.

## Correctness findings

### 1. High: late responses can change the apparent trading target or overwrite a draft

**Evidence:** [StockDetail.jsx:54](../frontend/src/pages/StockDetail.jsx#L54), [StockDetail.jsx:75](../frontend/src/pages/StockDetail.jsx#L75), [StockDetail.jsx:275](../frontend/src/pages/StockDetail.jsx#L275), [Notes.jsx:39](../frontend/src/pages/Notes.jsx#L39), [PriceChart.jsx:87](../frontend/src/components/PriceChart.jsx#L87).

Stock-detail requests apply their result without checking whether the route ticker has changed. If A's request finishes after navigating to B, A's quote can replace B's displayed data while the order form still receives route ticker B. The server continues to select B's price, so this is an instrument/intent presentation problem, not evidence that browser prices control settlement. `showOrder` and other ticker-dependent state also survive route changes.

The note editor has the same underlying problem: start opening an existing note, click New, and type while the read is outstanding. Its late result replaces the new draft's fields, while `isNew` remains true. Chart-period and fallback-search requests can likewise apply obsolete results.

**Smallest useful fix:** guard results with a request generation or effect cleanup; invalidate reads when changing route, starting a new note, or closing the editor. Reset ticker-dependent modal state. Add tests that deliberately return responses out of order. React documents aborting or ignoring obsolete fetch results in its [effect guidance](https://react.dev/learn/synchronizing-with-effects#fetching-data).

### 2. Medium: the watchlist folder dropdown treats UUIDs as integers

**Evidence:** [Watchlist.jsx:174](../frontend/src/pages/Watchlist.jsx#L174), [api.js:99](../frontend/src/services/api.js#L99), [user-tools/input.ts:9](../apps/server/src/modules/user-tools/input.ts#L9).

The select calls `parseInt` on a folder UUID. A numeric result fails the server's UUID-string validation; `NaN` or zero causes the adapter's truthy spread to omit the folder, silently using the default folder. Named tabs set their ID directly and therefore do not establish that this dropdown works.

**Fix:** retain the selected string, using `null` only for the empty option. Test selecting a named folder in the actual Add form. The existing browser setup creates a folder and entry through direct API requests, bypassing this control.

### 3. Medium: a committed trade can be presented as a failed order

**Evidence:** [OrderForm.jsx:68](../frontend/src/components/OrderForm.jsx#L68), [OrderForm.jsx:94](../frontend/src/components/OrderForm.jsx#L94), [AuthContext.jsx:6](../frontend/src/context/AuthContext.jsx#L6).

After order submission succeeds, the form awaits an account/identity refresh in the same `try`. A subsequent refresh failure leaves the form open and displays the refresh error as an order failure. Unchanged retries retain the idempotency key, which is good; closing/reopening or changing the intent creates a new attempt, so the misleading outcome still matters.

**Fix:** acknowledge the accepted order independently of refreshing the account display. Give a refresh failure its own retry/status. Test a successful order response followed by a failed account refresh and assert that no second order is encouraged or submitted automatically.

### 4. Medium: candlestick coordinates and direction are incorrect

**Evidence:** [PriceChart.jsx:28](../frontend/src/components/PriceChart.jsx#L28), [PriceChart.jsx:194](../frontend/src/components/PriceChart.jsx#L194).

The shape transforms OHLC using each bar's geometry and a hard-coded `300 * 0.7` span instead of the actual price-axis scale. Bodies and wicks can disagree with axis labels. In addition, `CandlestickBar` compares already transformed pixel coordinates to decide direction: a higher close has a smaller y coordinate, reversing the intended up/down comparison.

**Fix:** use one actual plot-area price scale for every OHLC value, and derive direction from raw open/close values. If that cannot be implemented reliably in a small change, retain line mode until candle mode is correct. Test a rising and falling candle with known prices, geometry, and colors.

### 5. Medium: failed loads and mutations can look like empty or unchanged successful state

**Evidence:** [Notes.jsx:33](../frontend/src/pages/Notes.jsx#L33), [Notes.jsx:82](../frontend/src/pages/Notes.jsx#L82), [Notes.jsx:96](../frontend/src/pages/Notes.jsx#L96), [PendingOrders.jsx:87](../frontend/src/pages/PendingOrders.jsx#L87), [Watchlist.jsx:68](../frontend/src/pages/Watchlist.jsx#L68). Similar catches exist in alert and notification flows.

Several handlers discard exceptions. An initial failed load can show an empty collection; a failed note save stops its spinner without explaining that the draft remains unsaved. Silent background refresh failures and silent user-initiated save failures should not receive the same treatment.

**Fix:** keep explicit load/action errors with retry, retain entered content, and distinguish empty, loading, failed, and stale-but-usable states. Use a small shared error presentation; do not introduce a generic form/state framework just for this.

### 6. Medium: watchlist quote quality still uses the older provider policy

**Evidence:** [user-tools/service.ts:13](../apps/server/src/modules/user-tools/service.ts#L13), compared with [market-data/service.ts:139](../apps/server/src/modules/market-data/service.ts#L139), trading observation SQL, portfolio valuation, and alert evaluation.

Watchlist SQL classifies by source observation age and regular-session status. A recently received old yfinance quote becomes `STALE`, and a recent `UNKNOWN` quote becomes `UNAVAILABLE`, while other modules apply the selected yfinance receipt policy. It also exposes a separate uppercase quality vocabulary. The current UI does not visibly act on this quality field; this is an API consistency defect rather than a demonstrated blocked trade.

**Fix:** align this query with the selected policy and test it. Then consolidate the repeated quality/eligibility rules behind a small market-observation module or carefully scoped SQL helpers. Preserve the execution query's provider/unit/future-time/paused checks and account transaction. Presentation availability and execution eligibility are related but need not become one oversimplified boolean.

## Deployment and market-service findings

### 7. Medium: default startup still points at the legacy application

**Historical evidence:** `compose.legacy.yml`, `MANUAL_SETUP.md`,
`frontend/Dockerfile` and `backend/entrypoint.sh` in the
[pre-cleanup Git tree](https://github.com/h4rshupadhyay/paper-trading/tree/b5729b7).

The README correctly specifies `compose.pern.yml`, but plain `docker compose up` still selects Oracle/Flask with the current PERN frontend. The legacy frontend image also uses Node20 while the active toolchain requires Node24. The old backend entrypoint runs demo seeding. Old manual instructions remain easy to mistake for current setup.

**Fix:** make the current stack the unambiguous default and clearly archive/rename old entry points and instructions. Preserve legacy source and any existing volumes; archiving is not permission to remove stored data. Keep one documented happy path for current development and operations.

### 8. Medium, before public deployment: the documented HTTPS proxy chain collapses client IPs

**Evidence:** [nginx template](../deploy/pern/nginx.conf.template), [PERN_SETUP.md:27](PERN_SETUP.md#L27), [platform/http.ts:64](../apps/server/src/platform/http.ts#L64).

nginx overwrites forwarded client IP with its direct peer. With an additional HTTPS edge in front, the application sees the edge's address for every client. Its per-IP authentication throttle then becomes shared across those users. The current loopback-only local app is not a public-ingress deployment.

**Fix when establishing that ingress:** specify the supported proxy chain, recover client IP only from explicitly trusted ingress addresses, and forward that result. Never trust arbitrary incoming forwarded headers. nginx's [real-IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) documents the trust directives. Test two distinct clients and spoofed headers through the actual chosen chain.

### 9. Medium availability issue: simultaneous cache misses duplicate upstream work

**Evidence:** [services/yfinance/app.py:94](../services/yfinance/app.py#L94), [services/yfinance/app.py:115](../services/yfinance/app.py#L115).

The cache lock protects map access, but no in-flight result is shared. Two misses for the same key can both use the bridge's two upstream slots, causing unrelated quote or FX requests to fail busy. The global limit and timeouts are useful; they should remain bounded.

**Fix:** share an in-flight future per cache key, remove it on completion/failure, and preserve bounded caller waits. Do not hold one global cache lock throughout network I/O or add Redis for this single shared bridge.

### 10. Low locally, medium for unattended deployment: no restart policy for long-running services

**Evidence:** [compose.pern.yml](../compose.pern.yml). Only the migration job specifies a restart policy, explicitly `no`.

Health checks report problems but do not establish automatic process-exit or host-restart recovery. For an unattended deployment, set an appropriate policy such as `unless-stopped` on long-running services; retain the one-shot migration policy. Test recovery separately. A restart policy does not itself restart a merely unhealthy process. See [Docker's restart-policy documentation](https://docs.docker.com/engine/containers/start-containers-automatically/).

## Pragmatic cleanup, in order

| Change | Why it earns its place | Relative effort |
| --- | --- | --- |
| Format code and add formatter/lint checks | Financial and HTTP flows are compressed into long lines; reading a transaction currently requires mentally separating many statements. Start with a formatting-only change, then lint React hooks and unused code. | Small–medium |
| Add repository CI using the existing checks — completed | A SHA-pinned GitHub Actions workflow runs the existing checks with pinned Node/npm/Python, isolated PostgreSQL, package-matched Chromium, and Docker deployment tests. See the [CI verification record](superpowers/plans/2026-11-04-ci.md); its first hosted run follows pushing the workflow. | Medium |
| Type the frontend API seam incrementally | Root typecheck covers server/contracts, not JSX or frontend adapters. Export public market/order/portfolio DTOs from `packages/contracts`, initially check the adapter and touched forms, and keep IDs as strings and submitted monetary values as strings. | Medium |
| Share the catalogue loader/filter — completed | Both controls now share pending/successful catalogue loading and filtering. Failures can retry on focus/remount, and late data updates current suggestions. See the [catalogue TDD record](superpowers/plans/2026-11-04-catalogue-loading-tdd.md). | Small–medium |
| Extract shared pagination from trading routes | `portfolio/http.ts:4` imports `trading/http.ts` for pagination; tools has another cursor parser. Move reusable mechanics into `platform`, initially preserving current cursor formats and ownership checks. | Small |
| Consolidate CSS by ownership | The2338-line stylesheet contains repeated selectors and later overrides. Organize tokens, shell, common controls, and page-specific rules; remove rules only after checking actual dynamic classes. A new CSS framework is unnecessary. | Medium |
| Remove proven dead code and misleading comments | `useDebounce.js` and `useLocalStorage.js` have no consumers. Search comments still describe a static ticker JSON/shared cache despite the current API and separate caches. Remove or correct these as small changes. | Small |
| Lock Python dependencies and deployment inputs | Only yfinance is directly pinned; its transitive graph resolves again during image builds. Most base images use tags, whereas PostgreSQL already uses a digest. Record tested transitive versions/hashes and update deliberately. | Small–medium |
| Simplify the compatibility adapter gradually | `api.js` and `contracts.js` translate canonical camelCase resources into legacy aliases. This module is currently useful: it keeps migration details out of pages. Update consumers and remove aliases together when touching a feature; do not delete the adapter in one sweep. | Medium, incremental |

For gradual JavaScript checking, TypeScript supports [`checkJs`/`allowJs`](https://www.typescriptlang.org/tsconfig/checkJs.html); a whole-frontend conversion is not required to start. A dependency compiler such as the documented [`uv pip compile`](https://docs.astral.sh/uv/pip/compile/) can generate a resolved requirements file; using uv is an option, not a prerequisite for this cleanup.

## Keep these practices

- Monetary calculations and rounding in PostgreSQL `numeric`; frontend numbers remain presentation only.
- Account-level transaction/locking and durable idempotency keys for financial writes.
- Append-only execution/cash history and independent reconciliation.
- Owner-scoped queries and separate migration/runtime database roles.
- Cookie sessions, CSRF/origin checks, and validation at HTTP/provider seams.
- Explicit provider selection, no invented fallback prices, and a private bridge with bounded upstream calls.
- Real disposable PostgreSQL integration tests and production-browser tests.
- Lazy-loaded frontend routes and existing bundle separation.

There is no demonstrated need for microservices beyond the existing library bridge, a generic repository/ORM layer, event sourcing, a message broker, distributed caching, or a new frontend framework. Add infrastructure only when a measured usage requirement makes the current approach inadequate. Existing ledger records should not be rewritten merely to make module interfaces tidier.

## Suggested delivery sequence

1. **Reliability:** fix folder UUID handling, stale responses/draft invalidation, accepted-order feedback, and silent mutation errors. Add focused browser failure-path tests. Correct candle geometry/direction separately.
2. **Rules and maintainability:** fix watchlist quality drift; centralize only the shared observation logic; format code; add checks/CI and frontend contract checking; share catalogue loading and remove verified dead code.
3. **Operations:** make startup/docs unambiguous, lock Python/image inputs, deduplicate in-flight bridge work, and configure restart/proxy behavior for the intended deployment.

Keep mechanical formatting, behavior fixes, and source archiving in separate reviewable changes. Each behavior fix should have its own reproducer. The current browser suite seeds some tools through direct API calls, so extend it with actual form interactions and deliberately delayed/failed responses rather than increasing the number of happy-path screenshots.

## Verification run during this audit

| Check | Result |
| --- | --- |
| TypeScript workspace typecheck | Passed; server/contracts only |
| Backend unit tests |20 passed |
| PostgreSQL integration tests |209 passed across21 files |
| Frontend API/contract tests |16 passed |
| Python bridge offline tests |13 passed, deprecation warnings treated as errors |
| Python installed dependency consistency | `pip check` passed |
| Production backend/frontend builds | Passed through the browser command |
| Original production-browser workflow | Passed, including themes, responsive controls, ledger-backed orders, owned tools, and FX expiry |
| yfinance production-browser workflow | Passed, including the selected old-observation policy and exact ledger values |
| npm audit, root and frontend lockfiles |0 reported known vulnerabilities in either graph |

All database verification used the guarded disposable test instance, not existing application data. Passing these suites does not cover the newly identified races, folder dropdown, candle coordinates, or proxy chain. npm audit is not a Python dependency/image scan or a penetration test. No legacy Oracle runtime, public ingress, provider load test, disaster recovery, or exhaustive accessibility audit was performed.

## Implementation results

The task order follows the approved priority list; finding numbers above retain the original audit order.

| Task | Result | Commit |
| --- | --- | --- |
| 1 | Obsolete instrument/search responses ignored; note drafts protected | `e060cd5` |
| 2 | Accepted orders acknowledged independently of account refresh; retryable account warning | `eeaaeb5` |
| 3 | Candle colors use raw prices; bodies/wicks use the actual chart scale | `3883324` |
| 4 | Folder selections preserve UUID strings | `ba2cb03` |
| 5 | Resource errors visible/retryable; drafts, folder names and existing items retained | `fe4e6d7` |
| 6 | Watchlist quality follows yfinance receipt policy without weakening strict providers | `5447b6b` |
| 7 | Same-key market requests share pending work while retaining capacity/time bounds | `2486ed0` |
| 8 | Default Compose selects PERN and preserves the existing project/data volume | `abc8bce` |
| 9 | Explicit trusted ingress preserves client identity; untrusted headers cannot spoof it | `e226804` |

Verification: typecheck; 20 backend unit tests; 215 integration tests; 16 frontend tests; 16 offline Python tests; the original production-browser workflow; the yfinance-browser trading workflow; 19 audit-browser scenarios; and 5 Compose/nginx tests passed. Browser coverage includes actual HTTP mutations followed by display failures, deliberate out-of-order responses, retries, raw OHLC geometry, owned resources, and retained drafts. Independent code review found no remaining blockers. Public HTTPS still requires the actual ingress source CIDR and TLS setup described in [the ingress guide](PERN_INGRESS.md); the default remains safe for local use.

The [TDD ledger](superpowers/plans/2026-11-04-audit-fixes-tdd.md) records each RED/GREEN cycle and repeatable commands. No accounting/schema redesign, synthetic price fallback, broad adapter/CSS rewrite, or extra infrastructure was introduced. The user-selected yfinance trading policy remains in force.
