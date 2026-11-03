# Six-region live provider validation

**Goal:** Establish current provider suitability with dated evidence while keeping unsupported live trading disabled.

**Scope:** US/Nasdaq, India/NSE, UK/LSE, Europe represented by Germany/Xetra, Japan/Tokyo, and Hong Kong. A representative symbol does not validate an entire exchange or every European venue.

- [x] Commit the existing README and four UI fixes before this work: `b450766`.
- [x] Investigate official provider documentation and record coverage, delays, entitlements and unknowns in `docs/PERN_PROVIDER_RESEARCH.md`.
- [x] Add a repeatable probe using the real provider, PostgreSQL normalization, isolated test harness and trading gate. Keep prices as decimal strings; cap one Yahoo run below its 24-call/minute process budget.
- [x] Cover the probe with deterministic database tests for six-region fixture trading, live view-only rejection, missing discovery and unavailable data.
- [x] Execute the probe against Yahoo; preserve dated evidence, including errors and rejected regions, without claiming endpoint reachability establishes execution eligibility.
- [x] Run typecheck, backend tests and builds; review the changes and document the remaining provider-access requirements.

The probe may mutate only its own uniquely created disposable test database. It never enables instruments, edits runtime configuration, buys data subscriptions, or connects to existing application databases. Live acceptance requires confirmed sessions, <=60-second quotes, <=24-hour INR-directed FX, <=5-second future skew, correct units and supported corporate-action coverage. Closed exchanges need separate observation during their regular sessions; one wall-clock instant cannot establish regular-session behavior in all six regions.

## Outcome and verification

The user confirmed no provider account is available and requested evaluation of Yahoo and alternatives. **No provider has been accepted for live execution.** All six live regions remain view-only; this is a failed acceptance result with reproducible evidence, not completion of live enablement.

- The Yahoo run at14:03 UTC on3 November2026 made23 HTTP200 requests. Every sampled quote was stale, sessions were UNKNOWN, and all six live order submissions returned `INSTRUMENT_UNAVAILABLE`. Fresh FX, history and GBP pence normalization were observed separately. The report exits2 to distinguish a completed negative evaluation from a runtime failure.
- All six explicit fixture orders filled through the real trading service; independent reconciliation was balanced. These records are labeled simulated and use a separate probe user/provider instrument set.
- Four deterministic probe tests cover all six fixture fills/currencies, live rejection even when a source advertises tradability, missing discovery, provider outages, and pauses discovered during refresh. Initial regressions failed before implementation; the review's pause-reporting edge also failed before correction.
- At the user's subsequent test-and-commit request, fresh verification with Node24.22.2/npm11.19.1 passed: `npm run typecheck`, `npm run test:foundation` (20 unit and199 integration tests), `npm run test:web`, backend/web builds, and `npm run test:e2e` across all ten production routes. Browser coverage includes delayed route chunks, both bulk notification controls, BUY/SELL labels, alert dates, accounting, FX expiry and logout, with no browser or normal-flow API errors.
- The standalone probe's production-mode refusal was verified: it exits1 with `Validation probe is forbidden in production` before accessing the database or provider. An initial sandbox attempt was blocked by tsx's local IPC restriction; the rerun outside the sandbox exercised the actual guard. The existing dated live report was checked for consistency; no new live-feed acceptance is claimed by the pre-commit checks.
- Independent read-only review found no blocking issue and one diagnostic pause-reporting issue. The correction consumes the post-refresh unavailable reason rather than stale discovery metadata; its regression and the full suite pass.
- The review excluded actual execution/cleanup results (verified by the successful probe/test process exits), test/build outcomes (verified above), vendor entitlement claims and broader session/action/venue acceptance (explicitly unresolved). Official sources and the archived report support the limited findings documented here.
- [Dated public-data evidence](../../evidence/provider-validation-2026-11-03.json) and [official-source provider research](../../PERN_PROVIDER_RESEARCH.md) are preserved. Artifact invariants, local documentation links and `git diff --check` pass.
- The pre-existing work was committed first as `b450766`. The provider tooling, evidence, research and updated verification notes are included in the subsequent provider-validation commit requested by the user after testing.
