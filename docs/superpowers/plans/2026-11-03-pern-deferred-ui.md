# Deferred PERN UI fixes

**Goal:** Resolve the four minor findings in the migration review without changing trading rules or the existing README rewrite.

**Approach:** Repair the existing contracts: render the adapter's order `side`, batch notification reads at the API's 100-ID limit, and return the persisted alert creation timestamp. Load route pages on demand to reduce the initial bundle; retain the existing loading appearance and verify every route.

## Tasks

- [x] Reproduce missing BUY/SELL labels in browser acceptance, then correct `PendingOrders.jsx` to consume `side` and verify both labels and styles.
- [x] Add HTTP-boundary regressions for zero, one, 100, 101 and 205 notification IDs and a failed intermediate batch. Batch sequentially in `alertsAPI.markRead`, preserve errors, and return all successful response items.
- [x] Add a PostgreSQL/HTTP regression comparing alert creation/list timestamps with the stored value. Include `createdAt` in the shared alert projection and verify the Created cell in the browser.
- [x] Measure the current production bundle, load route pages on demand with a visible loading fallback, and verify emitted chunk sizes and all ten routes, including client-side navigation.
- [x] Run frontend tests, backend unit/integration tests, typecheck, production builds, and browser acceptance. Review the diff and record results below.

## Constraints and review focus

- Keep the 100-ID API limit, ownership checks, CSRF and session behavior.
- A failed notification batch must reject the operation; successful earlier batches may be retried safely.
- Use database timestamps, including after an alert triggers; do not invent browser creation times.
- Preserve BUY/SELL text and corresponding positive/negative styles.
- Retain authentication redirects and the application shell while lazy pages load. Do not raise the build warning threshold.
- Use only the isolated disposable PostgreSQL test instance; leave existing volumes alone.

## Verification record

Baseline: existing frontend tests pass; production build emits one 760.41 kB JavaScript chunk and Vite's 500 kB advisory. The shell's default runtime differs from repository pins; subsequent verification uses the existing pinned runtime under `/tmp/paper-trading-verification-runtime`.

Verified on 3 November 2026 with Node 24.22.2/npm 11.19.1:

- `node frontend/test/api.test.js`: the original API call failed the zero/101/205-ID cases and failed-batch regression; all eight API tests pass after batching. All six contract tests also pass, for 14 frontend tests total. `npm run test:web` exits zero.
- The real PostgreSQL/HTTP timestamp regression initially returned `undefined` instead of the stored creation time. The shared projection now returns that timestamp on creation and listing, unchanged after triggering.
- Browser acceptance initially showed empty SELL and BUY side cells. It now verifies both their text and negative/positive styles, including cancellation of a triggered BUY order.
- `npm run typecheck` and `npm run test:foundation` exit zero: 20 unit tests and 195 integration tests across 19 files. Backend builds pass.
- `npm run test:e2e` now builds the frontend and tests production assets through Vite preview against the isolated real API/database. All ten routes pass, including registration/login, trades, owned tools, alert dates, BUY/SELL labels, cancellation, analytics, FX expiry, and logout, with no browser or normal-flow API errors.
- Browser acceptance seeds more than 200 unread notifications for the Alerts page and another 101 for the header dropdown. Both controls mark every persisted notification read; every observed mutation contains 1–100 IDs.
- The delayed-chunk test first exposed an incorrect test assumption: React Router retains the old page during a client-side transition. The final test verifies that behavior, sidebar preservation, successful navigation when the chunk arrives, and the loading fallback for a separate cold deep link.
- Production build: 24 JavaScript chunks, main entry approximately 258.35 kB, largest chunk 380.75 kB. An artifact check confirms every JavaScript chunk is below 500 kB. The Vite chunk advisory is gone without increasing its threshold. These are build sizes, not measured download or load-time improvements.
- Independent read-only review found no concrete issues in the scoped changes. Its exclusions were final database/browser results and chunk measurements (verified separately above), and the pre-existing README rewrite (left untouched).
- `git diff --check` passes. Changes remain uncommitted for review.
