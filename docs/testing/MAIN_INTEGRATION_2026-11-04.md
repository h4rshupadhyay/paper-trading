# Main integration — 4 November 2026

## Branch relevance

Fetched all configured remotes before evaluating the branch tips. The starting
remote main is `597bfd8`; local main was `d231c40` and will fast-forward through
the existing audit/UI/test history.

| Branch | Reviewed tip | Decision |
| --- | --- | --- |
| `fix/reaudit-completeness` | `c9b8e79` before this integration | Include the yfinance 1.7.0 → 1.8.0 upgrade and shared streaming. Commit the completed working-tree demo/history feature and its tests/documentation. |
| `feat/yfinance-streaming` | `84ff12e` | Its patch and tree match the streaming commit `c9b8e79`. Retain both branches' commit history through a merge, with one effective implementation. |
| `origin/postgres-migration` | `f6a255c` | Exclude the old Oracle-oriented README rewrite. Its setup, Oracle triggers and stack description conflict with today's PERN application and current/archived documentation. |
| `origin/temp` | `ead6bdd` (also `f1a79bf`) | Exclude legacy Flask/Oracle scheduler, migrations, seed and setup edits. They predate the PERN implementation and target retired paths; applying them would change old backend behavior and reintroduce incompatible setup/account-balance instructions. No active PERN feature depends on them. |

No branch is deleted, no commit is rewritten and no force push is used. Private
local environment files remain ignored. Source fixtures contain only deterministic
test data; private downloaded provider history/backups remain outside the repo.
Screenshot artifacts show demo/test-only accounts and support the recorded visual
checks. Provider research and original snapshot design are kept as historical
records, with links explaining the current implementation where superseded.

## Integration adjustments

- Added the portfolio-history range/race/responsive browser workflow to standard
  `test:e2e`, alongside the seven existing scripts.
- Moved CI's matching Chromium installation before frontend tests because the
  frontend suite now includes a browser-rendered chart regression.
- Added the demo/history changes to `CHANGELOG.md`.
- Independent review inspected historical replay, guarded upgrades, action-aware
  reconciliation, source export and range query. It found no demonstrated blocking
  defect. Review limits: it did not repeat the full suite; replay tests reconcile
  the final account, while the maintenance implementation does not add a second
  in-transaction reconciliation gate. Historical sample quality remains available
  in API/provenance rather than a new routine chart label.

## Final checks

The final backend run passed **20 unit and 459 integration tests**. Typecheck,
the root and frontend builds, **29 frontend tests**, **38 provider/streaming
Python tests**, and **6 deployment checks** passed. The complete browser
workflow passed: production navigation and trading, yfinance trading, audit and
catalogue regressions, completeness cases, **26 interaction scenarios**, shared
streaming, and the portfolio range/race/responsive scenario. The Dashboard
history recovery regression initially clicked the generic Holdings refresh
button; its selector now targets the labeled history refresh button and the
focused and complete browser runs pass. `git diff --check` is clean.

Evidence: `/tmp/main-integration-foundation.log`,
`/tmp/main-integration-typecheck.log`, `/tmp/main-integration-web.log`,
`/tmp/main-integration-python.log`, `/tmp/main-integration-deploy.log`, and
`/tmp/main-integration-e2e-verified.log`. The integration revision is recorded
in the final handoff after the main branch is updated.
