# Internal API refresh behavior — 4 November 2026

Internal API reads and writes have no client-side rate-limit delay. Initial loads, retries and user actions run immediately. Successful mutations update visible state from the confirmed server response; they do not wait for a polling tick or an unnecessary second list request.

This follow-up to the [interaction audit](INTERACTION_FAILURE_MATRIX.md) changes client refresh behavior only. It does not bypass authentication, cache private data between accounts, change financial accounting or claim zero network/database latency.

## Refresh policy

| Data | Immediate path | Background behavior |
| --- | --- | --- |
| Notification bell | Initial load, opening the dropdown, retry; a successful read batch immediately removes matching unread IDs everywhere on the page | 60 seconds while visible; immediate refresh when the tab becomes visible |
| Alerts and notification page | Initial load, unread/all filter, retry; create/delete/read apply their confirmed results immediately | 60 seconds while visible; immediate refresh on return; old content remains visible during background work |
| Notes | Initial load and retry; create/update/delete apply confirmed records directly | No interval polling |
| Watchlist entries and folders | Initial load/manual refresh; add/create/rename/remove apply confirmed records directly | No interval polling. Folder deletion rereads the merged list. A read superseded by a write is silently reconciled with a fresh read |
| Account identity/cash | Initial session/login/account refresh and completed market trade | No new interval polling; financial balances remain server-confirmed |
| Orders/executions | Existing page/status/pagination loads and user actions | No new interval polling or server-push stream introduced |
| Portfolio/snapshots | Existing page/range loads and manual refresh | No new interval polling |
| Stock quote/index/FX | Existing external market-data behavior | Unchanged: stock 15 seconds, index/FX 60 seconds |

Previously the Alerts page ran two internal reads every 15 seconds and its bell ran another read every 30 seconds. These now run every 60 seconds, skip hidden tabs and avoid overlapping their own background work. Mount/open/filter/retry requests remain immediate. The bell and page can each request their own notifications; this is not a persistent shared-cache implementation.

Worker-created notifications/alert triggers become visible on the next background check, opening the bell, or returning to the tab. Reading a notification yourself synchronises the current page immediately. Cross-tab/server push and sub-second worker delivery are outside this change.

## Correctness while updating immediately

- Notification events are emitted after each committed batch of up to 100 IDs, including partial success before a later batch fails. Failed writes do not emit success. The page and bell update the returned IDs; in-flight older reads cannot restore them. Existing action errors and retries remain available.
- Background refresh keeps the current rows visible. A slow background callback does not start another copy every minute.
- Notes and watchlist reads track request order and a mutation revision. A read started before a successful local write cannot replace the confirmed result. It triggers a nonblocking reconciliation read to recover other records that were not yet loaded. A later read/error cannot override a newer request.
- Watchlist creation updates by stable IDs, so a concurrent read that already observed a committed record cannot produce a second row/tab when its delayed POST response arrives.
- No financial write is shown as successful before the server confirms it. Market provider cadence and eligibility rules are unchanged.

## Regression evidence

The new browser cases run real Express/PostgreSQL and seeded records in the guarded disposable database. Only clocks and response timing/failure boundaries are controlled.

The expanded feature suite seeds each identity/session through the real registration, hashing and login services, then uses the real session cookie and CSRF endpoint for protected HTTP actions. Its first aggregate run reached the genuine 20-attempt/IP registration throttle after 20 scenarios (20 passed, 5 setup failures with HTTP 429). Fixture setup was moved out of the public auth endpoints; the production throttle was not relaxed. Existing public register/login/browser journeys and rate-limit tests remain separate correctness gates.

| Case | Assertion and observed baseline failure |
| --- | --- |
| UI-029 | Read from Alerts and from the bell; both unread displays update within the UI assertion window without advancing any timer. Baseline: bell retained badge `1` after the page read committed |
| UI-030 | Initial requests happen immediately; no internal requests by 31 seconds; fallback requests appear after a minute; no requests across two hidden minutes; return-to-visible refreshes immediately. Baseline: requests already increased by 31 seconds |
| UI-031 | Abort subsequent note/watchlist aggregate GETs; confirmed new note, folder, rename and entry still render. Baseline: saved note absent after its unnecessary list read failed; entry similarly absent before its follow-up read was removed |
| UI-032 | Hold both background notification reads, advance another two minutes, verify only those two are pending and rows remain actionable; read a notification; release old unread snapshots and verify neither view restores it |
| UI-033 | Hold the initial notes/watchlist snapshot; create while it is pending; show the confirmed record immediately; release the old snapshot and verify both earlier and new records remain. Baseline: confirmed note hidden behind the outstanding list load |
| UI-034 | Hold a POST response after commit; allow a manual GET to see the committed record; release POST and wait for React to apply it. Exactly one folder/entry remains. Baseline: two identical folder tabs |

Six additional scenarios extend the interaction suite from 19 to 25.

## Final verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run test:web` | 17 passed |
| `npm run test:foundation` | 20 unit + 408 integration passed |
| `npm run test:e2e` | All six scripts passed in a single final invocation, exit 0; 62 named scenarios plus the two broader register/login/trade/provider workflows |
| New interaction script within aggregate | 25 passed, 0 failed, including UI-029–UI-034 |
| Independent review | Initial stale-list/duplicate findings reproduced and fixed; follow-up found no further concrete must-fix |
| `git diff --check` | Passed |

Production frontend/workspace builds ran in the E2E command. All checks used isolated databases and the host toolchain described in the preceding audit; no new hosted CI run or deployment is claimed. Python/deployment tests were not repeated for this frontend-only change. Final local logs: `/tmp/internal-refresh-e2e-final.log`, `/tmp/internal-refresh-foundation-final.log`, `/tmp/internal-refresh-web.log`; focused edge ordering checks: `/tmp/internal-edge-final.log`.

## Reproduce

```bash
npm run test:db:up
npm run typecheck
npm run test:web
npm run test:foundation
npm run test:e2e
```

The new cases are included in `npm run test:e2e` and `npm run test:browser:interactions`. A focused run after `npm run build:web`:

```bash
AUDIT_CASE=UI-030 \
TEST_DATABASE_ADMIN_URL=postgresql://paper_test_admin:paper_test_admin_only@127.0.0.1:55439/paper_foundation_test_admin \
  npm exec --workspace @paper/server -- tsx test/interactions.browser.e2e.ts
```

No live application records, environment secrets, deployment or provider settings were changed. No dependencies were added.
