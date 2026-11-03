# Audit fixes with task-based commits

**Goal:** fix the nine prioritized bugs in the approved codebase audit, using a failing behavioral regression before each implementation and one commit per task.

**Spec:** `docs/CODEBASE_AUDIT_2026-11-04.md` and the user's approved priority list. The user selected TDD and task-based commits; execute in this session without another planning approval.

**Architecture:** keep React, Express/PostgreSQL and the private yfinance bridge. Test existing public interfaces: browser interactions and HTTP responses, authenticated resource APIs against disposable PostgreSQL, MarketData's quote interface with the external library controlled, and actual Compose/nginx behavior for deployment changes. No financial calculations move to browser numbers. No synthetic provider fallback or delayed-data label is introduced.

**Workspace:** branch `fix/audit-tdd` in the existing IDE checkout, preserving its data/configuration. Existing work was committed separately as yfinance, visual cleanup, and audit documentation baselines. The unrelated deferred free-provider research stays outside these commits. No application database or volume is reset.

## Tasks and verification

- [ ] **1 — stale UI responses:** browser regression for late stock response versus current route; then late note read versus new draft; then chart-period and search responses. Implement one guard/reset at a time. Verify the affected browser cases and frontend checks. Commit `fix: ignore obsolete UI responses and preserve drafts`.
- [ ] **2 — accepted-order feedback:** commit a real order while rejecting the subsequent account refresh; assert success and exactly one order through the public HTTP API. Separate refresh failure from submission. Commit `fix: preserve successful order outcome during refresh failures`.
- [ ] **3 — candle accuracy:** known rising/falling OHLC rendered in Candle mode; assert direction and positions against the plotted price axis. Replace the incorrect per-bar/hard-coded scale. Commit `fix: render candles against the actual price scale`.
- [ ] **4 — folder UUID:** select a named folder through the Add form; assert the resulting entry's folder through the API. Preserve UUID strings. Commit `fix: preserve watchlist folder UUID selections`.
- [ ] **5 — visible failures:** failed note save preserves draft and displays retryable error; extend the pattern to loads and other audited tools in vertical slices. Commit `fix: surface resource errors without discarding user input`.
- [ ] **6 — watchlist quality:** authenticated watchlist response for a recently received old/UNKNOWN yfinance quote agrees with quote availability; expired receipts remain stale. Align the query without weakening execution checks. Commit `fix: apply yfinance receipt policy to watchlist quotes`.
- [ ] **7 — duplicate misses:** concurrent public quote requests for the same key share upstream work while another key can progress; failure permits retry and limits remain bounded. Python offline RED/GREEN. Commit `fix: coalesce concurrent market-data cache misses`.
- [ ] **8 — default startup:** invoke default Compose configuration with controlled env and assert PERN services; archive legacy entry point, preserve project/volume and explicit PERN command. Commit `fix: make PERN the default compose entry point`.
- [ ] **9 — trusted proxy:** actual nginx distinguishes forwarded clients from a configured trusted peer and ignores spoofed forwarded addresses from untrusted peers; trusted ingress remains opt-in. Commit `fix: preserve client identity through trusted ingress`.

Each task records the failing assertion, passing command, and commit below. Before each commit run relevant checks and inspect its staged diff. Final verification: typecheck, backend unit/integration, frontend unit, Python, full original/yfinance/audit browser workflows, and deployment tests. Review the combined fixes, then update the local app without changing stored data. Infrastructure tests use temporary resources and never the active database.

## TDD ledger

Pending.
