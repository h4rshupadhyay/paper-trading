# PERN market-provider validation

Validation date: 2 November 2026. Live trading acceptance: **unavailable in all six regions**. The Yahoo adapter supports discovery, display quotes, raw OHLC history and INR-directed FX, but reachability is not execution acceptance. Every discovered Yahoo instrument has `tradable=false` and an explicit reason. The adapter emits `session=UNKNOWN`; it never infers a confirmed regular session from a calendar window or substitutes a previous close.

## Providers and sources

`MARKET_PROVIDER=yahoo` is the default. The adapter uses Node's native fetch against Yahoo's public chart and search endpoints. It adds no runtime dependency on Python or on the yahoo-finance2 package. Its endpoint and field investigation used the package maintainer's primary source: [chart module](https://github.com/gadicc/yahoo-finance2/blob/dev/src/modules/chart.ts) and [search module](https://github.com/gadicc/yahoo-finance2/blob/dev/src/modules/search.ts). The chart module exposes OHLC arrays separately from adjusted-close data and includes currency, observation timestamps, trading periods and optional events. These package sources describe the transport; they do not establish an exchange data entitlement or complete corporate-action coverage.

Yahoo's own [exchanges and data delays](https://help.yahoo.com/kb/finance/article-exchanges-data-delays-sln2310.html) page was also requested. That documentation request returned HTTP429 in this environment. No exact exchange delay or live-data guarantee is claimed from that inaccessible page.

`MARKET_PROVIDER=fixture` explicitly enables deterministic simulator prices and FX for development/test. It is rejected when `NODE_ENV=production`. There is no fallback from Yahoo to fixture, and no market-acceptance override in an environment variable. Fixtures intentionally simulate regular sessions independently of real exchange hours, with price150, configurable chart periods/intervals, full six-currency coverage, and view-only indices. They are not real market observations.

## Live probe results

At approximately **2026-11-02 12:54 UTC**, a bounded native HTTP probe requested six equities, their six region indices, and five `currencyINR=X` pairs, using two concurrent requests and a three-second timeout. All 17 requests returned HTTP200. This proves endpoint reachability and representative metadata coverage only. It did not validate every symbol, intraday period, event scenario or execution eligibility.

At **2026-11-02 12:59 UTC**, the actual TypeScript provider, normalization service and restricted `paper_app` role ran against a newly created isolated PostgreSQL database, migrated only through 002 and dropped afterward. Six live instruments were discovered and their observations persisted. The following results came from that implementation, including SQL numeric normalization and SQL freshness classification:

| Region | Equity | Raw currency → normalized | Quote observation UTC | Stored major-unit price | Unadjusted daily bars | Live trading |
| --- | --- | --- | --- | --- | --- | --- |
| US | AAPL | USD → USD | 2026-10-30 20:00:01 | 344.63000000 | 65 | Unavailable |
| India | RELIANCE.NS | INR → INR | 2026-11-02 09:59:30 | 1300.00000000 | 63 | Unavailable |
| UK | VOD.L | GBp ×0.01 → GBP | 2026-11-02 12:43:45 | 1.17300000 | 65 | Unavailable |
| Europe (Germany sample) | SAP.DE | EUR → EUR | 2026-11-02 12:44:02 | 209.10000000 | 66 | Unavailable |
| Japan | 7203.T | JPY → JPY | 2026-11-02 06:30:00 | 3051.00000000 | 61 | Unavailable |
| Hong Kong | 0700.HK | HKD → HKD | 2026-11-02 08:08:13 | 392.20000000 | 64 | Unavailable |

Every persisted quote was `quality=stale` under the 60-second execution threshold and `session=UNKNOWN`. In particular, the contemporaneous UK/German observations were approximately15 minutes old. This is an observation from this probe, not a promise about future provider delay. No region passes the required confirmed-session/action/freshness proof.

Representative index endpoints also returned HTTP200 and `instrumentType=INDEX`: `^GSPC`, `^NSEI`, `^FTSE`, `^GDAXI`, `^N225`, `^HSI`, with currencies USD/INR/GBP/EUR/JPY/HKD respectively. Indices always remain view-only, including in fixture mode. Live bootstrap discovers the six equities; an index becomes a persistent canonical instrument through instrument search after its own currency/unit metadata probe.

The persisted FX direction is **INR per one unit of `currency`**:

| Currency | Rate | Provider observation UTC |
| --- | --- | --- |
| INR | 1.000000000000 | Identity, established at request time |
| USD | 94.900000000000 | 2026-11-02 10:02:26 |
| GBP | 127.216200000000 | 2026-11-02 10:29:29 |
| EUR | 106.400100000000 | 2026-11-02 10:29:29 |
| JPY | 0.600600000000 | 2026-11-02 10:29:29 |
| HKD | 12.095300000000 | 2026-11-02 10:29:29 |

The adapter checks the pair symbol and response currency instead of guessing rate direction. INR/INR is exactly1 by definition. Other fixture rates are explicit simulator inputs, never production defaults. Quote/FX fetch times do not extend their provider observation age.

## Execution acceptance still required

For each region, a future acceptance change must establish a confirmed current regular session, quotes no older than60 seconds, supported units/currency, FX no older than24hours, and complete corporate-action detection suitable for held/live-order instruments. Current optional chart events over a rolling range do not prove complete action history. Their hash is retained as conservative change metadata; a changed action identity at the same or a newer quote timestamp pauses execution. Changed currency/unit metadata also pauses an instrument. No automatic split/dividend accounting or unpause flow exists.

Live availability remains explicitly disabled until this evidence exists and the adapter has a supported way to represent it. A reachable endpoint, populated history or a recent FX observation does not satisfy the remaining conditions.

## Operational bounds and durability

- Native HTTP timeout:2.5 seconds per call; at most two concurrent calls and24 calls/minute per provider instance. The application API and worker each have their own process instance. Aggregate quotas across multiple processes are not a provider entitlement and must be sized separately.
- Quote refresh holds a dedicated PostgreSQL session advisory lock per instrument across bounded network calls, then releases in `finally`. Competing refreshes skip the busy instrument. The market write transaction is short and independent of account/trade locks.
- Provider methods are bounded to 8 seconds; discovery to 20 seconds. A single instrument shares an eight-second network budget across quote and FX calls. Active refresh selects at most eight held/live-order/watched/alert instruments with the oldest durable refresh-attempt timestamps, runs at most two concurrently, and shares one eight-second network deadline across the whole batch. Failed attempts advance scheduling age without changing observation validity. Unstarted candidates retain their older age for later cycles. Session batch lock 3206 prevents competing worker batches, in addition to per-instrument lock 3203. Large catalogues require later cycles; this release does not promise fresh quotes for every active instrument beyond the provider quota.
- FX list requests refresh missing/stale cached currencies on demand under a dedicated advisory lock, with a15-second fetch cooldown. Network failures retain observations and expose their real age.
- Older/equal quote timestamps cannot overwrite prices, and older FX observations cannot replace newer rates. A same-timestamp corporate-action change can still pause execution. Invalid source values/metadata never become new usable observations.
- JSON price/rate numeric lexemes are retained as strings before parsing. Unit multiplication, rounding to eight-place prices and12-place FX, and freshness comparisons use PostgreSQL numeric/time operations. The chart uses unadjusted OHLC values. Financial application code performs no binary-floating arithmetic.
- History accepts period `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `5y` and interval `5m`, `15m`, `1d`, `1wk`, `1mo`; unsupported upstream combinations return explicit unavailable history. Responses are bounded to2000 valid bars. Provider failures return empty unavailable history rather than invented candles.

## Automated evidence

The focused market suite covers real isolated PostgreSQL migrations and runtime privileges, pence normalization, long provider numeric lexemes, stale/closed/future observations, invalid source metadata, timezone qualification, FX direction/age/monotonicity, quote monotonicity and outage preservation, same-time action changes, unit changes, advisory-lock races and release, fixture coverage, provider HTTP failure/timeout/call limits, production fixture rejection, canonical authenticated REST DTOs, on-demand FX, and history query validation. Native-provider probes described above were run separately from deterministic tests and are not presented as passing live execution acceptance.

Provider mode changes do not turn persisted simulator inputs into live fallback data: HTTP FX reads and cache checks are scoped to the selected provider, and history requires the instrument's matching provider. The trading layer must also match instrument/quote/FX provider identities and prohibit fixture execution in production; these guards complement selection-time rejection of production fixture mode.
