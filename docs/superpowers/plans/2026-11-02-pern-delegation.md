# PERN delivery and model delegation

Completion update,3 November2026: M2–M7 implementation is on `feat/pern-complete`, with independent review,214 backend tests,8 frontend tests, ten-route browser acceptance and Docker lifecycle/restart checks. Live execution stays disabled pending provider acceptance. See the [completion record](2026-11-02-pern-completion-results.md). The foundation-era ledger below is historical.

Status: foundation implemented and task-reviewed, 2 November 2026. The user authorized execution with “let’s start”, preserving LUNA for bounded work and SOL for reasoning/integration/review. Primary checks passed 112 tests, typecheck and build; final branch review is pending. Later milestones remain planned.

References: [proposed design](../specs/2026-11-02-paper-trading-pern-design.md), [foundation plan](2026-11-02-pern-foundation.md), [glossary](../../../GLOSSARY.md), [historical migration audit](../../PERN_MIGRATION_AUDIT.md).

## Models and decision ownership

| Role | Model / effort | Responsibilities |
| --- | --- | --- |
| SOL | `gpt-6.1-sol`, high for reasoning/implementation; medium for small scoped reviews | Reasoning, contract design, integration, accounting, SQL invariants, security, transactions, concurrency, provider acceptance and review |
| LUNA | `gpt-6-luna`, medium | Bounded mechanical implementation or factual inventory after exact inputs, outputs, allowed files and acceptance are supplied |

SOL decomposes work and freezes interfaces before dispatch. LUNA does not select architecture or negotiate contracts with another implementer. SOL reviews each LUNA artifact against its input sources and acceptance before accepting it. Use LUNA only when an actual small task fits; no milestone requires a LUNA quota.

Any LUNA task that needs a new public interface, a change outside its allowed files, or an accounting/security/concurrency decision returns `NEEDS_CONTEXT` with the question, evidence and blocked files. SOL resolves the decision, updates the contract and then redispatches if suitable. After two unsuccessful fix attempts, route diagnosis and reasoning to SOL. Never silently expand scope.

## Milestones and dependencies

This table sequences the whole selected architectural direction. Product rules and later interfaces are conditional on design review; these rows are not executable full-application plans.

| Milestone | Depends on | Reviewable outcome / acceptance | SOL reserved decisions | Eligible LUNA work after contract freeze |
| --- | --- | --- | --- | --- |
| M0: preparation and approval | Existing repo, proposed design | Source inventories; review detailed defaults; choose/confirm execution approach | Resolve approval state and conflicting historical guidance | Read-only source tables with strict file lists |
| M1: foundation | M0 product/plan review | Fresh DB migrations, atomic user/account/opening/default folder, session lifecycle and owned account read; real DB rollback/concurrency/restart checks | Schema, transaction ownership, password/session/CSRF, runtime permissions, HTTP protection | Task 3 deterministic identity input helpers only |
| M2: provider validation | M1 contracts/platform; provider requirements reviewed | Proven quote/currency/unit/session/FX/index/history/corporate-action coverage per enabled market; failure fixtures | Choose/validate provider; freshness/normalization policy; trading enablement; locking/timeouts | Transcribe approved captured observations into fixed fixture schema; documentation matrix |
| M3: immediate execution and valuation | M1 and accepted M2 for enabled markets | Market submit/history with idempotency, exact accounting/cost bases, null incomplete valuation, real concurrent-trade tests | Financial schema, account locks, idempotency replay, settlement/FX/rounding, consistent valuation | Pure formatting or fixed DTO mapping after arithmetic/quality semantics exist; no financial algorithms |
| M4: pending orders and worker | M3; approved lifecycle rules | Stop persistence, limit/stop-limit, cancel/expiry races, no reservations, bounded refresh/sampling and recovery | State machine, account-before-order locks, SKIP LOCKED, retries, advisory locks and heartbeat | Fixed status-copy mapping or ops documentation after exact codes exist |
| M5: user tools | M1; M2/M4 for alert execution | Owner-scoped folders/entries/notes, default-folder move/dedup, one-shot alerts and notifications | Composite ownership constraints, atomic folder deletion, alert/notification races | One owner-scoped read endpoint only if SOL supplies query/service, auth middleware and contract; otherwise docs |
| M6: retained UI adaptation | M1 identity/account, M2 data; M3–M5 feature contracts | All 10 retained pages use cookie/CSRF and decimal-string adapters; quality/state/currency shown correctly | Network auth changes, payload authority, financial display semantics, cross-feature integration | Fixed presentational components, approved label maps, fixture rendering; no accounting conversion decisions |
| M7: deployment and cutover | M1–M6 accepted | Explicit migration, compiled API/worker, same-origin static web, backups/readiness, clean restart and all-page smoke checks | Secrets/origin/proxy policy, deployment order, graceful shutdown, cutover/removal scope | Rewrite specified documentation or deterministic config substitutions from a reviewed template |

M2 fixture research can prepare alongside M1 only after its own exact adapter contract is designed by SOL; live trading remains unavailable until M2 passes. UI inventory needs no backend; actual UI adaptation waits for the relevant contract. Do not parallelize financially coupled M3/M4 work merely to occupy model slots.

## Concrete LUNA dispatch boundaries

### LUNA-P1 — existing frontend surface inventory

- Allowed reads: `frontend/src/App.jsx`, `frontend/src/services/api.js`, `frontend/package.json`, `frontend/vite.config.js` only.
- Allowed write/output: `docs/superpowers/plans/preparation/frontend-surface.md` only.
- Input: existing source, no new contract assumptions. Output: route/page, exported HTTP wrapper, build/proxy and bearer-token behavior tables with source references.
- Acceptance: all 10 routed page rows and 35 wrapper rows correspond to the inspected source; inputs and observed behavior are separated from unknowns. Parent checked 35 Axios calls and citation line bounds.
- Status: reviewed/complete as a factual inventory; no runtime verification or new application code was implied. Do not reopen it for unnecessary tests.
- Escalate if another file is necessary to establish a claim; preserve unknowns instead of guessing.

### LUNA-P2 — existing setup surface inventory

- Allowed reads: `docker-compose.yml`, `backend/Dockerfile`, `backend/entrypoint.sh`, `backend/requirements.txt`, `frontend/Dockerfile`, `MANUAL_SETUP.md` only.
- Allowed write/output: `docs/superpowers/plans/preparation/setup-surface.md` only.
- Input: six source files. Output: service/runtime, ports/volumes/dependencies, manual commands and startup-order tables with source references.
- Acceptance: inventory covers all six allowed files and distinguishes source observations from runtime unknowns. Parent inspected the source correspondence and citation line bounds.
- Status: reviewed/complete as a factual inventory; no Compose startup, package installation or database changes occurred in this task.
- Escalate if inspecting init scripts, secrets, live resources or additional files would be needed; do not run startup commands.

### LUNA-F3 — foundation identity parsing

- Dispatch only after SOL accepts foundation Task 1's actual contracts, dependencies and command harness. Task 2 may proceed separately because its file set is disjoint; Task 4 waits for Tasks 2 and 3.
- Allowed writes: `apps/server/src/modules/identity/input.ts`, `apps/server/test/identity-input.test.ts` only, in the isolated implementation checkout.
- Input: Task 1 `RegisterInput`, `LoginInput`, `AppError`; preinstalled Zod; exact username/email/password/unknown-field rules in foundation Task 3.
- Output: `parseRegisterInput(value:unknown):RegisterInput` and `parseLoginInput(value:unknown):LoginInput`; throw `AppError(400,'VALIDATION_ERROR','Invalid request',fields)` for invalid input. No additional exports or changed contract fields.
- Acceptance: focused unit tests prove exact normalized output, strict unknown-field rejection, null/non-object rejection, Unicode byte limits and unchanged password whitespace; `npm run test:unit -- identity-input.test.ts` and `npm run typecheck` succeed; SOL approves the diff.
- Forbidden: manifest/lockfile changes, migrations, database/HTTP/cookie code, password hashing or authentication decisions. Use `NEEDS_CONTEXT` on any interface/file/rule change; after two failed fixes SOL diagnoses.
- Status: implemented by LUNA and accepted by SOL after one narrow error-field fix; 20 unit tests. Commit `975740f`.

Other LUNA candidates in the milestone table are possibilities, not dispatches. SOL must provide a task-specific allowed-file list, exact consumed/produced signatures or fixture schema, rejection cases, command and expected assertions before scheduling them. If that cannot be done without domain reasoning, keep the task with SOL.

## Reserved SOL work and coordination

SOL owns foundation Tasks 1, 2, 4, 5, 6 and 7; all schema/role changes, shared contracts, dependency selection/lockfiles, transaction helpers, auth middleware, app composition and final review remain SOL-owned. Throughout later milestones, SOL retains financial arithmetic, account cash sequence allocation, owner authorization, CSRF/session policy, provider interpretation, order idempotency, cancellation/fill races, worker locking and deployment/security configuration.

Never run parallel mutations against a shared file. The coordinator keeps a file-ownership ledger before dispatch; a lockfile, shared contracts, root scripts, application route registry or common fixture edited by SOL is unavailable to LUNA until SOL finishes. Read-only work can overlap. LUNA-F3 and Task 2 can overlap only after Task 1 freezes their inputs; integration occurs sequentially under SOL. Separate worktrees do not permit competing edits to the same logical file without an explicit integration owner and a sequenced merge.

For future tasks, prefer a complete narrow deliverable with its own meaningful check, rather than splitting a transaction or security feature among models. SOL first reviews the spec/contract, then the implementation and actual check output. Review does not substitute for real PostgreSQL tests. Fixes to shared files return to SOL; LUNA never makes an opportunistic adjacent change.

## Progress and evidence ledger

| Work item | Owner | Status | Evidence / next gate |
| --- | --- | --- | --- |
| Greenfield PERN architectural direction | User/SOL | Selected | Proposed design records React, modular Express/Node, PostgreSQL, separate shared-module worker |
| Foundation design/plan approval | User | Authorized | “let’s start” after foundation approval request; later financial slices remain unimplemented |
| LUNA-P1 frontend inventory | LUNA; parent review | Reviewed/complete | `preparation/frontend-surface.md`; parent verified 10 routes, 35 wrappers and source references |
| LUNA-P2 setup inventory | LUNA; parent review | Reviewed/complete | `preparation/setup-surface.md`; parent inspected correspondence across six files |
| Foundation Task 1 platform/contracts | SOL | Complete/reviewed | `29ace87`; pinned runtime, real PG platform tests |
| Foundation Task 2 schema/migrations | SOL | Complete/reviewed | `c19c311`; real constraints/roles/migration tests |
| Foundation Task 3 parsing / LUNA-F3 | LUNA; SOL review | Complete/reviewed | `975740f`; one scoped fix, 20 unit tests |
| Foundation Task 4 atomic registration | SOL | Complete/reviewed | `11317a8`; rollback/concurrent duplicate tests |
| Foundation Task 5 sessions | SOL | Complete/reviewed | `c4780de`; DB-clock sessions and narrow SQL lock capability |
| Foundation Task 6 HTTP/account slice | SOL | Complete/reviewed | `72e2226`; eight routes, security and lifecycle checks |
| Foundation Task 7 durability acceptance | SOL | Complete/reviewed | `f955e31`; compiled restart/revocation and newer-schema refusal |
| M2–M7 implementation plans | SOL | Not started | Design review plus predecessor contracts/acceptance; write separate bounded plans |

Preparation inventories remain complete. All seven foundation implementation tasks have now passed their task reviews; see [execution results](2026-11-02-pern-foundation-results.md). The primary independently verified 20 unit + 92 integration tests, typecheck and build, then repeated those checks for final acceptance. Final SOL whole-branch review found no blockers and one deferred minor encoding-error mapping issue. The isolated test project is stopped; the user selected local integration, and the foundation is merged into `main` with its feature worktree/branch removed. Update later milestones only with their own concrete evidence.

## Approval and unresolved decisions

The user authorized M1 after reviewing the design/plan proposal. INR 1,000,000 opening cash and the explicit identity/session behavior are implemented. Regular-session freshness, reservations and corporate-action/full-fill limits remain design inputs for later financial implementation plans, not capabilities shipped by M1.

The historical audit proposed compatibility with old routes and bearer JWT; the newer design explicitly removes route-compatibility requirements and chooses opaque cookie sessions. Use the newer design for forward planning, preserve the audit as historical evidence, and do not rewrite its history. Existing Oracle/Python files, volumes and data stay intact until replacement coverage and cutover authorization exist.
