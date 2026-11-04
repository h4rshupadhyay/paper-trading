# Changelog

Record project changes under **Unreleased** as they are made. Each dependency
upgrade records its previous and new version, verification, and known limitations.
When a release is tagged, move its entries into a dated section using the actual
tag. Dependency versions do not determine the application's release version.
Earlier changes remain available in Git history.

## Unreleased

### Added — 2026-11-04

- Shared yfinance WebSocket quotes, bounded subscriptions and fresh-client reconnects.
  An elected worker persists validated ticks and an authenticated SSE feed updates
  stock pages, watchlists, index prices, trade estimates and SQL-valued portfolios.
- Event-driven pending-order and alert evaluation, coalesced to one batch per
  second. Internal resource reads follow actual order/alert changes; unchanged
  price ticks do not trigger portfolio reloads.
- HTTP fallback and periodic unit validation, including verified metadata for NSE
  ticks that omit currency. Source timestamps remain monotonic across fallback.
- Deterministic stream lifecycle, financial and browser regressions, plus actual
  Yahoo probes. See [streaming verification](docs/testing/STREAMING_2026-11-04.md).

### Changed — 2026-11-04

- Upgraded the market-data service from **yfinance 1.7.0 to 1.8.0** in both the
  development requirements and hash-locked deployment requirements. Updated the
  wheel SHA-256 and removed the no-longer-required `multitasking` dependency;
  the deployment lock now contains 22 runtime distributions.
- Updated the market-data setup and dependency-lock documentation. Rebuilt and
  restarted the local market-data service, confirming it runs 1.8.0. WebSocket
  integration remains separate work; this upgrade does not add streaming or
  change Yahoo's limits.

### Verification — yfinance 1.8.0 upgrade

- Clean Python 3.12 Docker build using hash-verified wheels: passed.
- `pip check`: passed. Offline market-data tests: **20 passed**.
- Running-service version check, service health, application readiness, and an
  actual AAPL quote fetched through the API container: passed.
- Backend unit tests: **20 passed**. Integration tests: **422 passed, 1 failed**
  on a worker shutdown/status timing assertion; its isolated rerun passed all
  four worker tests. The complete integration run was not green.
- The browser suite was blocked at the TypeScript build by an implicit `any`
  parameter in `apps/server/test/demo-history.test.ts:116`. These results record
  the state at upgrade verification, rather than claiming full regression
  acceptance.
