# yfinance paper trading implementation

**Spec:** `docs/superpowers/specs/2026-11-03-yfinance-paper-trading-design.md`.

- [x] Python service: pin yfinance, implement the frozen HTTP/decimal contract with offline regressions, health, bounded concurrency/cache and Docker image. Independent ownership: `services/yfinance/`, `deploy/pern/yfinance.Dockerfile`.
- [x] Node adapter: validate sidecar DTOs and source units/FX direction, select yfinance explicitly, and test HTTP failures/timeouts. Root owns Node files.
- [x] Trading integration: test delayed/unknown-session yfinance fills in six currencies, identical observation reconfirmation, missing/outage/future/mismatched inputs, pending fills and unchanged strict Yahoo/fixture behavior. Implement provider-specific receipt checks without changing source timestamps.
- [x] UI/configuration: enable yfinance paper trades without delay labels, wire internal Compose service and standalone environment/setup, and preserve old provider modes.
- [x] Verify Python, full TypeScript/backend/frontend suites, production browser flow, real yfinance observations and exact accounting in a disposable database. Review the whole change and record limits/results.

## Review focus

No synthetic fallback; no accidental revival of legacy Oracle; no binary JS financial arithmetic; Python raw scalars are converted to strings at the library boundary; observed and fetched times remain distinct; outages do not renew receipts; same-time conflicting source values cannot overwrite old ones; indices and paused instruments remain unavailable; all order types share provider policy; no delayed-data label in the UI.

The untracked free-provider research report from the interrupted earlier task is preserved and is not part of runtime changes. No existing application database/volume is reset during verification.

## Verification results: 3 November 2026

- Python:13 offline tests passed with deprecation warnings treated as errors, both in the local Python3.10 virtual environment and the built Python3.12 Docker image.
- TypeScript typecheck passed. Backend:20 unit tests and209 integration tests passed across21 integration files using the disposable PostgreSQL instance.
- Frontend API and contract suites passed; production Vite build passed. Original browser coverage passed across10 routes; the added yfinance production browser flow filled a paper trade without a delayed-data label and verified exact ledger values.
- Actual yfinance quotes and INR-directed FX filled six representative equity orders in a disposable database. Cash/position/ledger reconciliation was balanced; evidence is in `docs/evidence/yfinance-paper-trades-2026-11-03.json`.
- Read-only whole-change review found no actionable bugs. No existing application database or volume was reset.
- Rebuilt and started the existing local Compose stack with yfinance selected, retaining its database volume and credentials. All five long-running services reported healthy, `/api/health/ready` returned200, and the API fetched an actual AAPL quote through the private Python3.12 service. Stopped only the disposable test database and temporary standalone probe service afterward.

The source library returns native numeric scalars; original upstream JSON numeric lexeme precision is not claimed. Delays, unknown sessions, and old source observations are intentionally accepted under the user's paper-trading policy. This does not qualify an exchange-grade live feed or provide complete corporate-action monitoring.
