# Catalogue loading fix

**Goal:** fix the two catalogue-loading bugs selected by the user, with TDD and one task commit on local main.
**Spec:** the shared-catalogue follow-up in docs/CODEBASE_AUDIT_2026-11-04.md and the user's selection of item 1.
**Design:** retain the two existing controls and their region filters/result limits. Use one small catalogue service for successful data and pending requests, plus a React hook that ignores completion after unmount. Successful empty data is cacheable; failed requests must not poison the cache. Focus/remount retries unavailable data. Loaded data must recompute suggestions for the current input. Preserve remote fallback search and its obsolete-response guards. No new dependency or timer-based polling.
**Alternatives:** patching two independent caches retains duplication; a query library is unnecessary for this one resource. The shared loader/hook is the implementation choice.
**Test seam:** existing production browser UI and HTTP timing/failure boundary, as used for the approved audit fixes. Test the real API/database; no private state assertions. A separate catalogue browser runner avoids exceeding the audit runner's per-process authentication limit.

- [x] Hold the catalogue response, type in a form input, release it: observe missing suggestions (RED); make readiness reactive (GREEN).
- [x] Fail initial catalogue loading, then recover on focus/remount without reloading the page: observe poisoned cache (RED); share successful/pending data and permit retries (GREEN).
- [x] Verify header search also reacts to late catalogue data, retains remote fallback guards, and shares the request with form suggestions. Preserve region filtering and keyboard selection.
- [x] Run frontend checks/typecheck and original, yfinance, audit and catalogue browser workflows. Review, commit this task, update the local web app and remove only disposable test resources.

Files: StockSearch.jsx and TickerInput.jsx; new services/tickerCatalogue.js and hooks/useTickerCatalogue.js; apps/server/test/catalogue.browser.e2e.ts; package.json test scripts; audit/this verification record. The deferred provider research remains untouched.

## RED/GREEN evidence

1. RED: typing RELIANCE before the form catalogue arrived left no suggestions after releasing the HTTP response. GREEN: catalogue readiness is React state and part of the filter dependencies; keyboard selection resolves to RELIANCE.NS.
2. RED: header search waited on a held remote search after catalogue arrival. GREEN: current-query local filtering reruns on data arrival and ignores the older empty fallback response.
3. RED: a failed catalogue stayed empty after healthy service was restored and the input refocused. GREEN: failed loads leave no cached success/pending promise; focus/remount can retry. Both controls share the loader/filter and one pending HTTP request, and route remounts reuse successful data.
4. RED during regression checking: late data reopened a dropdown after focus left its input. GREEN: local suggestions open only while focus is inside the control; refocus still shows the computed results.

Eight catalogue browser scenarios pass, including successful-empty caching/manual symbols, focus and route retry, pending/successful request sharing, late data/fallback ordering, region filtering and keyboard selection. Independent review found no blockers. The final gate passed: npm run typecheck; npm run test:web (16 tests); npm run test:e2e (original production workflow, yfinance trading, all 19 audit scenarios and all eight catalogue scenarios). The targeted runner is npm run test:browser:catalogue. No backend, trading-policy or database-schema changes were needed.

Local web image rebuilt successfully with --no-deps; frontend returned HTTP 200 and /api/health/ready returned ok. API, worker, market-data and database remained running. Disposable test PostgreSQL was stopped and removed; application data and deferred provider research were preserved. One task commit on local main; no push requested.
