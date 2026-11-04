# Retire pre-PERN stack implementation plan

**Goal:** Keep only the current React, Express, PostgreSQL and yfinance application in the working tree while preserving existing database volumes and the repository's Git history.

**Scope:** Remove the retired Flask/Oracle runtime, SQL setup, Compose entry, old frontend development image, old setup guides and old agent permissions. Remove two unused frontend hooks. Keep the PERN one-month demo upgrade path and its `legacy-demo` test fixture because they exercise current PostgreSQL maintenance.

**Constraints:** Do not read, modify or commit `.env.pern-compose.local`; do not stop containers or delete databases/volumes; do not push. Commit the verified cleanup on local `main`.

- [x] Remove tracked pre-PERN runtime and obsolete setup files; leave current PERN modules and assets intact.
- [x] Update current setup/docs and audit references so no live instructions point to removed files. The existing ignore rules still protect possible private dumps and environment files.
- [x] Run typecheck, backend/frontend/provider/deployment/browser checks and inspect the final diff.
- [x] Commit the cleanup on `main`.

Verification: `npm run typecheck`, `npm run test:foundation` (20 unit and 459
integration), `npm run test:web` (29), `npm run build:web`, `npm run test:deploy`
(6), and `npm run test:e2e` (all workflows, including 26 interaction scenarios)
passed. The locked market-data image passed 38 offline Python tests with the
current source mounted read-only. Logs are in `/tmp/pern-legacy-cleanup-verify.log`
and `/tmp/pern-legacy-cleanup-provider.log`. Browser-generated screenshots were
restored before the commit.
