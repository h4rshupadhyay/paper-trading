# First-view statistics and UI refinement

User direction: statistics should fill on a stock's first visit; remove diagnostic copy such as “Statistics: fresh” and simplify the existing interface using Impeccable. Preserve the existing layout, theme, controls and trading rules.

## Changes

- The quote snapshot remains prompt. A separate authenticated statistics read joins the existing bounded background work, allowing the first view to fill immediately when it finishes instead of waiting for the next 15-second poll.
- Stock Detail merges statistics independently, guards obsolete responses and resets loading on each accepted snapshot.
- Remove routine quote/statistics/provider/FX/valuation diagnostics. Put update times in tooltips; show brief loading, unavailable/retry, stale price and review notices only when relevant.
- Move order policy details under More options. Preserve genuine error/recovery controls. The user subsequently requested removing the simulated-fixture label as well; it is removed from Stock Detail.

## Verification

- First-view browser regression failed before implementation, then passed with one quote request and statistics rendered before the next poll.
- Pending-work joining integration regression failed with the missing implementation, then passed.
- Review found a loading-state race and loss of exceptional-state warnings. Both were reproduced with failing browser regressions and fixed; focused re-review found no blocker.
- Workspace typecheck, 20 unit tests, 17 frontend tests, 224 integration tests and the full combined browser suite passed. The HTTP suite's five cases also passed with the new authentication assertion.
- Rendered light/dark desktop (1440px) and mobile (390px) were inspected. Captures are in `/tmp/deslop-visuals`. The Impeccable mechanical detector returned no findings.
- API and frontend rebuilt and deployed locally without a database migration. Services are healthy. Live first-time NVDA lookup: quote 426ms, statistics complete 900ms, with no quote poll needed. No user trades or account records were modified.

Changes are committed locally; no remote push is part of this follow-up.
