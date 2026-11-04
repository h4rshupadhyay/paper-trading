# PERN foundation setup

This is the historical foundation acceptance record. For current startup and operations use the [README](../README.md) and [PERN setup](PERN_SETUP.md). The foundation slice provides registration, login, revocable sessions and an owned INR account. Registration atomically creates the user, account, opening cash movement and `Default` folder. Opening cash is INR 1,000,000, returned as the string `"1000000.00"`, with sequence `"1"`.

## Reproduce the acceptance checks

Run these commands from the repository root in the isolated foundation checkout. Use the versions pinned in `.node-version` and `package.json`: Node 24.22.2 and npm 11.19.1. Docker with the Compose plugin is required for the disposable PostgreSQL 17.11 instance.

```bash
node --version
npm --version
npm ci
npm run test:db:up
npm run test:foundation
```

`test:foundation` runs the unit and integration suites; the root integration command builds the TypeScript workspaces first. Generated `dist` files need not exist in a clean checkout. To select a file, use `npm run test:integration -- foundation.acceptance.test.ts` or `npm run test:unit -- identity-input.test.ts`. Other checks are `npm run typecheck` and `npm run build`.

The test project is exactly `paper-foundation-test`, defined by `apps/server/test/compose.yml`; it binds only `127.0.0.1:55439` and uses tmpfs, with no legacy mounts. Its fixed credentials are disposable test fixtures, never credentials for another environment. The root test command supplies the harness admin URL. The harness refuses any other host, port, database, admin username or password, provisions separate `paper_owner`/`paper_app` roles, and creates a unique `paper_test_<uuid>` database per test. Each harness closes its pools and drops only its own database.

The process acceptance launches the actual compiled `dist/src/api.js` with the runtime role, proves startup leaves an empty database untouched and readiness unavailable, then explicitly runs the compiled migration CLI as owner. It registers and logs in, retains the cookie and IDs, stops only the API, and starts a fresh API against the same database. It checks the same account ID, cash `"1000000.00"`, sequence `"1"`, exactly one opening movement and one default folder, plus continued session access. After CSRF-protected logout, another restart must still reject the old cookie with 401. A second test advances the disposable schema to version 2 as owner and proves the migration CLI refuses to downgrade it or lose existing data.

The suite also covers runtime ledger-edit denial, concurrent migrations, duplicate registration races, rollback after each registration write, session security and safe HTTP errors. This verifies API-process restart durability; tmpfs tests do not claim durability across PostgreSQL/container replacement or power loss.

When verification no longer needs the isolated database:

```bash
npm run test:db:down
```

This stops only the named foundation test project. Its tmpfs data is disposable. Do not delete application volumes or use global prune commands. Interrupting a test with SIGKILL may bypass its database cleanup; stopping this isolated project discards only its test data.

## Configure a separate persistent development database

For manual API use, provision a new PostgreSQL database on a separate development instance with persistent storage. Do not use the disposable tmpfs instance for data you want to retain. The migration expects the exact role names below; it grants runtime privileges to `paper_app`.

As the administrator of that **new development instance**, use `psql` to create separate logins, set unique generated passwords interactively, then create a new owned database:

```sql
CREATE ROLE paper_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password paper_owner
CREATE ROLE paper_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password paper_app
CREATE DATABASE paper_foundation OWNER paper_owner;
```

`paper_app` must not be a member of `paper_owner` or an administrative role. The owner performs migrations; the runtime role has no DDL or ledger UPDATE/DELETE/TRUNCATE privileges. Keep owner credentials out of the deployed API environment. Provisioning/password rotation and persistent database backup/restore are operator responsibilities; this test project is not a production deployment.

```bash
cp .env.pern.example .env.pern.local
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex"))'
```

Edit `.env.pern.local`, which is ignored by git. Fill `DATABASE_URL` with the `paper_app` connection URL, `MIGRATION_DATABASE_URL` with the `paper_owner` URL for the **same new database**, and `CSRF_SECRET` with the generated value. URL-encode passwords in connection URLs. Keep values single-quoted when loading this file through the shell. The example deliberately leaves required secrets/URLs empty so it cannot start an API with example credentials.

`PUBLIC_ORIGIN` must exactly equal the browser origin, including scheme and port, with no trailing slash, path or wildcard. Every unsafe request, including register/login, requires that `Origin` header; missing/`null` origins fail. This API assumes the browser and `/api` are served from one origin and does not enable cross-origin CORS. Use a same-origin frontend/proxy when adding the frontend later. `CSRF_SECRET` must contain at least 32 bytes and should remain stable across restarts. A session expires after 24 hours unless revoked sooner. `NODE_ENV=production` sets Secure cookies and requires an HTTPS browser deployment; local HTTP examples use `development`. The API defaults to port 3000 and trusts no proxy headers.

## Migrate explicitly, then start and restart

The npm scripts do not load `.env` files automatically. In a shell dedicated to deployment/migration, load the private configuration and apply versioned migrations before starting the API:

```bash
set -a
. ./.env.pern.local
set +a
npm run db:migrate || exit 1
npm run build || exit 1
unset MIGRATION_DATABASE_URL
npm run start:api
```

Stop immediately if migration exits nonzero. Migrations serialize using a database advisory lock, are transactional and reject schema versions newer than this code supports. `db:migrate` is the explicit source CLI (`tsx`); the acceptance also exercises its compiled equivalent, `node apps/server/dist/src/platform/migrate.js`. Readiness requires schema version 1. Startup never runs migrations or demo seeds: liveness can return 200 while readiness returns 503 if storage/schema is unavailable. Only direct traffic to the API after readiness succeeds.

Send Ctrl-C (SIGINT) to stop the foreground npm command and its API, or send SIGTERM to the API process under a process supervisor. The API drains requests and closes its database pool. To restart, run `npm run start:api` again with the same runtime URL and secret; retain the database and browser cookie. Do not recreate/drop the database or run a seed. Re-running `db:migrate` as owner is safe but unnecessary for a process-only restart. Account IDs, opening cash and sessions live in PostgreSQL. Logout revocation remains effective after restart.

## Exercise all eight routes

In another shell, use a fresh disposable identity on your new development database. The values below are demonstration data only. Keep the cookie jar private, and use the same origin as `PUBLIC_ORIGIN`.

```bash
API=http://127.0.0.1:3000
ORIGIN=http://127.0.0.1:4173
COOKIE_JAR="$(mktemp)"

# 1. Liveness: {"status":"ok"}, independent of database readiness.
curl --fail-with-body "$API/api/health/live"
# 2. Readiness: {"status":"ok"} only with available schema version 1.
curl --fail-with-body "$API/api/health/ready"

# 3. Register: 201 {user,account}; this does not create a session.
curl --fail-with-body -X POST "$API/api/auth/register" \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  --data '{"username":"foundation_demo","email":"foundation_demo@example.com","password":"foundation demo password"}'

# 4. Login: {user}; save the HttpOnly, SameSite=Lax, /api session cookie.
curl --fail-with-body -c "$COOKIE_JAR" -X POST "$API/api/auth/login" \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  --data '{"username":"foundation_demo","password":"foundation demo password"}'

# 5. Current identity: {user}.
curl --fail-with-body -b "$COOKIE_JAR" "$API/api/auth/me"
# 6. Owned account: {account}, with exact decimal/sequence strings.
curl --fail-with-body -b "$COOKIE_JAR" "$API/api/account"
# 7. Session-bound CSRF token: {csrfToken}.
CSRF_TOKEN="$(curl --fail-with-body -b "$COOKIE_JAR" "$API/api/auth/csrf" | \
  node --input-type=module -e 'let s=""; for await (const chunk of process.stdin) s+=chunk; console.log(JSON.parse(s).csrfToken)')"

# Stop/restart only the API now; these saved cookies still authorize me/account.
curl --fail-with-body -b "$COOKIE_JAR" "$API/api/account"

# 8. Logout: 204; retain the old jar to prove server-side revocation.
curl --fail-with-body -i -b "$COOKIE_JAR" -X POST "$API/api/auth/logout" \
  -H "Origin: $ORIGIN" -H "X-CSRF-Token: $CSRF_TOKEN"
# This returns 401; it must remain 401 after another API restart.
curl -i -b "$COOKIE_JAR" "$API/api/account"
rm -- "$COOKIE_JAR"
unset CSRF_TOKEN COOKIE_JAR
```

The account route uses the authenticated owner and rejects query parameters; callers cannot select another user/account. Authenticated mutations require both the exact Origin and `X-CSRF-Token` from that same session. Invalid input and unsafe origins produce bounded errors with a request ID; do not put passwords, connection URLs, cookies or CSRF tokens in logs. Register/login are independently limited to 20 attempts per client IP per 15 minutes in one API process. Shared rate limiting is required before deploying multiple API processes.
