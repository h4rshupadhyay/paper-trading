# Re-audit fixes implementation plan

Use superpowers:executing-plans. Goal: resolve R1–R8 in CODEBASE_REAUDIT_2026-11-04.md using the existing market snapshot design, preserving trading/ledger rules.

## Decisions and ledger

- Work on `fix/reaudit-completeness` in the current workspace to retain the existing untracked snapshot design and audit artifacts. No application database migrations or deployment are authorized by this implementation task; use only the guarded disposable test database.
- The existing snapshot plan's no-tests note belongs to an earlier task scope. This audit remediation uses regression tests and verifies on the disposable database. Existing untracked design/plan files remain untouched.
- Snapshot architecture follows the existing design: optional provider statistics, migration 005, atomic last-successful storage, 30-minute successful refresh cadence, 60-minute stale threshold, bounded background work and independent quote eligibility. Negative P/E is valid; volumes are integral; missing metrics remain null. Info prices require validated currency metadata; pence price units are normalized independently of market capitalization.
- R6 chooses accurate labels for existing unrealized metrics rather than adding a new realized-return calculation.

## Tasks

1. Convert audit reproductions to desired-behavior browser regressions. Observe failures. Fix latest-request ownership, atomic folder insertion, incomplete analytics and index null handling. Add dashboard recovery regression and separate error state. Verify browser suite.
2. Add bridge statistics and adapter tests, observe failures, implement validated optional metrics/metadata through bounded bridge and provider. Verify Python/adapter tests.
3. Add persistence/read/refresh tests, observe failures, implement migration 005 and snapshot service/routes. Preserve the existing quote route for callers; use a distinct snapshot endpoint for nonblocking stored reads. Verify SQL privileges, failure preservation, throttling and normalization.
4. Add client/browser snapshot tests, observe failures, implement independent display/polling, change calculation, metadata and timestamp features. Verify end-to-end quote/statistics independence.
5. Run all existing checks, investigate yfinance startup failure, review final diff, update audit results and operational docs. Leave source changes reviewable; do not deploy or migrate application data.

## Verification record

Baseline from preceding audit: 215 integration tests, 20 unit tests, 16 Python tests passed; existing browser/deploy suites passed separately. Combined E2E had an intermittent yfinance initial quote failure, isolated repeat passed. Local Node/npm are below pinned versions; report this limitation.


## Completed work and evidence

- Task 1 complete: five original desired-behavior cases failed on the baseline. Subsequent runs passed pending status ownership, analytics period ownership, atomic folder insertion, missing-FX ownership display and missing-index handling. The separately added dashboard recovery case failed before its fix and passed afterward.
- Task 2 complete: two bridge tests failed with the missing `/statistics` route (404); all 18 bridge tests now pass. Adapter statistics test failed with missing method; validated decimals/metadata now pass.
- Task 3 complete: snapshot module/persistence tests initially failed on absent implementation. Real disposable-PostgreSQL tests now verify normalization, quote/statistics independence, missing fields, last-successful retention through an invoked provider failure, cadence, stale state and restricted permissions. Schema migration is additive; no application database was touched.
- Task 4 complete: frontend snapshot adapter test failed before implementation and now passes. Browser regression verifies stale stored metrics, zero volume, signed P/E, description, trade eligibility and chart-period retention during refresh. Unsupported watchlist metadata columns are removed; creation times are supplied; analytics metric labels now state their actual calculation.
- Task 5 complete: typecheck, 20 unit tests, 223 integration tests, frontend tests, 18 Python tests, full combined production-browser suite and 5 deployment tests passed. Real AAPL statistics request returned all ten supported metrics. Independent review found no critical/important implementation defects. Review identified a throttled test that did not actually invoke its failing provider; corrected both timestamps and asserted the failed call.

Ruling: retain the original blocking `/quote` route and use a distinct `/snapshot` route for nonblocking reads — preserves existing order and other-client behavior while satisfying Stock Detail latency goals.
Ruling: use fixed minimum 60-second failed-statistics retry spacing — bounded retries without extra state; successful refresh spacing remains 30 minutes.
Ruling: never infer daily movement from independent quote/statistics fetches — the required session alignment is unavailable; missing movement stays unavailable.
Ruling: fix controlled startup rejection with bounded Node admission (2 active, 8 waiting), not additional upstream capacity — the failing burst test demonstrated rejection of request three; overflow, timeout and recovery now have coverage.
Ruling: remove unsupported watchlist sector/change columns and label unavailable portfolio sector data — no sector values or percentage changes are fabricated. Stock Detail descriptive metadata is supported through statistics.

Verification outputs for this session are under `/tmp/reaudit-*.log`; durable outcomes are recorded here and in CODEBASE_REAUDIT_2026-11-04.md. The local Node/npm remain 24.16.0/11.13.0 versus the package's declared 24.22.2/11.19.1 minima. Application deployment and migration remain pending; no push, merge or production changes were made.


## Authorized local deployment and operations follow-up

The user's later “yes than do so” authorizes local rebuild/migration, operational follow-ups and a commit. This supersedes the earlier task's no-deployment scope. Keep provider feasibility and original untracked snapshot documents untouched and outside the commit.

- [x] Pin the deployment's full Python dependency graph with hashes and base images by manifest digest; build and verify locked images.
- [x] Set unless-stopped for long-running services; keep migration one-shot. Observe failing restart-policy regression then green, and verify process-exit recovery.
- [x] Save a private pg_dump backup and restore it only into a network-isolated disposable container; verify accounting projections.
- [x] Deploy migration 005 and rebuilt services; verify health, data preservation and AAPL statistics locally.
- [x] Record evidence and commit the intended audit/application/operations changes without unrelated files. Do not push or merge.


Deployment evidence: build succeeded with digest-pinned bases and the CPython3.12/Linuxx86_64 23-distribution hash lock. The locked image passed pip check and 18 offline tests; the pinned Node24.22.2/npm11.19.1 container passed unit20/integration223. Deployment suite6 passed. A private schema004 backup restored in a network-none ephemeral PostgreSQL container and all accounting checks passed. Migration005 preserved exact financial table fingerprints. Local HTTP readiness/auth gates, deployed AAPL ten metrics and existing account reconciliation passed. No smoke trades were submitted against the user's account. Worker process-exit recovery is recorded in /tmp/reaudit-process-recovery.json; backup location is in /tmp/reaudit-backup-path and remains outside git.

Final operations review found no important risks. Commit remains on fix/reaudit-completeness; no push or merge. Three pre-existing provider/design draft files are deliberately excluded from this commit.
