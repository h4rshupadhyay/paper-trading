# Shared yfinance quote streaming

The user approved implementing the previously discussed shared stream so stock
pages, watchlists, trade estimates and portfolio values react to real quotes.
Existing quote eligibility and exact SQL accounting remain authoritative.

## Approach

Use one `yfinance.AsyncWebSocket` in the private Python service. A single elected
Node worker consumes it, validates observations and persists quotes. PostgreSQL
notifications carry only instrument IDs to the API; authenticated SSE delivers
public quote snapshots to browsers. SSE fits the one-way browser data flow and
avoids an additional WebSocket dependency. Separate per-browser Yahoo connections
would multiply upstream subscriptions; faster HTTP polling would retain the rate
pressure this change addresses.

The Python service exposes private `POST /subscriptions` with `{symbols: string[]}`
(maximum 100) and `GET /stream` SSE. It sends `event: quote` with JSON
`{symbol, quote:{rawPrice,rawCurrency,observedAt,session:'UNKNOWN',actionKey:'yfinance-raw'}}`.
The lease is renewed every 15 seconds and expires after 45 seconds without renewal.
No data is generated locally. Tick prices are normalized using Yahoo's price hint
to avoid protobuf float artifacts; invalid price, hint or source time are rejected.
Missing wire currency requires independently verified HTTP metadata less than 90
seconds old; otherwise the tick is rejected. Explicit ambiguous GBP is rejected.
Source time is milliseconds since Unix epoch, retained in ISO
UTC. Equal or older observations cannot renew stream freshness. Unsupported units
fall back to HTTP rather than being guessed.

## Ownership and bounds

The Python hub owns connection recreation, exponential backoff with jitter, actual
subscription changes, bounded latest-per-symbol queues and graceful shutdown.
Worker election uses advisory lock 1480963207. Subscriptions include pending orders,
positions, active alerts, watchlists and recently requested browser instruments;
100 is our protective cap, not a published Yahoo quota. API browser requests notify
the worker of instrument interests with a 90-second lease, renewed by heartbeat.
Subscriptions refresh from SQL every 15 seconds. No schema change is required.

The worker persists through the existing per-instrument advisory lock and unit,
timestamp, provider and action-key checks. Notifications are transactional. A
stream tick must be strictly newer than the stored source observation. Existing
HTTP recovery may renew identical observations under the current paper policy.
Fresh streamed quotes suppress redundant HTTP quote fetches. Bounded successful
HTTP unit checks are due every 60 seconds, including browser-only interests; failed
checks retry no sooner than 30 seconds. FX, statistics and history retain independent
bounded HTTP refreshes. An identical whole-second HTTP confirmation can renew the
receipt of its same-second stream observation without rolling back source precision.

Accepted ticks wake the existing worker loop for pending-order and alert evaluation,
coalesced to at most one batch per second and never overlapping its normal batch.
An activity invalidation follows actual order/alert state changes; consumers reload owned resources
through authenticated APIs. Streaming does not bypass account locks, reconciliation,
expiry, idempotency, paused instruments or FX eligibility.

## Browser contract

`GET /api/market/stream?ids=<comma-separated UUIDs>` uses session cookies and rejects
unknown query keys, invalid/unknown IDs and excessive subscriptions. Each SSE
`quote` carries `{instrumentId,symbol,quote,quality,unavailableReason}` with quote
fields identical to `readQuote`. An `activity` event has `{}` and contains no account
information. Heartbeats keep proxies alive, periodically revalidate authentication
and renew interests. Slow clients are disconnected; client and listener counts are
bounded. Logout, disconnect and API shutdown release resources. Proxy buffering is
disabled for the feed. Browser consumers share a connection, pause when hidden and
recover on return. HTTP remains the initial and fallback path.

Stock prices and trade estimates merge events without resetting chart controls or
form inputs. Watchlists merge market fields while preserving edits. Portfolio
revaluation uses coalesced internal GETs, at most once per second while quotes move,
so SQL remains the money arithmetic authority. Pending orders and notifications
refresh after activity events. No routine status badges or fabricated changes.
Historical bars keep their original meaning; any current-price chart overlay must
be explicitly separate from historical OHLC data.

## Verification and limits

Test tick validation, queue bounds, subscription churn, fresh-client reconnection,
shutdown, authentication, slow consumers, monotonic persistence, pence handling,
no duplicate fills, event-driven UI changes, list race preservation and fallback.
Use controlled streams and seeded database tests for deterministic evidence. Run
the Python, frontend, backend, browser and deployment suites, and report any
existing failures. Add change history and focused commits without staging earlier
demo work. Yahoo availability and per-second delivery remain outside our control.
