# Realistic Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace unrealistic demo fixtures with simulated trades based on historical provider closes and FX, and upgrade the existing demo safely.

**Architecture:** The yfinance sidecar exports a validated, completed-session history bundle. A focused TypeScript module validates the bundle and writes accounting using PostgreSQL decimal arithmetic. An explicit CLI creates or upgrades only the reserved demo account with provenance, guarded replacement and a private backup.

**Tech Stack:** Existing Python/yfinance sidecar, TypeScript, PostgreSQL, Vitest.

**Spec:** docs/superpowers/specs/2026-11-04-realistic-demo-design.md

## Global Constraints

- Preserve user identity, password and user-edited resources, including the already-cancelled MSFT order.
- No fallback to invented observations when the provider fails.
- Do not change the market provider or reset the demo user.
- Use decimal arithmetic and normal settlement rounding.

## Review Focus

- In-progress daily bars must not become completed-session executions.
- FX timestamps and different exchange closes must not introduce look-ahead.
- Corporate actions in the window must fail explicitly.
- Later trading or edited seed rows must prevent unsafe replacement.
- Concurrent/repeated upgrades must not reset later account activity.

### Task 1: Historical provider bundle

Files: services/yfinance/app.py, services/yfinance/test_app.py.
Interface: internal GET /demo-history returns source, fetchedAt, per-symbol currency and completed session bars with close timestamps, close prices and action information, plus USDINR history.

- [x] Add failing tests for completed-session cutoff, FX direction, unsupported actions and missing history.
- [x] Implement bounded provider fetching and explicit session-close timestamps.
- [x] Run python3 -m unittest discover -s services/yfinance -v.

### Task 2: Historical accounting and guarded upgrade

Files: apps/server/src/modules/demo/history.ts, apps/server/src/modules/demo/seed.ts, apps/server/src/platform/seed-demo.ts, apps/server/test/demo-seed.test.ts.
Interface: validated DemoHistory input to seedDemo; explicit upgradeDemo(pool, history) under account/advisory locks, transactional replacement only after original-seed fingerprint checks. CLI fetches history before writes and writes a mode-0600 backup before upgrade.

- [x] Add failing integration tests for history-based exact accounting, thresholds, provenance, rollback, repeated upgrade and modified-account refusal.
- [x] Implement decimal SQL projections and chronological session selection with bounded as-of FX/price observations; historical sample quality is stale.
- [x] Preserve cancelled/edited terminal orders and notes; replace only recognized seed rows, snapshot history and unchanged seed thresholds.
- [x] Run targeted integration suite and typecheck/build.

### Task 3: Local application and verification

Files: README.md, docs/testing/DEMO_USER_2026-11-04.md.

- [x] Document history dependency, explicit guarded upgrade and provenance.
- [x] Run backend regression tests and provider tests.
- [x] Back up affected local demo rows privately, deploy updated sidecar/API/worker, apply explicit upgrade.
- [x] Verify live cash/positions/ledger reconciliation, affordable thresholds, provenance and absence of fabricated history; preserve other-user fingerprints.
- [x] Review final diff and report actual evidence and any limitations.

No commits or push are needed for this user request; preserve existing uncommitted changes.
