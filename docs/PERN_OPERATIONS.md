# Local deployment, recovery and dependency updates

The supported local stack is `docker compose --env-file .env.pern-compose.local`.
It publishes the web app only on loopback. Public TLS/ingress configuration is a
separate deployment scope; follow [PERN_INGRESS.md](PERN_INGRESS.md) before exposing it.

## Restart behavior

PostgreSQL, the API, worker, web and market bridge use `restart: unless-stopped`.
Docker restarts exited processes and resumes them after a host/Docker restart unless
an operator stopped them. The migration job remains `restart: 'no'`. Health checks
report unhealthy services; they do not restart a process that remains running.

A process-exit recovery check can signal the worker's main process and wait for its
Docker restart count to increase and health to recover. This briefly pauses background
processing; do it during local maintenance. Do not kill PostgreSQL to test this policy.

## Back up and verify recovery

From the repository root:

```bash
deploy/pern/backup.sh
```

The script uses the existing container's local PostgreSQL connection; it does not
print or copy environment secrets. It emits the path to a custom-format `pg_dump`.
The default directory is `${XDG_STATE_HOME:-$HOME/.local/state}/paper-trading/backups`.
New directories are private and files use mode 0600. Keep backups outside git and
Docker build contexts. They contain personal account data, notes and session hashes;
protect them as application data. Copy important backups to a protected second device
or storage destination under your own retention policy.

Optional arguments select the Compose env file and backup directory:

```bash
deploy/pern/backup.sh .env.pern-compose.local /path/to/private/backups
```

Verify a specific dump without touching the running database:

```bash
deploy/pern/verify-restore.sh /path/to/paper-pern-BACKUP.dump
```

This creates a fresh PostgreSQL 17 container with no network or published ports and
a temporary in-memory data volume. It restores the dump with `--exit-on-error`, then
checks account cash/sequences, running ledger balances, position quantities/costs and
execution settlements. The container is removed on success or failure. Role names are
recreated without login privileges inside that isolated container only.

The drill establishes that this dump is restorable and internally consistent. It is
not an automatic rollback command for the application database. During actual disaster
recovery, stop writers, restore into a new persistent volume/database, verify it and
confirm application role credentials/permissions before changing the application
connection. Preserve the previous volume until the recovered service is accepted.
Never reset or delete financial records to repair a failed reconciliation.

## Deploy an additive migration

Build first while the existing app runs. Save and restore-check a backup before
changing the database. During local maintenance, stop the API and worker, run the
migration, then bring up the new stack:

```bash
docker compose --env-file .env.pern-compose.local build
deploy/pern/backup.sh
# Run verify-restore.sh with the backup path printed above.
docker compose --env-file .env.pern-compose.local stop api worker
docker compose --env-file .env.pern-compose.local run --rm --no-deps migrate
docker compose --env-file .env.pern-compose.local up --no-build --detach --wait
```

Check `/api/health/ready`, service health and account reconciliation after deployment.
Schema 005 adds display statistics and preserves existing account/trading records.
Do not downgrade binaries against a newer schema or modify an applied migration.

## Locked deployment inputs

Node, Python and nginx base images are pinned to registry manifest digests, as is
PostgreSQL. npm installs use the existing package lockfiles. The bridge's
`services/yfinance/requirements.lock.txt` pins all 23 installed runtime distributions
and hashes their wheels for **CPython 3.12 on Linux x86_64**. Docker and CI install it
using `--require-hashes --only-binary=:all:`. Other platforms fail rather than silently
resolving untested wheels; generate and verify a platform-specific lock before adding
another deployment target. `requirements.txt` remains the direct dependency input
for standalone development.

To update the Python lock deliberately, resolve the direct requirements in a clean
Python 3.12 Linux x86_64 environment, record every transitive version, download the
matching wheels and record each SHA-256. Rebuild using the hashes, run `pip check`
and all bridge tests, then run the application integration/browser suites. Update base
image digests through an explicit rebuild/test change as well. Pinning ensures repeatable
inputs; it does not replace scheduled vulnerability review or upgrades.

## Verified deployment — 4 November 2026

- A private schema-004 backup restored into the isolated container and passed all
  accounting checks before migration.
- Migration 005 applied successfully. Fingerprints of accounts, orders, positions,
  executions and cash movements matched exactly before and after migration.
- All five long-running services are healthy and configured for automatic restart.
- The deployed API returns fresh AAPL quote/statistics with all ten supported metrics;
  existing active accounts reconcile and portfolio reads succeed.
- The worker recovered automatically after its main process received SIGTERM.
- The pinned Node 24.22.2/npm 11.19.1 environment passed 20 unit and 223 integration
  tests. The hash-locked bridge image passed 18 offline tests and `pip check`.
- All 6 deployment tests passed. The combined browser workflow from the application
  remediation passed its original, yfinance, audit, catalogue and completeness cases.

Browser automation could not attach to a personal browser session in this environment.
Live verification used HTTP readiness/authentication checks and deployed application
services; UI behavior was verified by the isolated production-browser suite. No smoke
test changed the user's paper holdings or cash balance.
