# PERN Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver one fresh PostgreSQL-backed slice: register a user atomically with an INR account, opening cash movement and default folder; authenticate with revocable sessions; read the owned account.

**Architecture:** A TypeScript Express application uses focused identity/accounts modules and one checked-out `pg` client per transaction. SQL constraints and a restricted runtime role protect persistence; the HTTP layer owns validation and security middleware, while modules own business transactions. Existing React, Python, Oracle databases and volumes remain untouched.

**Tech Stack:** Node LTS, TypeScript, Express, `pg`, SQL migrations, bcrypt, Zod, Vitest and Supertest; npm workspaces. Task 1 pinned the tooling; execution used Node 24.22.2 and npm 11.19.1.

**Spec:** [Proposed PERN design](../specs/2026-11-02-paper-trading-pern-design.md), [canonical language](../../../GLOSSARY.md), [historical audit](../../PERN_MIGRATION_AUDIT.md).

**Status:** Foundation implementation authorized by the user with “let’s start”. All seven tasks are implemented and task-reviewed. Primary verification passed 20 unit + 92 integration tests, typecheck and build. The final SOL whole-branch review is complete with no blocking findings and one deferred minor HTTP error-mapping follow-up. The isolated test project is stopped. Branch integration awaits the user’s choice; later milestones remain separate work.

## Global Constraints

- “Existing databases and volumes must remain untouched during development.” Use a separate greenfield checkout/worktree at execution time.
- “Use TypeScript for new backend and contract code.” Use Express, `pg`, versioned SQL migrations, and a supported Node LTS runtime.
- “One INR account per user, with an opening credit of **INR 1,000,000 (₹10,00,000)**.” This default was authorized for this foundation phase.
- “A user, account, opening cash movement and default watchlist folder are created atomically.” No route independently commits part of registration.
- “Preserve financial history across process restarts. Startup must never reset a user or run a destructive demo seed.” No seed command is needed for this slice.
- “No application financial arithmetic through binary JavaScript floating point.” “Public decimal values are JSON strings.” “Large sequence values are also strings in JSON.”
- “Use UUID strings for public identifiers and UTC `timestamptz` values for events.” Cash uses `numeric(20,2)`; timestamps serialize as ISO 8601 UTC.
- “Executions and cash movements are append-only for runtime database roles; administrative schema ownership is held separately.” This slice creates cash movements only.
- “Use opaque server sessions: random token in a Secure production, HttpOnly, SameSite=Lax cookie; store only its hash, with a default 24-hour expiry.”
- “Validate Origin for unsafe browser requests including login.” “Require a session-bound CSRF token for authenticated mutations.” Never log passwords, tokens or sensitive headers.
- “Database migrations are an explicit deployment step guarded against concurrent runs.” “Stop on migration failure.” API readiness checks expected schema version.

## Review Focus

1. Duplicate identities submitted concurrently must produce one complete user/account/opening/folder aggregate, with no orphan rows (Tasks 2, 4, 7).
2. A database fault after any registration write must roll back all four records and release the connection (Tasks 1, 4, 7).
3. Forged, expired, revoked or inactive-user sessions and wrong-session CSRF must fail without leaking another account (Tasks 5, 6).
4. Missing configuration, malformed/oversized input and hostile origins must fail closed with bounded, stable errors and no secret logging (Tasks 1, 3, 6).
5. Numeric special values, unauthorized ledger edits, concurrent migrations and process restarts must not corrupt or reset opening cash (Tasks 2, 7).

---

## Scope and decisions carried into execution

Included routes: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/csrf`, `GET /api/account`, and `/api/health/live|ready`.
Excluded: market data, orders, executions, portfolio valuation, folder CRUD, worker jobs, frontend adaptation and deployment cutover. Later slices receive their own plans; this is deliberately not a full-application plan.
Authorized foundation decisions: registration returns identity/account but does not log in; login accepts username/password; the default folder is named `Default`; username is trimmed/lowercased ASCII `[a-z0-9_]{3,32}`, email is trimmed/lowercased ASCII email of at most 254 characters, and passwords are unmodified UTF-8 of 12–72 bytes.
Use fixed-window, per-process auth throttling for the stated single-API initial sizing: 20 registration attempts and 20 login attempts per client IP per 15 minutes. Disable proxy trust by default; multi-API rollout must first add a shared limiter. This does not replace database concurrency protection.
Security choices: exact configured origin match; reject absent/`null` Origin on unsafe routes; 16 KiB JSON body limit; 32 random bytes per session token encoded base64url; SHA-256 token storage; bcrypt cost 12. CSRF is base64url HMAC-SHA-256 of the raw session token using the required server `CSRF_SECRET`; compare fixed-size decoded tokens with constant-time comparison.
Registration needs Origin protection but no authenticated CSRF token. Login rotates by revoking a supplied valid session and issuing a new one in one transaction. Logout requires a valid session and CSRF, revokes it, clears the cookie and returns 204; later use returns 401.

## File ownership map

All paths below are future files in the isolated checkout; creating this plan creates none of them. No task writes the legacy application.

| Owner/task | Files and responsibility |
| --- | --- |
| SOL / 1 | Root `package.json`, `package-lock.json`, `tsconfig.base.json`, `.node-version`; `packages/contracts/{package.json,tsconfig.json,src/foundation.ts}`; server `package.json`, `tsconfig.json`, `vitest.config.ts`; `src/platform/{config,db,errors}.ts`; `test/{compose.yml,harness.ts,platform.test.ts}` |
| SOL / 2 | `apps/server/migrations/001_foundation.sql`; `src/platform/migrate.ts`; `test/schema.test.ts` |
| LUNA / 3 | Only `apps/server/src/modules/identity/input.ts` and `apps/server/test/identity-input.test.ts` |
| SOL / 4 | `apps/server/src/modules/accounts/service.ts`; `src/modules/identity/registration.ts`; `test/registration.test.ts` |
| SOL / 5 | `apps/server/src/modules/identity/{passwords,sessions}.ts`; `test/sessions.test.ts` |
| SOL / 6 | `apps/server/src/{app,api}.ts`; `src/platform/{http,logging}.ts`; `src/modules/identity/http.ts`; `src/modules/accounts/http.ts`; `test/http.test.ts` |
| SOL / 7 | `apps/server/test/foundation.acceptance.test.ts`; `docs/PERN_FOUNDATION_SETUP.md`; `.env.pern.example`; amend server/root scripts only if required by the already-fixed commands below |

Server-relative `src/` and `test/` entries in this table are under `apps/server/`. Dependencies/lockfile are SOL-only; add all Task 1–7 dependencies in Task 1 so LUNA never changes manifests.

## Shared contracts and command vocabulary

Task 1 exports these exact types from `@paper/contracts/foundation`; every consuming task uses them without renaming or locally re-declaring them:

```ts
type RegisterInput = { username: string; email: string; password: string };
type LoginInput = { username: string; password: string };
type PublicUser = { id: string; username: string; email: string };
type AccountView = { id: string; baseCurrency: 'INR'; cashBalance: string; cashSequence: string };
type RegistrationResult = { user: PublicUser; account: AccountView };
type Principal = { user: PublicUser; accountId: string; sessionId: string };
type IssuedSession = { token: string; csrfToken: string; expiresAt: Date };
type ApiErrorBody = { error: { code: string; message: string; fields?: Record<string,string>; requestId: string } };
```

`AppError` in `platform/errors.ts` has constructor `(status: number, code: string, message: string, fields?: Record<string,string>)`; only safe messages reach clients. Express handlers return `{user,account}` for registration, `{user}` for login/me, `{csrfToken}` for CSRF and `{account}` for account read; health returns `{status:'ok'}` or a safe 503 error.
Root scripts: `typecheck`, `build`, `test:unit`, `test:integration`, `test:foundation`, `test:db:up`, `test:db:down`, `db:migrate`, `start:api`. Test selectors use `npm run test:unit -- <file>` or `npm run test:integration -- <file>`; scripts run from the root and resolve files under `apps/server/test/`.
`test:db:up` starts only the new `apps/server/test/compose.yml` project `paper-foundation-test`, with PostgreSQL tmpfs and no legacy mounts. `test:db:down` targets only that project; never run legacy Compose cleanup or global prune commands.
`createHarness(): Promise<TestHarness>` exports `{ownerPool: Pool, appPool: Pool, close(): Promise<void>}`; it creates a uniquely named database `paper_test_<uuid>` only inside that isolated test instance and refuses non-test database names/hosts. Each test gets a fresh database; `close` drops only its own database and closes pools.
The isolated test instance provisions roles `paper_owner` and `paper_app`; production provisioning uses the same separation with explicit credentials. Test-only probe names in assertions below are local fixture helpers defined by that task's test file, never new application interfaces.

### Task 1: Executable platform and fixed contracts — SOL

**Files:** Task 1 row in the ownership map; test `apps/server/test/platform.test.ts`.
**Interfaces:** Consumes no new module. Produces shared types above; `loadConfig(env: NodeJS.ProcessEnv): Config`, `createPool(databaseUrl: string): Pool`, `withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>`, `AppError` and `createHarness()`.
`Config` is `{nodeEnv:'development'|'test'|'production',port:number,databaseUrl:string,expectedSchemaVersion:1,publicOrigin:string,csrfSecret:string}`. Migration commands separately require `MIGRATION_DATABASE_URL`; runtime never receives it.

- [x] **Step 1: Write failing platform tests** for invalid config and transaction rollback using this contract:

```ts
expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow();
expect(() => loadConfig({ ...validEnv, PUBLIC_ORIGIN: '*' })).toThrow();
await expect(withTransaction(pool, async c => { await c.query('INSERT INTO probe VALUES (1)'); throw Error('fault'); })).rejects.toThrow('fault');
expect((await pool.query('SELECT * FROM probe')).rows).toEqual([]);
```

- [x] **Step 2: Bootstrap only the listed tooling/harness** so the red tests run: verify official runtime/package support, pin package/lock versions, configure ESM/strict TypeScript, and create the isolated PostgreSQL test project. Set `TEST_DATABASE_ADMIN_URL` only for that container; do not discover or reuse legacy credentials.
- [x] **Step 3: Run red tests:** `npm run test:db:up`, then `npm run test:integration -- platform.test.ts`; expect failed assertions/missing platform exports, not an unexamined infrastructure failure.
- [x] **Step 4: Implement the platform signatures.** Require explicit database credentials and a 32-byte-minimum CSRF secret in every environment; validate port/origin, use bounded pools/query timeouts, and always release checked-out clients after commit/rollback. Do not register global numeric/bigint-to-number parsers.
- [x] **Step 5: Verify:** `npm run test:integration -- platform.test.ts` and `npm run typecheck`; expect all selected tests and type checks to pass, including a subsequent transaction after rollback.
- [x] **Step 6: Review/commit only Task 1 files:** `git add <Task-1-files>` then `git commit -m "feat: establish isolated PERN foundation platform"` after execution approval and verification.

### Task 2: Versioned schema and restricted runtime role — SOL

**Files:** Task 2 ownership row; test `apps/server/test/schema.test.ts`.
**Interfaces:** Consumes Task 1 `Pool`, config and harness. Produces `migrate(pool: Pool): Promise<void>` and `readSchemaVersion(pool: Pool): Promise<number>`; schema version 1 and the tables below for Tasks 4–6.
Tables: `users(id,username,email,password_hash,active,created_at)`; `accounts(id,user_id,base_currency,cash_balance,cash_sequence,valuation_dirty)`; `cash_movements(id,account_id,account_sequence,amount,resulting_balance,reason,created_at)`; `watchlist_folders(id,user_id,name,is_default)`; `sessions(id,user_id,token_hash,expires_at,revoked_at,created_at)`; `schema_migrations(version,applied_at)`.
Use UUID IDs, normalized unique username/email, unique account/user, account currency `INR`, cash `numeric(20,2)` bounded from zero through `999999999999999999.99`, positive bigint sequences and a unique `(account_id,account_sequence)`. This slice allows only `OPENING_CREDIT` movements of `1000000.00` with sequence 1 and matching resulting balance; later trading migration extends reasons/settlements deliberately.
One partial unique index allows at most one opening credit per account; one default folder per owner; unique `(user_id,name)` and `(user_id,id)` prepare later composite ownership. Prevent default-folder deletion or owner/default-flag reassignment. Runtime may not UPDATE/DELETE cash movements or delete users/accounts; separate schema-owner role owns DDL.

- [x] **Step 1: Write failing schema tests** with real owner/runtime connections:

```ts
expect(await versionAfterTwoMigrations()).toBe(1);
expect(await concurrentMigrationVersions()).toEqual([1, 1]);
await expect(insertAccount({ cashBalance: 'NaN' })).rejects.toMatchObject({ code: '23514' });
await expect(insertDuplicateOpening()).rejects.toMatchObject({ code: '23505' });
await expect(runtimeUpdateOpening()).rejects.toMatchObject({ code: '42501' });
await expect(deleteDefaultFolder()).rejects.toBeDefined();
```

- [x] **Step 2: Run red:** `npm run test:integration -- schema.test.ts`; expect absent schema/migration or unmet invariants.
- [x] **Step 3: Implement SQL constraints, explicit grants and migration runner.** Use one dedicated migration connection, PostgreSQL advisory lock, transactional migration/version insertion, rollback and nonzero exit on any migration failure; runtime startup never migrates. Test role provisioning belongs only to the disposable harness.
- [x] **Step 4: Verify:** `npm run test:integration -- schema.test.ts`; include negative cash, overflow, duplicate account/sequence, illegal token hash length, and failed-migration rollback; expect pass.
- [x] **Step 5: Review/commit only Task 2 files:** `git add <Task-2-files>` then `git commit -m "feat: add durable foundation schema and migrations"`.

### Task 3: Deterministic identity input parsing — LUNA

**Files:** Only `apps/server/src/modules/identity/input.ts` and `apps/server/test/identity-input.test.ts`.
**Interfaces:** Consumes fixed Task 1 `RegisterInput`, `LoginInput`, `AppError` and Zod dependency. Produces `parseRegisterInput(value: unknown): RegisterInput` and `parseLoginInput(value: unknown): LoginInput`; validation failure throws `AppError(400,'VALIDATION_ERROR','Invalid request',fields)` using input field names.
No database, cookies, password hashing, HTTP middleware, dependencies, public contracts or product-rule changes are allowed. Reject unknown fields; apply only the explicit normalization/password bounds above; use Zod ASCII email validation plus the 254-character cap.

- [x] **Step 1: Write failing tests** for the exact helper output and rejected inputs:

```ts
expect(parseRegisterInput({ username:' Alice_1 ', email:' A@EXAMPLE.COM ', password:' twelve chars ' })).toEqual({ username:'alice_1', email:'a@example.com', password:' twelve chars ' });
expect(() => parseRegisterInput({ ...validInput, price:'1' })).toThrow(AppError);
expect(() => parseLoginInput({ username:'a', password:'x'.repeat(73) })).toThrow(AppError);
expect(() => parseRegisterInput({ ...validInput, password:'é'.repeat(37) })).toThrow(AppError);
```

- [x] **Step 2: Run red:** `npm run test:unit -- identity-input.test.ts`; expect missing helpers/failed assertions.
- [x] **Step 3: Implement only the two functions** and tests for non-object/null inputs, missing fields, password minimum and byte boundary, invalid email, case normalization and unmodified whitespace in passwords. No external calls or DB work.
- [x] **Step 4: Verify:** `npm run test:unit -- identity-input.test.ts` and `npm run typecheck`; expect pass. If interfaces/rules require alteration, return `NEEDS_CONTEXT`; SOL resolves it. After two unsuccessful fixes, return reasoning to SOL.
- [x] **Step 5: SOL reviews/accepts the two-file diff, then commits:** `git add apps/server/src/modules/identity/input.ts apps/server/test/identity-input.test.ts` and `git commit -m "feat: validate foundation identity inputs"`.

### Task 4: Atomic registration and account projection — SOL

**Files:** Task 4 row; test `apps/server/test/registration.test.ts`.
**Interfaces:** Consumes Task 1 transaction/contracts and Task 2 schema; Task 3 validates before calling this module. Produces `registerUser(pool: Pool, input: RegisterInput, hashPassword: (password:string)=>Promise<string>): Promise<RegistrationResult>` and `readAccount(pool: Pool, userId: string): Promise<AccountView>`.
Registration hashes before opening its transaction, then inserts the user, account with cash/sequence `1000000.00`/`1`, matching opening movement, and `Default` folder with `is_default=true` on one client. `readAccount` joins the active user and scopes by user ID; absent/inactive gives 404 `ACCOUNT_NOT_FOUND`; no route takes a caller-supplied account ID.

- [x] **Step 1: Write failing registration tests** including exact ledger reconciliation:

```ts
expect(result.account).toMatchObject({ baseCurrency:'INR',cashBalance:'1000000.00',cashSequence:'1' });
expect(await countsForUser(result.user.id)).toEqual({ users:1,accounts:1,cashMovements:1,defaultFolders:1 });
expect(await cashMinusMovementSum(result.account.id)).toBe('0.00');
expect(await openingReason(result.account.id)).toBe('OPENING_CREDIT');
```

- [x] **Step 2: Run red:** `npm run test:integration -- registration.test.ts`; expect absent service/failed assertions.
- [x] **Step 3: Implement signatures and stable duplicate mapping.** Unique username/email conflicts become 409 `IDENTITY_CONFLICT`; never expose SQL, hashes or duplicate-field existence details. Cast numeric/bigint result fields explicitly to strings; only return the shared safe DTOs.
- [x] **Step 4: Add real rollback/concurrency tests.** Test-only owner-installed triggers raise after each of the four inserts in separate fresh databases; assert all four counts remain zero. `Promise.allSettled` over two same normalized identities must yield one fulfilled result and one 409, with exactly one aggregate. Hash failure creates nothing; another transaction still works after each fault.
- [x] **Step 5: Verify:** `npm run test:integration -- registration.test.ts`; expect pass with actual competing PostgreSQL clients, not mocked transactions.
- [x] **Step 6: Review/commit only Task 4 files:** `git add <Task-4-files>` then `git commit -m "feat: create identity and opening account atomically"`.

### Task 5: Revocable sessions and password verification — SOL

**Files:** Task 5 row; test `apps/server/test/sessions.test.ts`.
**Interfaces:** Consumes Task 1 `Principal`, `IssuedSession`, errors/config and Task 2 schema. Produces `hashPassword(password:string):Promise<string>`; `login(pool:Pool,input:LoginInput,csrfSecret:string,previousToken?:string):Promise<{user:PublicUser;session:IssuedSession}>`; `authenticate(pool:Pool,token:string):Promise<Principal>`; `revokeSession(pool:Pool,sessionId:string):Promise<void>`; `csrfForSession(token:string,csrfSecret:string):string`; `verifyCsrf(token:string,presented:string,csrfSecret:string):boolean`.
Unknown identity and wrong password both give 401 `INVALID_CREDENTIALS`; use a fixed dummy bcrypt hash on unknown-user verification. Session insertion and previous-session revocation share one transaction that locks/rechecks the active user after password verification; active-state checks occur on every authenticate. Database time sets and checks exactly 24-hour expiry; `expires_at <= database_now` is expired.

- [x] **Step 1: Write failing tests:**

```ts
expect(await storedTokenHash(issued.token)).not.toBe(issued.token);
expect(await sessionLifetimeSeconds()).toBe(86400);
expect(verifyCsrf(tokenA,csrfForSession(tokenB,secret),secret)).toBe(false);
await expect(authenticate(pool,revokedToken)).rejects.toMatchObject({ status:401 });
await expect(authenticate(pool,inactiveUserToken)).rejects.toMatchObject({ status:401 });
```

- [x] **Step 2: Run red:** `npm run test:integration -- sessions.test.ts`; expect missing session implementation/failed assertions.
- [x] **Step 3: Implement the exact signatures** using crypto randomness/hash/HMAC and bcrypt. Hash/token material never enters safe DTOs or logs; reject malformed tokens before database lookup, compare CSRF in constant time, and never allow unknown-user errors to reveal identity existence.
- [x] **Step 4: Verify:** `npm run test:integration -- sessions.test.ts`; include forged token, expiry boundary, deactivation between password check and session creation, rotated old token, and independent sessions; expect pass.
- [x] **Step 5: Review/commit only Task 5 files:** `git add <Task-5-files>` then `git commit -m "feat: add opaque revocable authentication sessions"`.

### Task 6: Protected HTTP slice and account read — SOL

**Files:** Task 6 row; test `apps/server/test/http.test.ts`.
**Interfaces:** Consumes Tasks 1–5 exports. Produces `createApp(deps:{pool:Pool;config:Config;logger:SafeLogger}):Express`, `startApi():Promise<void>`, and the eight route behaviors listed in scope. `SafeLogger` in `platform/logging.ts` exposes `info(event:string,fields:Record<string,unknown>):void` and `error(event:string,fields:Record<string,unknown>):void`; it allowlists safe fields and never serializes request headers/bodies.
Cookie is `paper_session`, Path `/api`, HttpOnly, SameSite=Lax, Secure in production, max-age 86400; no Domain attribute. Return CSRF only from authenticated `/api/auth/csrf` with `Cache-Control: no-store`; login returns the safe user and sets cookie, registration returns 201 without cookie. Do not enable cross-origin CORS.
All API responses use no-store. Request IDs are server-generated UUIDs. Map validation to 400, no session to 401, bad Origin/CSRF to 403, not found to 404, duplicate to 409, rate limits to 429, DB unavailable/unready to 503; oversized JSON uses 413 `BODY_TOO_LARGE`. Unexpected errors use safe 500 `INTERNAL_ERROR` without stack/SQL details.

- [x] **Step 1: Write failing Supertest route tests** for register → login → csrf → account → logout:

```ts
expect(registerResponse.status).toBe(201);
expect(accountResponse.body.account.cashBalance).toBe('1000000.00');
expect(productionCookie).toMatch(/HttpOnly/); expect(productionCookie).toMatch(/Secure/);
expect(wrongOriginLogin.status).toBe(403); expect(logoutWithoutCsrf.status).toBe(403);
expect(revokedAccountRead.status).toBe(401); expect(secondUserAccount.body.account.id).not.toBe(firstAccountId);
```

- [x] **Step 2: Run red:** `npm run test:integration -- http.test.ts`; expect absent app/routes or failed assertions.
- [x] **Step 3: Implement middleware and narrow handlers.** Apply body limit, Origin check, throttling and error normalization before handlers; authenticate each protected request; require CSRF for logout. GET account ignores no owner override: reject unexpected query keys with 400. Return safe PublicUser on `/me`; health live avoids DB, ready checks DB/schema 1 without changing schema.
- [x] **Step 4: Implement runtime lifecycle.** Validate config before listen, bound query/pool waits, handle SIGTERM/SIGINT by stopping requests, draining within 10 seconds and closing the pool; never create worker loops or run migrations/seed at startup.
- [x] **Step 5: Verify:** `npm run test:integration -- http.test.ts`; include null/missing Origin, malformed JSON, 16 KiB overflow, 21st auth attempt, token-free logs, missing CSRF, wrong-session CSRF, inactive user, safe 503 and readiness schema mismatch; expect pass.
- [x] **Step 6: Review/commit only Task 6 files:** `git add <Task-6-files>` then `git commit -m "feat: expose protected identity and account routes"`.

### Task 7: Whole-slice durability acceptance and handoff — SOL

**Files:** Task 7 row; test `apps/server/test/foundation.acceptance.test.ts`.
**Interfaces:** Consumes the eight routes, migration CLI, config and npm scripts from earlier tasks. Produces a documented clean-start/restart procedure and a reproducible acceptance command, `npm run test:foundation`; no new business interface.

- [x] **Step 1: Write failing process-level acceptance assertions:** register and login against compiled API; retain IDs/cookie; terminate only API, restart it against the same disposable DB, and assert `{accountId,balance,sequence,openingCount,defaultFolderCount}` remains `{accountId,'1000000.00','1',1,1}`. Reuse session successfully; revoke then restart and assert 401. Run acceptance before adding any missing process-script wiring.
- [x] **Step 2: Run red:** `npm run build` then `npm run test:foundation`; expect a concrete failed acceptance assertion for unfinished behavior; if already green, retain the evidence without manufacturing a failure.
- [x] **Step 3: Complete operational wiring/docs only.** Document isolated test DB provisioning, distinct owner/runtime URLs, explicit migration before startup, required origin/secret configuration, all eight route examples and cleanup limited to the test project. `.env.pern.example` contains placeholders that cannot be usable production credentials; no legacy setup edits.
- [x] **Step 4: Verify the reviewed slice:** `npm run typecheck`, `npm run test:unit`, `npm run test:integration`, `npm run build`, `npm run test:foundation`; expect zero exits and passing suites. Confirm runtime-role ledger edits fail, concurrent migrations serialize, fault tests leave no orphans, and restart preserves data. Record actual command results rather than inferring them.
- [x] **Step 5: Review/commit only Task 7 files:** `git add <Task-7-files>` then `git commit -m "test: verify durable PERN foundation lifecycle"`. Request a SOL whole-slice review before considering the slice accepted; fix concrete findings and rerun affected checks.
- [x] **Step 6: Handoff:** report verified behavior, unresolved risks and deferred milestones; do not switch legacy frontend/Compose or claim the full application migrated. Shut down only the isolated test project with `npm run test:db:down` when verification no longer needs it.

## Self-review and approval boundary

Planning self-review checked scope, ownership, type/signature consistency, the five failure classes and step size. The proposed resource/session contract supersedes the audit's historical compatibility/JWT recommendations; it is not an instruction to preserve 37 old paths. Full-design features omitted here are intentionally allocated to later slices in the delegation plan.
Planning preceded implementation. The user subsequently authorized this foundation plan with “let’s start”; the opening funds, identity/session policy and bounded scope were implemented as specified. See the [execution results](2026-11-02-pern-foundation-results.md) for verification and the narrow SQL-locking correction. Later milestones still require their own implementation plans.
