# Streaming verification — 2026-11-04

## Scope and implementation

Tested the shared yfinance 1.8.0 socket, elected worker, PostgreSQL persistence,
authenticated SSE transport and browser consumers. The feature is based on commit
`2f51fe8` and adds no database migration or dependency. The isolated branch excludes
concurrent demo/history changes; a second run checks the combined working tree.
See [architecture and limits](../PERN_STREAMING.md).

## Executed checks

| Check | Isolated streaming feature | Combined working tree |
| --- | --- | --- |
| Backend unit tests | 20 passed | 20 passed |
| Database integration tests (`npm run test:foundation`) | 427 passed, 27 files | 459 passed, 32 files |
| Browser transport/unit tests (`npm run test:web`) | 26 passed | 29 passed |
| Python 3.12, hash-locked dependencies | 29 passed | 38 passed |
| Production browser workflows (`npm run test:e2e`) | All seven scripts passed | Streaming workflow checked separately |
| Deployment checks (`npm run test:deploy`) | 6 passed | Same deployment files |
| TypeScript and production web builds | Passed with browser suite | Passed with streaming workflow |

The seven browser scripts include the production route, yfinance trading, audit,
catalogue, completeness, interaction and streaming workflows. The interaction script
reports 25 passing scenarios. Tests use disposable PostgreSQL databases and a
controlled HTTP/SSE source; normal user balances and orders are not test fixtures.
Host Python lacks the project's runtime dependencies, so Python acceptance uses the
locked Docker environment rather than the system interpreter.

## Failure and financial checks

- Python: real protobuf integer strings, millisecond timestamps, precision hints,
  explicit units, missing currency bound to recent independently verified metadata,
  metadata expiry, replay rejection, bounded latest-per-symbol queues, subscription
  churn, consumer limits, lease expiry, reconnect after EOF and cancellation during
  connection setup. Private handlers reject malformed subscription requests.
- Persistence: newer observations alone advance stream freshness; equal/older,
  invalid and future ticks cannot. Explicit GBp conversion remains in SQL, changed
  units pause an instrument, HTTP suppression requires a successful stream receipt,
  and FX refresh remains independent. An identical whole-second HTTP observation
  confirms a precise same-second stream observation without rolling back source time;
  a conflicting price cannot use that recovery path.
- Worker: chunked SSE parsing, malformed/oversized input, two-process leader election,
  abort/reconnect, dynamic subscriptions and bounded unit validation. A real database
  integration follows a controlled tick through a LIMIT buy of two shares at 140.25
  USD, settling 23,281.50 INR; one execution and one alert notification are recorded.
  Replays/reconnects do not duplicate fills, and account reconciliation passes.
- API: authentication, origin/query/instrument validation, shared database listener,
  public quote-only payloads, opaque activity notifications, connection limits,
  disconnect cleanup and session revocation at the next heartbeat.
- Browser: timestamp-aware HTTP/stream merging, stale receipts, replay, frozen input
  objects, pause propagation, bounded cache/reconnect, hidden-tab/logout cleanup.
  The actual authenticated SSE workflow updates stock price, trade estimates without
  resetting quantity, watchlist and SQL-valued portfolio; unchanged-price bursts make
  no extra portfolio GETs, and returning to a visible tab recovers the latest quote.
- Scheduled and quote-triggered execution serialize; quote bursts coalesce to at
  most one evaluation batch per second. Unchanged resources emit no activity event.

## Real Yahoo probes

One upstream socket at a time, without placing orders:

- BTC-USD: received a normalized USD tick at `2026-11-04T06:01:26.000Z`.
- RELIANCE.NS: an initial raw probe received 35 messages whose currency field was
  absent. This exposed a real protocol edge case rather than assuming suffix-based
  units. After HTTP metadata validation, received a normalized `1301.30 INR` tick at
  `2026-11-04T06:12:21.000Z` through the implemented hub.

The final independent static review covered lifecycle, election, persistence,
authentication, frontend merging and deployment; no concrete blocking defect was
identified. It did not independently repeat the test suite or provider load tests.

These probes establish working delivery for those instruments at those times.
They do not establish provider quotas, universal instrument support, uninterrupted
availability or one price change every second. Yahoo/exchange delays still apply;
no synthetic prices or fabricated timestamps are generated.

## Local activation

Rebuilt and restarted the API, worker, web and market-data services from the
combined working source. All four services and PostgreSQL report healthy, and
`GET /api/health/ready` through port 3000 returns 200 with `status: ok`. The local
database uses schema 6 from concurrent demo work; the isolated feature baseline
expects schema 5 and was deliberately not deployed against it. No migration or
seed reset was run for streaming activation.

A post-restart read-only probe from the API container returned HTTP 200 from the
private stream and received `RELIANCE.NS` at `1301.60 INR`, source time
`2026-11-04T06:28:17.000Z`. The database also contained recently received
RELIANCE.NS, MSFT and NIFTY observations. This probe joined the shared private feed;
it neither changed subscriptions nor placed an order.
