# Audit fixes with task-based commits

**Goal:** fix the nine prioritized bugs in the approved codebase audit, using a failing behavioral regression before each implementation and one commit per task.

**Spec:** `docs/CODEBASE_AUDIT_2026-11-04.md` and the user's approved priority list. The user selected TDD and task-based commits; execute in this session without another planning approval.

**Architecture:** keep React, Express/PostgreSQL and the private yfinance bridge. Test existing public interfaces: browser interactions and HTTP responses, authenticated resource APIs against disposable PostgreSQL, MarketData's quote interface with the external library controlled, and actual Compose/nginx behavior for deployment changes. No financial calculations move to browser numbers. No synthetic provider fallback or delayed-data label is introduced.

**Workspace:** branch `fix/audit-tdd` in the existing IDE checkout, preserving its data/configuration. Existing work was committed separately as yfinance, visual cleanup, and audit documentation baselines. The unrelated deferred free-provider research stays outside these commits. No application database or volume is reset.

## Tasks and verification

- [x] **1 — stale UI responses:** browser regression for late stock response versus current route; then late note read versus new draft; then chart-period and search responses. Implement one guard/reset at a time. Verify the affected browser cases and frontend checks. Commit `fix: ignore obsolete UI responses and preserve drafts`.
- [x] **2 — accepted-order feedback:** commit a real order while rejecting the subsequent account refresh; assert success and exactly one order through the public HTTP API. Separate refresh failure from submission. Commit `fix: preserve successful order outcome during refresh failures`.
- [x] **3 — candle accuracy:** known rising/falling OHLC rendered in Candle mode; assert direction and positions against the plotted price axis. Replace the incorrect per-bar/hard-coded scale. Commit `fix: render candles against the actual price scale`.
- [x] **4 — folder UUID:** select a named folder through the Add form; assert the resulting entry's folder through the API. Preserve UUID strings. Commit `fix: preserve watchlist folder UUID selections`.
- [x] **5 — visible failures:** failed note save preserves draft and displays retryable error; extend the pattern to loads and other audited tools in vertical slices. Commit `fix: surface resource errors without discarding user input`.
- [x] **6 — watchlist quality:** authenticated watchlist response for a recently received old/UNKNOWN yfinance quote agrees with quote availability; expired receipts remain stale. Align the query without weakening execution checks. Commit `fix: apply yfinance receipt policy to watchlist quotes`.
- [ ] **7 — duplicate misses:** concurrent public quote requests for the same key share upstream work while another key can progress; failure permits retry and limits remain bounded. Python offline RED/GREEN. Commit `fix: coalesce concurrent market-data cache misses`.
- [ ] **8 — default startup:** invoke default Compose configuration with controlled env and assert PERN services; archive legacy entry point, preserve project/volume and explicit PERN command. Commit `fix: make PERN the default compose entry point`.
- [ ] **9 — trusted proxy:** actual nginx distinguishes forwarded clients from a configured trusted peer and ignores spoofed forwarded addresses from untrusted peers; trusted ingress remains opt-in. Commit `fix: preserve client identity through trusted ingress`.

Each task records the failing assertion, passing command, and commit below. Before each commit run relevant checks and inspect its staged diff. Final verification: typecheck, backend unit/integration, frontend unit, Python, full original/yfinance/audit browser workflows, and deployment tests. Review the combined fixes, then update the local app without changing stored data. Infrastructure tests use temporary resources and never the active database.

## TDD ledger

### Task 1 — obsolete UI responses

RED: the production browser reported AAPL instead of RELIANCE.NS after releasing a held old quote; Existing note instead of New draft after a held read; AAPL instead of newer local Reliance search results. Each regression was run before its minimal implementation. GREEN: `npm run test:browser:audit` passes all three cases; `npm run typecheck` and16 frontend tests pass. Instrument-keyed mounting also resets route-specific order/chart state. Note request generations invalidate reads on New/Close/unmount; search effect cleanup ignores obsolete success/error/finally results.

Ruling: the chart hides its period controls while loading, so selecting a second period during a held request is not an available user action. An attempted test demonstrated a test-design problem rather than an additional product bug and was discarded. Cross-instrument chart state is reset by the keyed instrument mount; no speculative extra chart state machinery was added.

### Task 2 — accepted order versus account refresh

RED: an actual filled order followed by a503 account refresh left the order modal open (`expected count0, received1`). GREEN: all4 audit browser cases and16 frontend tests pass; typecheck passes. Submission acknowledges/ closes independently of account refresh; the account context exposes a separate retryable warning, and the regression verifies exactly one FILLED order through HTTP and successful warning recovery.

### Task 3 — candle direction and projection

RED: a known rising100→110 candle rendered red. GREEN: the browser now verifies rising/falling colors, body100–110 and wick90–120 coordinates against the existing independent line renderer's projection; all5 audit cases pass and typecheck/frontend tests pass. Recharts range bars supply scaled low/high geometry, eliminating the per-bar hard-coded210px span; raw prices determine direction. Axis label text positions are intentionally adjusted/rounded by Recharts, so the regression uses actual line geometry rather than treating label text coordinates as the exact scale.

### Task 4 — folder UUID selection

RED: selecting a named folder through the Add form returned Invalid request and no entry because the UUID was converted to a number. GREEN: the browser adds the instrument and confirms its exact folder UUID through authenticated HTTP; typecheck and16 frontend tests pass. Folder values remain strings, with an empty selection mapped to null.

### Task 5 — visible failures and retained input

RED, in successive browser slices: missing error for failed note save/list/open/delete, order list, alert list/delete, notification list/read, watchlist removal, bell load/read, and stock watchlist load/add/remove; failed open hid an unsaved note; late create made the next Save overwrite the earlier note; late delete closed a newer draft; a pending open replaced the current note after Save; failed folder create/rename discarded names. Each failure was observed before its implementation. GREEN: the full original production browser workflow, yfinance trading workflow and all19 audit scenarios pass; typecheck and16 frontend tests pass. A small ResourceError component supplies accessible feedback/retry, inputs and existing data remain available after failures, and editor generations cover reads and mutations. Independent review found no remaining blockers.

### Task 6 — watchlist receipt policy

RED: a recently received old/UNKNOWN yfinance quote returned STALE instead of FRESH; then a future receipt incorrectly returned FRESH instead of STALE. GREEN:21 targeted tools/yfinance integration tests and the complete215-test integration suite pass. The watchlist uses receipt age for yfinance and keeps source-age/session rules for fixture/Yahoo, missing quotes UNAVAILABLE and expired/future inputs STALE. Existing uppercase DTO quality names and execution checks are preserved. Independent review found no blocker.
