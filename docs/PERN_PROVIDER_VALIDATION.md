# PERN market-provider validation

**Scope:** this document records the strict evaluation of the separate `MARKET_PROVIDER=yahoo` adapter. The default is now `MARKET_PROVIDER=yfinance`, which uses a different, user-selected policy allowing paper trades at the latest returned prices. See [yfinance setup and evidence](PERN_YFINANCE.md). The historical acceptance failures below do not disable yfinance paper trading and are not claims of exchange-grade feed acceptance.

Latest recheck: **3 November 2026**, with the original 2 November observations retained below. Live trading acceptance: **unavailable in all six regions**. The Yahoo adapter supports discovery, display quotes, raw OHLC history and INR-directed FX, but reachability is not execution acceptance. Every discovered Yahoo instrument has `tradable=false` and an explicit reason. The adapter emits `session=UNKNOWN`; it never infers a confirmed regular session from a calendar window or substitutes a previous close.

## Repeatable recheck: 3 November 2026

At **14:03 UTC (19:33 IST)** the actual Yahoo adapter, normalization service, restricted runtime role and trading service ran in a newly created disposable PostgreSQL database. All 23 bounded Yahoo requests returned HTTP200. The probe persisted public observations, checked history and INR-directed FX, attempted a market order for each live instrument, then separately ran the explicitly simulated fixture provider. No existing application database or runtime configuration was changed. The probe database was dropped afterward.

| Region sample | Symbol | Stored major-unit price | Quote observation UTC | Approximate age at check | Live order |
| --- | --- | --- | --- | --- | --- |
| US / Nasdaq | AAPL | 338.32000000 USD | 2026-11-02 21:00:01 | 61,403 seconds | Blocked |
| India / NSE | RELIANCE.NS | 1307.90000000 INR | 2026-11-03 09:59:39 | 14,625 seconds | Blocked |
| UK / LSE | VOD.L | 1.17650000 GBP | 2026-11-03 13:48:21 | 904 seconds | Blocked |
| Europe / Germany only | SAP.DE | 203.50000000 EUR | 2026-11-03 13:47:57 | 928 seconds | Blocked |
| Japan / Tokyo | 7203.T | 3051.00000000 JPY | 2026-11-02 06:30:00 | 113,605 seconds | Blocked |
| Hong Kong | 0700.HK | 397.20000000 HKD | 2026-11-03 08:08:06 | 21,320 seconds | Blocked |

Every quote was older than60 seconds, every session remained `UNKNOWN`, and every live order returned `INSTRUMENT_UNAVAILABLE`. LSE pence normalized in PostgreSQL from117.65 GBp to1.17650000 GBP. All six currency observations were within the24-hour FX limit; history returned61–67 raw daily bars per sample. These successes do not resolve session, quote freshness, entitlements or complete corporate-action coverage. In particular, empty/rolling action data cannot prove that a split or dividend was absent. Closed-market observations do not establish a feed's regular-session delay; the UK/Germany samples here were approximately15 minutes old, not a general provider delay guarantee.

The separate fixture run filled one market BUY for each sample in all six currencies, and independent reconciliation reported balanced cash/positions. The report labels those rows `simulated`; they are not live evidence. See the [machine-readable probe evidence](evidence/provider-validation-2026-11-03.json) and [official-source alternatives review](PERN_PROVIDER_RESEARCH.md). A representative equity does not establish full venue coverage, and the German sample does not establish all European markets.

To repeat, use the pinned Node/npm runtime, install dependencies, and start only the dedicated disposable test instance:

```bash
npm run test:db:up
TEST_DATABASE_ADMIN_URL=postgresql://paper_test_admin:paper_test_admin_only@127.0.0.1:55439/paper_foundation_test_admin \
  npm run --silent market:validate > provider-validation.json
# Exit 2 means the report was produced but live acceptance was not established.
# Exit 1 means a probe invariant or execution failed; inspect stderr and any report.
npm run test:db:down
```

The probe refuses production mode and its harness refuses connections outside the disposable instance. It changes no live eligibility flags or provider settings. Quote/FX values remain PostgreSQL decimal strings; only observation ages use numeric arithmetic. It makes at most23 Yahoo requests per run with the existing timeouts. Do not run concurrent probes to evade provider quotas. Some venues are closed whenever others are open, so acceptance needs separate dated regular-session runs and exceptional-session/action scenarios, not one successful sweep.

**Next evidence required:** a provider account with all relevant exchange/API usage permissions; confirmed quote observation timestamps and units; regular-session/halts semantics; complete split/dividend coverage and correction handling; INR-directed FX; and quota/latency evidence for the actual held/order universe. The user confirmed that no provider account is currently available. Public Twelve Data/EODHD offerings reviewed do not establish a six-region <=60-second feed; IBKR is an entitlement lead requiring account-specific feasibility checks, not an accepted replacement. No region is enabled by this review.

## Providers and sources

`MARKET_PROVIDER=yahoo` selects the original view-only adapter. The adapter uses Node's native fetch against Yahoo's public chart and search endpoints. It adds no runtime dependency on Python or on the yahoo-finance2 package. Its endpoint and field investigation used the package maintainer's primary source: [chart module](https://github.com/gadicc/yahoo-finance2/blob/dev/src/modules/chart.ts) and [search module](https://github.com/gadicc/yahoo-finance2/blob/dev/src/modules/search.ts). The chart module exposes OHLC arrays separately from adjusted-close data and includes currency, observation timestamps, trading periods and optional events. These package sources describe the transport; they do not establish an exchange data entitlement or complete corporate-action coverage.

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
