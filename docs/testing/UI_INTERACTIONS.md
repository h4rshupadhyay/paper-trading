# Browser interaction audit

This inventory records interactions supported by the retained React UI and distinguishes executable coverage from remaining manual work. It does not claim that every possible browser, accessibility combination, or input string has been tested.

## Reproducible isolated run

Build the frontend first (`npm run build:web`), then run:

```sh
TEST_DATABASE_ADMIN_URL=postgresql://paper_test_admin:paper_test_admin_only@127.0.0.1:55439/paper_foundation_test_admin npm exec --workspace @paper/server -- tsx test/interactions.browser.e2e.ts
```

`AUDIT_CASE=UI-003` (or any substring of a printed scenario name) selects an individual case. UI-005 expands to eight independent scenarios: BUY and SELL for MARKET, LIMIT, STOP_LIMIT, and STOP. The current suite contains 25 independent scenarios. The suite runs real Express, migrations, PostgreSQL services, fixture quotes, the Vite production preview, and headless Chrome. Every scenario seeds a fresh account/session through the real registration, password-hashing and login services in a fresh browser context. This avoids exhausting the public 20-attempt/IP authentication throttle; public HTTP registration/login are tested separately. Protected actions still use the real session cookie and CSRF endpoint. The guarded harness accepts only the loopback test database instance on port 55439, creates a random database, and drops it in `finally`. Browser, preview process, and HTTP server are also closed in `finally`.

Seeds are created through authenticated APIs: a five-share market buy for SELL scenarios, 23 real limit orders for pagination, and one custom folder for the stock picker. Alert notifications are produced by the real `evaluateAlerts` worker operation. No user account, application database, live market provider, or external messaging is involved. Assertions inspect persisted HTTP resource state, not just transient toasts. Every scenario checks that the browser emitted no uncaught JavaScript errors.

## New executable interaction inventory

The [internal API refresh follow-up](INTERNAL_API_REFRESH_2026-11-04.md) extends this inventory with UI-029–UI-034: immediate cross-view reads, visible-only background checks, writes independent of follow-up GETs, non-overlap/stale-read protection, initial-load reconciliation and ID deduplication. The current suite has 25 scenarios; the initial execution record below describes the earlier 19-scenario run.

A mistyped `AUDIT_CASE` filter that matches no scenarios exits nonzero; a zero-case run is not a successful check.

UI-035 subsequently extends the suite to 26 scenarios: seed the demo with real restricted-role services, sign in through the normal login form, and verify three dashboard holdings, cash/reconciliation, two notes, three pending orders and three watchlist entries. See [demo-user verification](DEMO_USER_2026-11-04.md).

| Case | Surface and actions | Data and assertions |
| --- | --- | --- |
| UI-001 | Empty watchlist; New list; disabled empty Create; type name; Cancel; reopen and Create; double-click rename; Enter save | Cancel leaves no folder; real folder creation and rename persist |
| UI-001 | Add AAPL to selected custom list; add same symbol again | One persisted entry, selected folder UUID and name preserved; duplicate never produces a second row |
| UI-001 | Hover list tab; delete dialog Cancel; delete dialog Confirm | Cancel keeps list; confirm deletes folder and moves its entry to the default folder |
| UI-001 | Remove watchlist entry | Empty state returns and API reports zero entries |
| UI-002 | Stock Watch; show folder picker; outside click; reopen; choose custom folder | Picker dismisses; add persists directly to selected folder |
| UI-002 | Reload stock; Unwatch | Reload retains watched state; removal leaves API empty |
| UI-003 | Empty notes; New; empty and whitespace title | Save disabled; no empty-title mutation |
| UI-003 | Type title, multiline body, ticker; Save | New note persisted with AAPL association |
| UI-003 | Edit title/body; Save; Close; reopen note | Updated values survive editor close and API read; ticker association retained |
| UI-003 | Delete note dialog Cancel, then Confirm | Cancel retains resource; confirm removes list row and returns HTTP 404 |
| UI-004 | Empty alerts; submit blank form | Visible validation error |
| UI-004 | Fill ticker/target; toggle ABOVE/BELOW; submit both | Two real persisted conditions; worker creates two notifications |
| UI-004 | Mark one notification read; Mark all read | Actual unread API count falls 2 → 1 → 0 |
| UI-004 | Show all; Show unread; delete both alerts | Read notifications retained in all view; unread view empty; alert deletion durable |
| UI-005 (8 scenarios) | Open Trade; switch BUY/SELL; choose each order type | Side label, disabled Price/Trigger inputs, supported CNC-only interface |
| UI-005 (8 scenarios) | Empty quantity; zero quantity; fractional quantity | Submit disabled for empty/zero; exact 1.25 quantity persisted |
| UI-005 (8 scenarios) | Enter limit/stop fields as applicable; More options; future expiry; Hide options; Submit | Exact type, side, instrument, prices, expiry and quantity persisted; market FILLED and conditional orders OPEN |
| UI-006 | Pending New Order; blank ticker; invalid ticker; valid ticker recovery | Continue disabled for blank; invalid ticker error; correction opens full order form |
| UI-006 | Enter order quantity; Cancel; repeat and outside click | Both dismissal paths close modal without creating an order |
| UI-006 | Seed OPEN order; Cancel order; visit each status tab | Cancellation durable; CANCELLED row appears; OPEN/TRIGGERED/FILLED/REJECTED/EXPIRED empty states are distinct |
| UI-007 | Seed 23 real orders; history Next; Back; row stock navigation | 20 + 3 unique IDs; no duplicate/missing rows; edge controls disabled; back restores original first page; stock link routes correctly |
| UI-008 | Theme light/dark; region United States; reload | DOM theme, region code, and localStorage persist |
| UI-008 | Search AAPL; Escape; invalid query; corrected query; ArrowDown; Enter | Dropdown dismissal, empty result recovery, selection aria state, stock navigation, cleared query |
| UI-009 | LIMIT missing limit; SL-M missing trigger; SL missing trigger | Specific validation errors retain editable form |
| UI-009 | Past expiry; submit | Visible error, modal retained, no order persisted |
| UI-009 | Market SELL with no owned shares | Visible rejection, modal retained, durable REJECTED order, no position created |
| UI-026 | Market SELL from a fresh empty account | Readable insufficient-shares error; SQL before/after cash balance, cash sequence, movements, executions and positions identical; one durable REJECTED order |
| UI-027 | Stock chart: click 1D/5D/1M/3M/6M/1Y/5Y; Candle; Line; Refresh price | Each real history request has exact period/interval and nonempty fixture bars; active controls and actual line/candle SVG renderers change; quote snapshot refresh retains chosen period/type |
| UI-028 | Analytics: click 7D/1M/3M/6M/1Y; Refresh | Real snapshot requests have exact day ranges, return both seeded valuations and render an area chart; refresh retains 1Y |
| UI-028 | Seed holding; view composition; Dashboard chart Refresh and Holdings Refresh | Real portfolio/valuation data, allocation chart and cash/holdings labels; honest missing-sector message; both dashboard refresh controls issue successful real requests and retain chart/holding |

## Existing executable coverage retained

These suites provide complementary coverage and must be run separately; their presence is not evidence of a fresh passing run.

| Cases | Suite | Existing interactions / failure points |
| --- | --- | --- |
| UI-010 | `browser.e2e.ts` | Register, login, route navigation, lazy page transitions, stock market buy, account movements, portfolio totals, currency conversion, pending triggered-order cancellation, create note, large notification batches and both mark-all controls |
| UI-011 | `audit.browser.e2e.ts` | Stock-route quote race; accepted trade followed by failed account refresh; candle direction and chart axes; selected folder UUID |
| UI-012 | `audit.browser.e2e.ts` | Note load/open/save/delete errors; retry; preserve drafts; late open/save/delete responses; saving invalidates earlier pending open |
| UI-013 | `audit.browser.e2e.ts` | Pending list load failure; alert load/delete errors; notification load/mark-read errors; bell errors; watch removal errors; stock watch errors; folder create/rename errors preserve names |
| UI-014 | `catalogue.browser.e2e.ts` | Late catalogue, shared request caching, focus retry, route retry, region filtering, keyboard suggestion selection, outside focus, empty catalogue manual-symbol recovery |
| UI-015 | `completeness.browser.e2e.ts` | Pending status response race; atomic selected-folder add regression; analytics period response race; missing FX with real holdings |
| UI-016 | `completeness.browser.e2e.ts` | Missing and stored statistics; zero volume; negative P/E; independent freshness; refresh and chart-period retention; warning states; dashboard history/portfolio failure and refresh recovery |
| UI-017 | `yfinance.browser.e2e.ts` | Controlled local yfinance HTTP bridge; register/login; stock market trade with old source time and UNKNOWN session; exact ledger price/FX and balanced account |

## Remaining interaction and failure-point work

| Case | Remaining verification | Why it is still separate |
| --- | --- | --- |
| UI-018 | Mobile/touch folder delete discovery, modal layout and browser zoom | Current new suite uses desktop Chrome at 1440×1000; screenshots alone do not establish touch usability |
| UI-019 | Full keyboard-only journey, focus trap/return, screen-reader labels, contrast | New cases verify selected keyboard controls, not complete accessibility |
| UI-020 | Session expiry during each mutation; logout during an in-flight request; cross-tab account switch | Authentication HTTP integration coverage is separate from full browser journeys |
| UI-021 | Browser refresh/back/forward during pending trade submission; transport loss after server acceptance | Existing idempotency and error coverage does not enumerate every navigation/network timing |
| UI-022 | Maximum permitted text lengths, Unicode, all decimal precision boundaries, negative/huge/unsupported currency inputs in each form | New suite covers representative blank/zero/missing/past/unknown/rejected values; service/API boundary tests cover other cases |
| UI-023 | Every history/status page with >100 orders and concurrent inserts; notes/alerts/watchlist very large collections | New history case crosses the actual 20-row UI boundary; notification batching is already tested in the original suite |
| UI-024 | Portfolio refresh after every order path; range switching during arbitrary concurrent market updates | UI-027/028 now click every visible stock/analytics period and both renderers and dashboard refresh controls. Dashboard has no range buttons; allocation charts are display-only, with no allocation action buttons. Cartesian combinations remain unenumerated |
| UI-025 | Chromium alternatives, Firefox/WebKit, slow devices, reduced motion, offline reconnect | This run is one production build in headless desktop Chrome |

## Execution record

Date: 2026-11-04. Branch: `fix/reaudit-completeness`.

- Frontend production build was prepared by the coordinating audit process (`npm run build:web`, exit 0).
- Initial targeted authoring run: **9 passed, 7 failed**, exit 1. These were test-driver issues: list delete icon requires hover; the styled Buy/Sell checkbox is overlaid by its visible switch track and must be clicked through its label; the invalid ticker picker message is `Ticker not found`. The test now performs those actual visible interactions and checks the actual intended error text. Persisted resource assertions were retained.
- Corrected complete targeted run: **16 passed, 0 failed**, exit 0. Log: `/tmp/interactions-browser-rerun.log`.
- Additional focused run after tightening past-expiry error to the exact text `Expiry must be in the future`: **1 passed, 0 failed**, exit 0 (`AUDIT_CASE=UI-009`). Log: `/tmp/interactions-browser-validation.log`.
- The original 16 scenarios left no functional failure. A stricter UI-026 readability regression was then added and reproduced the issue below. This expands the suite to 17 scenarios.
- Focused UI-026 after the coordinating process fixed rejection copy: **1 passed, 0 failed**, exit 0, log `/tmp/interactions-browser-rejection-green.log`.
- Complete run after that production fix: **17 passed, 0 failed**, exit 0, log `/tmp/interactions-browser-final17.log`.
- Added visible chart-control scenarios UI-027/028. Focused `AUDIT_CASE=UI-02` run: **3 passed, 0 failed**, exit 0, covering UI-026/027/028, log `/tmp/interactions-browser-controls.log`. Together with the preceding full run, all **19 final independent scenarios** have passed on the same rebuilt frontend. The two new cases do not change the preceding scenarios.
- No production files, scripts, or existing tests were modified by this interaction audit.

Fixed UI-026 failure (red reproduction retained in execution history): a rejected market sell displays the raw `INSUFFICIENT_POSITION` rejection reason. Reproduction: fresh empty account → AAPL → Trade → switch to Sell → quantity 1 → Sell. The order is correctly stored as REJECTED and holdings remain empty. The stricter test requires `You don’t have enough shares to sell.` (straight apostrophe also accepted). The focused red run exited 1 with **0 passed, 1 failed**, log `/tmp/interactions-browser-rejection-red.log`. SQL verified unchanged cash balance, cash sequence, movement count, execution count and position count before the readability assertion failed. The API retained one REJECTED order. The coordinating audit process fixed display copy through the shared rejection helper. The focused and complete green runs above confirm the readable explanation; API rejection codes remain machine-readable.

Existing suites listed above were inspected for coverage overlap; this execution record reports only the new interaction suite and focused rerun. Their aggregate execution results belong to the coordinating audit report.
