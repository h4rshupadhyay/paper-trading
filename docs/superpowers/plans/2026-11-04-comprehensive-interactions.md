# Interaction and logic test expansion

User request: document application interactions and failure points, then exercise every feature with seeded data, including logic checks.

## Boundaries

- Inventory the active PERN app, provider sidecar, worker and deployment interface. Retained legacy runtimes are outside this run.
- Seed only the guarded disposable PostgreSQL instance on port 55439; do not use `.env.pern-compose.local`, user accounts, or live financial data for writes.
- Use real UI forms, HTTP middleware, database constraints and transaction paths. Inject external failures/delays only at the boundary under test.
- Describe covered paths precisely. Finite tests cannot establish every possible value, timing schedule, browser or upstream outage.

## Work

1. Record routes, actions, validation, ownership, state transitions and failure behavior in `docs/testing/INTERACTION_FAILURE_MATRIX.md`.
2. Independently expand browser workflows in `interactions.browser.e2e.ts` and record cases in `UI_INTERACTIONS.md`.
3. Independently compare seeded financial sequences with a BigInt reference model in `seeded-logic.test.ts`; record the oracle and cases in `LOGIC_CASES.md`.
4. Sweep all protected HTTP methods for session/Origin/CSRF guards and malformed inputs in `http-contract-matrix.test.ts`.
5. Investigate hosted deployment test failures without changing production trust policy. Preserve actual client diagnostics and deterministic Compose checks.
6. If a defect appears, preserve a failing regression, apply the smallest fix and rerun its original trigger.
7. Register the new browser suite in the normal E2E command; run typecheck, unit/integration, frontend, production browser, Python sidecar and Compose/nginx checks. Review the final diff.
8. Publish dated results, failure evidence, reproduction commands and explicit remaining limitations. Do not push or change the live application database as part of this task.

Parallel work is limited to disjoint browser and logic test/document files; the parent handles integration, endpoint guards, deployment tests and final verification.
