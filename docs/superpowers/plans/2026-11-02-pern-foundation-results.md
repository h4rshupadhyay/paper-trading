# PERN foundation execution results

Date: 2 November 2026. Branch: `feat/pern-foundation`. Scope: M1 foundation only; final whole-branch review pending.

## Delivered

- Fresh Express/TypeScript/PostgreSQL workspace and shared contracts.
- Versioned owner-run migration with restricted application role.
- Atomic user, INR account, opening credit and default-folder creation.
- Revocable 24-hour opaque sessions, session-bound CSRF and active-user checks.
- Eight protected/public foundation routes, safe errors/logging, throttling and readiness.
- Compiled-process restart acceptance and safe [setup instructions](../../PERN_FOUNDATION_SETUP.md).

The existing React/Flask/Oracle runtime is untouched. Trading, provider integration, worker jobs and frontend cutover are later milestones.

## Verification

The primary independently ran `npm run typecheck` and `npm run test:foundation` after task commits. Both exited zero: **20 unit + 92 integration = 112 passing tests** across seven files. The integration command builds both TypeScript workspaces first; the build passed. Task 7 also ran all five planned checks individually with zero exits.

Checks use a disposable PostgreSQL instance with distinct owner/runtime roles. They include actual competing transactions, rollback after each registration insert, token/CSRF/expiry checks, HTTP security, compiled API restart against the same database, persistent logout revocation and refusal to downgrade a newer schema. The initially deferred newer-schema test suggestion was addressed in the compiled acceptance suite.

API restart persistence is demonstrated; PostgreSQL crash/replacement/power-loss durability is not claimed by tmpfs tests. A persistent manual development database is documented separately. No production database or deployment was created.

## Task record

| Task | Implementer | Accepted commit |
| --- | --- | --- |
| Platform/contracts | SOL high | `29ace87` |
| Schema/migrations | SOL high | `c19c311` |
| Input parsing | LUNA medium, SOL review | `975740f` |
| Registration/accounts | SOL high | `11317a8` |
| Sessions | SOL high | `c4780de` |
| HTTP/lifecycle | SOL high | `72e2226` |
| Acceptance/setup | SOL high | `f955e31` |

Each task received a separate SOL spec/quality review. LUNA received one fix for prototype-sensitive unknown error fields and passed a scoped re-review. All task gates are accepted; a separate whole-branch review follows.

## Rulings I made

1. Execute implementation tasks sequentially in the shared worktree, with fresh SOL review per task and LUNA restricted to Task 3. This prevents shared-file/index conflicts; the cost is reduced parallelism.
2. Treat the user's “let’s start” as approval of the reviewed foundation plan and its constants. This avoids repeated approval stops; changing those defaults later requires code/test changes against fresh accounts.
3. Add a narrow SECURITY DEFINER active-user lock/read function to the unreleased migration. PostgreSQL row locks require a write privilege the application deliberately lacks. PUBLIC execution is revoked, only the application role receives execution, and fixed search_path/schema-qualified queries constrain the function. User UPDATE remains forbidden. The cost is a privileged function to audit; an already-deployed old version 1 would need a new migration. This project had only disposable fresh databases and no released schema.
4. Build inside root `test:integration` so both integration and foundation commands work on clean checkouts. The cost is a short TypeScript build even for file-selected integration runs.
