# PERN completion results

Date: 3 November 2026. Branch: `feat/pern-complete`, based on `e2b5825` (`main`). Integration remains the user's choice.

## Delivered

The replacement runs React, Express/Node and PostgreSQL, with a separate compiled Node worker. Four ordered migrations preserve the existing foundation while adding market observations, owned tools, orders/executions/positions, valuation snapshots and worker status. Trading uses SQL decimal arithmetic, account serialization, durable idempotency and atomic cash/position/execution updates. Cookie sessions and CSRF replace browser bearer tokens. All ten retained routes use the resource API.

The separate PERN Compose stack builds static web assets, API and worker images, provisions restricted roles, migrates explicitly and uses a persistent new PostgreSQL volume. Existing Flask/Oracle source, Compose configuration and data remain intact. No external deployment, push, merge or Oracle import was performed.

Live market execution remains unavailable in all six regions: the provider has not passed session, freshness and corporate-action acceptance. Yahoo supplies display observations; explicit development fixtures exercise trading. Production rejects fixture selection/execution. See [provider evidence](../../PERN_PROVIDER_VALIDATION.md) and [setup](../../PERN_SETUP.md).

## Final independent review and fixes

A fresh SOL high reviewer inspected `e2b5825..0b90236` against the plan, spec and all five Review Focus areas. It found no Critical issue and five Important UI issues. Each entered one fix pass with failing regression evidence:

| Finding | Result and evidence |
| --- | --- |
| Resource summaries overwrite instrument trading metadata | Merge metadata only for the same canonical ID; fetch canonical detail when metadata is incomplete. Contract/API tests failed with missing `tradable`, then passed. |
| TRIGGERED stop-limit orders have no cancel control | OPEN and TRIGGERED both expose cancellation. Browser test first found no control, then cancelled a real triggered order and verified its persisted CANCELLED state. |
| Snapshot history ignores cursor pages | Fetch the requested range through all pages and return chronological samples. Controlled HTTP-boundary test first lost the older page, then passed. |
| Native chart values carry the selected currency's symbol | Axis ticks use the same source-currency conversion as tooltips. Browser test first observed approximately ₹150 for USD150, then observed approximately ₹12,450. |
| Display FX survives past expiry after a refresh outage | Preserve provider/time/quality, expire observations locally, rerender on a minute clock independent of successful HTTP refresh, and expose source/quality/time in the header. Browser clock/outage test first retained ₹12,450 after expiry, then showed unavailable. HTTP test first lacked provider metadata, then passed. |

Final verification also exposed a test harness cleanup race: `pg.Pool.end()` can resolve before client sockets close, and immediate forced database removal generated administrator-termination errors. A deterministic delayed-close test reproduced the error. The harness now waits for connected clients' `end` events before dropping its isolated database; that regression passes. Production code was not changed for this test-only issue.

## Verification

The resumed checks use Node24.22.2/npm11.19.1, matching repository pins. Local PostgreSQL/browser tests require execution outside the filesystem/network sandbox; the initial sandbox-only run failed with `EPERM` connecting to localhost and is not a product failure or passing evidence.

- Backend: `npm run test:foundation` exits zero with20 unit and194 integration tests across19 files, including the new cleanup regression. No unhandled errors remain.
- Frontend: all8 contract/API-boundary tests pass through `npm run test:web`.
- TypeScript checks and backend build pass; production React build passes. Vite reports the existing large-chunk advisory.
- Browser acceptance passes all10 retained routes: registration/login, INR/USD market trades, owned tools, notes saved through React, alerts, stop-limit fills, analytics, logout, cancellation and chart/FX regressions. No React or normal-flow API errors. Deliberate FX-outage traffic is tested separately.
- Docker images rebuild and all four long-running services become healthy. A previously persisted test session, account, two executions and balanced reconciliation survive the rebuilt stack.
- Fresh Docker acceptance fills one market order and one stop-limit order through nginx/API/worker, verifies cash999700.00 and balanced reconciliation, then recreates all containers against the same volume and verifies the same session, account and exactly two executions. Both checks pass.

Database checks use only the dedicated disposable test instance and separate PERN acceptance project. Process/volume persistence is exercised; backup restoration, power-loss durability and deployment capacity are not claimed.

## Deferred minor findings

1. Pending-order side cells read `order_side` while the adapter returns `side`, leaving that column blank.
2. Mark-all-read sends every fetched notification ID in one request; with more than100 unread notifications, the backend's100-ID limit rejects it. Individual reads remain bounded by that contract.
3. Alert responses omit `createdAt`, leaving the retained Created column unavailable.
4. The React bundle exceeds Vite's500kB advisory; no capacity or download-performance claim is made.

## Rulings and accepted limits

1. Treat the prior full-migration instruction as authorization for the existing design defaults and completion plan. This avoids restarting approval; if mistaken, reversible product-rule rework is required.
2. Preserve the original disjoint-module parallel implementation and sequential integration. The branch already contains that work; if the frozen interfaces were wrong, integration fixes are required.
3. Bound aggregate watchlists to100 folders and1000 entries per owner with explicit409 errors. Larger watchlists require a changed cap and paginated aggregate contract.
4. Serialize all same-owner tools mutations with the existing narrow advisory/active-user mechanism. This preserves ownership races; the cost is serialization of unrelated mutations for one owner.
5. Permit fresh regular-session index alerts while keeping indices view-only for execution. If unsuitable, index-alert eligibility needs tightening; indices cannot trade.
6. Keep every live market unavailable until provider acceptance. If overly conservative, this restricts availability rather than executing unsupported observations.
7. Refresh active instruments by durable oldest-attempt age, at most eight per bounded two-way batch. This avoids starvation; larger catalogues require later cycles and are not promised continuous fresh coverage.
8. Fetch all snapshot pages for a selected range instead of silently truncating it. Very large histories may later need aggregation; no large-dataset browser-performance guarantee is made.
9. Keep display conversions as presentation estimates, validate cached observation age locally, and publish source/quality/time. Browser floating-point presentation never supplies financial settlement authority. An incorrect browser clock can make display estimates unavailable; server financial gates still use database time.
10. Accept the review's exclusion of new empirical provider enablement: the fail-closed gate stands and existing probe evidence remains dated. The cost is continued view-only live markets.
11. Accept the review's exclusions of backup restore, power-loss durability and measured capacity. These require deployment exercises; claiming production readiness without them would be incorrect.

## Handoff

All Important review findings are fixed and verified. Retain the committed branch/worktree for integration choice. Stop the isolated test projects after verification while preserving the PERN acceptance volume. No merge or push is authorized by this handoff.
