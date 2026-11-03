# Current codebase re-audit — 4 November 2026

**Remediation status:** R1–R8 are implemented on `fix/reaudit-completeness` and deployed locally with schema 005. The findings below describe the reviewed baseline. See [implementation results](#implementation-results) for the verified current behavior and deployment requirement.

Reviewed baseline: `d231c40`, with the existing untracked provider feasibility/design documents left untouched. This supplements the earlier audit and its nine completed fixes. It does not invalidate those fixes. No application behavior was changed during this audit.

The screenshot exposes a real end-to-end contract gap. The current product can fetch a price and chart, but cannot populate its stock statistics panel. Broader review found additional misleading displays and response-order bugs. Existing passing checks do not establish feature completeness.

## Scope and method

Reviewed the active React pages and adapters; Express authentication, authorization, market data, orders, tools and portfolio flows; PostgreSQL migrations, privileges and reconciliation; worker scheduling; Python bridge; Compose/nginx; CI and test entry points. Retained legacy code was checked against the earlier isolation assessment, not requalified as an active runtime.

Verified the screenshot through the real application/API and disposable PostgreSQL, using fixture prices. Controlled HTTP delays/failures reproduce specific UI defects. The new [audit probe](../apps/server/test/completeness.audit.ts) uses the repository's guarded database harness and does not use application accounts or database records. Its assertions deliberately confirm defects: a successful run means the defects reproduced, **not** that the application is correct.

This is an application audit, not an exhaustive penetration test, live Yahoo availability/accuracy certification, image/Python vulnerability scan, load test, backup restore drill, or comprehensive accessibility audit. No live provider credentials, local environment secrets, or application records were printed. The previously chosen yfinance policy allowing old source observations and UNKNOWN sessions after recent confirmation is treated as intentional.

## Findings

### R1 — High product completeness: none of the ten stock statistics can arrive through the current pipeline

Evidence: [StockDetail.jsx](../frontend/src/pages/StockDetail.jsx#L250), [provider.ts](../apps/server/src/modules/market-data/provider.ts#L10), [bridge quote](../services/yfinance/app.py#L148), [provider adapter](../apps/server/src/modules/market-data/yfinance-provider.ts#L52), [QuoteDto/readQuote](../apps/server/src/modules/market-data/service.ts#L158), [frontend quote adapter](../frontend/src/services/api.js#L60).

The page reads `open`, `day_high`, `day_low`, `previous_close`, `volume`, `avg_volume`, `market_cap`, `pe_ratio`, `52w_high` and `52w_low`. The provider quote only carries raw price/currency, observation time, session and action key; the SQL DTO adds receipt/quality information, not statistics. Discovery metadata also lacks fundamentals, sector, industry and description. Therefore the dashes are not simply a temporarily incomplete AAPL response or a CSS problem. Retrying the current endpoint cannot fill this panel.

**Observed:** all ten rendered values contained `—` while the quote was usable. The API quote had no `open` field. The same omissions exist on the yfinance path by inspection at each boundary.

**Remedy:** define a display snapshot contract separately from execution eligibility. Carry optional, validated fields with source/as-of and availability information through bridge, provider, HTTP DTO and frontend adapter. Derive session values only from compatible observations; do not treat a month's last chart candle as today's statistics. Preserve GBP/pence normalization for monetary prices, keep volumes unitless and P/E dimensionless. Missing optional fundamentals must not disable a valid execution quote. Until supported, explicitly identify unsupported data instead of presenting an unexplained panel of dashes.

### R2 — Medium: unavailable index movement is displayed as a positive zero

Evidence: [api.js:63](../frontend/src/services/api.js#L63), [Header.jsx:193](../frontend/src/components/Header.jsx#L193).

The adapter sets `change_pct: null` for every stock/index quote. The header replaces null with zero and renders a green rising icon and `+0.00%`. This is an invented numeric claim, visible in the supplied screenshot. Stock detail and watchlist mostly preserve the missing value instead.

**Observed:** the real browser displayed `+0.00%` without a change observation. **Remedy:** render unavailable movement neutrally; calculate a percentage only from a validated comparable prior close, keeping actual zero distinct from missing.

### R3 — Medium: delayed responses can put orders under the wrong status and history under the wrong period

Evidence: [PendingOrders fetchOrders](../frontend/src/pages/PendingOrders.jsx#L84), [Analytics fetchSnapshots](../frontend/src/pages/Analytics.jsx#L90). These asynchronous setters do not verify that their request still matches the selected filter.

**Observed:** hold OPEN orders, select FILLED and finish that response, then release OPEN: the selected tab remains FILLED but contains an OPEN order. Separately, hold the initial 1M snapshots, select 7D, finish a series showing +10%, then release 1M: the selected tab remains 7D but shows the older series and +50%.

**Remedy:** invalidate obsolete requests and their loading/error updates using a generation or effect cleanup. Apply the same discipline to independently refreshable lists; the earlier instrument and notes fixes do not protect these pages. Test both late successes and late failures.

### R4 — Medium: adding a stock to a folder is unnecessarily split into three requests

Evidence: [StockDetail.jsx:112](../frontend/src/pages/StockDetail.jsx#L112), [watchlistAPI.add](../frontend/src/services/api.js#L98), [createEntry](../apps/server/src/modules/user-tools/service.ts#L86).

Stock detail creates a default entry, reloads the list, then moves the entry. If the read/move fails, the first write remains committed while local state still says Watch. Repeating the action can conflict with the entry that was already created.

**Observed:** fail the PATCH after a real successful POST: the stock remains in the default folder, not the chosen folder, and the page still offers Watch. **Remedy:** use the existing atomic `watchlistAPI.add(ticker, folderId)` path and reconcile a committed mutation independently of any subsequent display refresh. No new backend endpoint is required.

### R5 — Medium: Analytics turns incomplete valuation into zero holdings

Evidence: [Analytics.jsx:105](../frontend/src/pages/Analytics.jsx#L105), [summary cards](../frontend/src/pages/Analytics.jsx#L183), [empty state](../frontend/src/pages/Analytics.jsx#L436).

When any required valuation input is absent, `holdings` becomes an empty array even if positions exist. The page reports Holdings 0, Win Rate 0%, and “No holdings to analyze yet.” Its valuation note mentions incomplete data, but the concrete figures contradict the owned positions.

**Observed:** buy one AAPL share through the real API, remove USD FX in the disposable database, then read the portfolio: `quality=incomplete`, one position. The browser nevertheless reports zero holdings and the no-holdings message.

**Remedy:** preserve the position count and identities; show dependent analytics as unavailable, with an appropriate retry/data status. Never equate missing valuation with absence of ownership or a measured zero return.

### R6 — Medium semantic accuracy: “Total P/L” and “Win Rate” do not measure their apparent trading outcomes

Evidence: [adaptPortfolio](../frontend/src/services/contracts.js#L45), [Analytics winners](../frontend/src/pages/Analytics.jsx#L131), [summary labels](../frontend/src/pages/Analytics.jsx#L178), [portfolio valuation](../apps/server/src/modules/portfolio/service.ts#L39), [execution realized P/L](../apps/server/src/modules/trading/service.ts#L100).

The adapter names current `unrealizedPl` as `total_pl`; both dashboard and analytics call it Total P/L. Closed positions disappear from that calculation. Win Rate is the percentage of currently held positions with positive unrealized P/L, not successful completed trades; flat positions remain in its denominator. Thus an account with profitable closed trades and no positions displays zero P/L and zero win rate. Realized amounts are stored in executions but never included in this metric.

This is a confirmed calculation/label mismatch by source inspection, not an additional demonstrated ledger defect. **Remedy:** label these “Unrealized P/L” and “Profitable holdings,” or explicitly specify and implement realized-plus-unrealized return and a closed-trade outcome metric. Define partial-sale treatment before adding a win rate.

### R7 — Low completeness: other visible metadata features also lack a supplied contract

Evidence: [watchlist entry projection](../apps/server/src/modules/user-tools/service.ts#L13), [entry adapter](../frontend/src/services/api.js#L47), [Watchlist display](../frontend/src/pages/Watchlist.jsx#L303), [portfolio adapter](../frontend/src/services/contracts.js#L52).

Watchlist Added reads `added_at`, but its backend projection and adapter provide no creation date. Sector is absent and change is always null. Sector Allocation assigns every holding the literal `Unclassified`, so it cannot show real diversification by sector. Stock detail's About/sector/industry sections are also unreachable with the supported metadata contract.

**Remedy:** inventory every rendered field against its actual DTO. Supply supported metadata, or clearly remove/defer the unsupported feature. Do not manufacture sectors or dates. Use watchlist entry IDs as React keys: the backend permits the same ticker in multiple folders, whereas the All view currently keys by ticker.

### R8 — Low UX/recovery: successful dashboard retries retain an earlier error

Evidence: [Dashboard fetchPortfolio/fetchSnapshots](../frontend/src/pages/Dashboard.jsx#L108).

Both operations set the shared `error` on failure and neither clears it on success. A successful holdings refresh can therefore leave the summary cards replaced by the previous failure; an earlier history failure can also hide otherwise valid account statistics. This is source-confirmed; not included in the new browser reproductions.

**Remedy:** track independent portfolio/history errors and clear each on successful recovery. Avoid coupling chart availability to summary-card availability.

## Verification and limitations

| Check run now | Result |
| --- | --- |
| Workspace typecheck and backend/contracts build | Passed; frontend JSX remains outside the typecheck |
| Backend unit tests | 20 passed |
| Disposable PostgreSQL integration tests | 215 passed across 21 files |
| Frontend test command | Passed, two test files reported by this local Node runner |
| Python bridge offline tests | 16 passed using `/tmp/paper-yfinance-venv/bin/python` |
| Production frontend build | Passed |
| Original production browser workflow | Passed; 10 routes, responsive/themes and existing interactions |
| Controlled yfinance production browser workflow | Failed once with missing Trade and “Failed to fetch stock data”; passed on isolated repeat |
| Existing audit browser suite | 19 scenarios passed |
| Catalogue browser suite | 8 scenarios passed |
| New completeness audit probe | All 5 scenarios reproduced the six defects covered by R1–R5 |
| Compose/nginx tests | 5 passed |
| npm production advisory checks, root and frontend | Zero reported vulnerabilities in both graphs |

The combined `npm run test:e2e` exited nonzero at the yfinance failure. The skipped suites were subsequently run separately and passed. Do not describe this as a clean combined E2E run. No root cause for that intermittent failure was established; provider concurrency/startup request timing is a hypothesis, not a confirmed finding. Capture failed request statuses and boundary responses in the controlled workflow before changing limits or adding retries.

Initial integration failures were setup failures (sandbox networking and a stopped test database); the final successful run followed starting the isolated database. The system `python3` initially lacked yfinance; the existing virtual environment successfully ran the suite. Local Node/npm were 24.16.0/11.13.0, below the package's declared minima 24.22.2/11.19.1. Results therefore do not substitute for verification on the pinned CI toolchain. No dependencies were installed or lockfiles changed.

Repeat the new probe after building the frontend, using the documented disposable test database:

```bash
npm run test:db:up
npm run build:web
TEST_DATABASE_ADMIN_URL=postgresql://paper_test_admin:paper_test_admin_only@127.0.0.1:55439/paper_foundation_test_admin npm exec --workspace @paper/server -- tsx test/completeness.audit.ts
```

The URL above is the repository's intentionally public, guarded test credential. Convert each defect assertion into a desired-behavior regression when implementing its remedy. The probe is not part of `test:e2e` and must not be added as a passing correctness gate in its present form.

## Security, accounting and operations assessment

No new authorization bypass, SQL injection, duplicate-execution or cash-ledger defect was substantiated in this review. Preserve owner-scoped SQL, restricted roles, exact PostgreSQL decimal arithmetic, account locking, durable idempotency, session-bound CSRF and independent reconciliation. This statement is bounded by the reviewed paths and executed checks; it is not a security certification.

The prior fixes remain supported by their current integration/browser/deployment checks, including candle geometry, UUID folders, note drafts, mutation feedback, catalogue recovery, bridge in-flight sharing and trusted ingress handling. Only example environment files are tracked; local environment files were not read for this audit.

Existing operational follow-ups remain: long-running Compose services have no restart policy; yfinance's transitive dependencies and most image inputs are not locked; public TLS/ingress and backup/restore recovery require deployment-specific verification. CI exists now, so the old suggestion to add CI is already addressed. Root typecheck still excludes frontend JSX, and no formatter/linter command is configured. These are follow-up gaps, not evidence of an additional exploit.

## Recommended order

1. Resolve the stock snapshot contract and missing index movement first; verify fields through every boundary and distinguish unavailable values from zero.
2. Fix obsolete filter responses, atomic folder insertion and incomplete-valuation displays, using the reproduced scenarios.
3. Correct the analytics metric names/definitions and other unsupported metadata features; separate dashboard recovery states.
4. Investigate the intermittent yfinance browser failure, rerun on the declared toolchain, then address deployment recovery and dependency locking.

The current architecture does not need replacement to address these findings. The main gap is consistency between visible product promises, supplied data and asynchronous UI state.


## Implementation results

R1: the private bridge now fetches validated optional `Ticker.info` metrics and descriptive metadata. Migration 005 stores one atomic last-successful snapshot. Price fields normalize pence independently of market cap; zero volumes and signed P/E are preserved. A stored quote returns promptly on the new authenticated snapshot route; Stock Detail polls every 15 seconds and reports separate receipt times/status. Successful statistics refreshes are throttled to 30 minutes, failures to at least 60 seconds, with stale status after 60 minutes. Statistics never participate in order eligibility.

R2: missing index movement no longer becomes positive zero. No daily movement is inferred from independently timed quote/previous-close data.

R3: pending status and analytics period responses use request ownership to discard obsolete successes, errors and loading updates. R4: Stock Detail uses the existing atomic folder-aware insertion. R5: incomplete analytics preserves real holdings/count and marks dependent metrics unavailable. R6: existing values are accurately named Unrealized P/L and Profitable holdings.

R7: watchlist creation timestamps now cross the API seam; entry IDs provide stable React keys across folders. Unsupported watchlist sector/change columns are removed, and analytics explicitly reports unavailable sector data instead of presenting a classification pie. Sector/industry/description are available on Stock Detail when the statistics provider supplies them. R8: dashboard history and portfolio errors recover independently and clear after successful retries.

A controlled adapter test reproduced immediate rejection of the third startup request. Admission now permits two active requests plus at most eight bounded waiters, using the existing timeout budget. Overflow/expiry and subsequent capacity recovery are tested. The Python bridge's upstream limit is unchanged.

Final checks in this implementation session:

| Check | Result |
| --- | --- |
| Workspace typecheck; server/contracts/frontend builds | Passed |
| Backend unit tests | 20 passed |
| PostgreSQL integration suite | 223 passed, 22 files |
| Frontend adapter/contract test command | Passed, two files reported |
| Python bridge offline suite | 18 passed |
| Combined production-browser command | Passed, including original workflow, yfinance, 19 earlier audit cases, 8 catalogue cases and 7 new completeness cases |
| Compose/nginx deployment suite | 5 passed |
| Real AAPL statistics probe without any database | All ten statistics supplied by yfinance |
| Independent code review | No critical/important defect found; failed-refresh test strengthened to verify an actual provider attempt |

RED/GREEN records and implementation decisions are in the [remediation ledger](superpowers/plans/2026-11-04-reaudit-fixes.md). The original defect-confirming `completeness.audit.ts` is historical evidence only. The desired-behavior [browser regressions](../apps/server/test/completeness.browser.e2e.ts) now run in `npm run test:e2e`.

Initial verification found three old schema-version expectations; those were updated to version 5 while retaining future-schema rejection coverage. Final suites are green. The local Node/npm version limitation noted above still applies; the pinned CI toolchain was not installed during this change.

**Deployment completed:** after the user's authorization, migration 005 and rebuilt services were deployed locally. All services are healthy; AAPL exposes all ten statistics. A private pre-migration backup restored successfully into a network-isolated container, accounting invariants passed, and financial table fingerprints matched exactly across the migration. Existing active accounts still reconcile. The worker's process-exit recovery was verified. Full dependency hashes, base-image digests and restart policies are in place; 6 deployment tests passed. Unit/integration checks also passed under the pinned Node/npm container and all 18 bridge tests passed in the hash-locked deployment image. See the [operations record](PERN_OPERATIONS.md). Public TLS/ingress and off-device backup retention remain deployment/operator choices outside this loopback-only local scope.
