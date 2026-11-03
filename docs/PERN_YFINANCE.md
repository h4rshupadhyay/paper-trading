# yfinance paper trading

`MARKET_PROVIDER=yfinance` is the default. Equities use the latest price returned by yfinance for paper trades, including older observations and unknown/closed sessions. The UI adds no delayed-data label. Indices remain view-only. This mode does not establish exchange-grade live-data acceptance; the separate strict Yahoo evaluation is retained in [provider validation](PERN_PROVIDER_VALIDATION.md).

## Price and accounting policy

- A quote must have been successfully received within60 seconds and FX within24 hours. Source timestamps remain separate from receipt timestamps; future source times beyond5 seconds are rejected.
- A successful repeat of an identical source observation can renew its receipt time. Conflicting prices or rates at the same timestamp cannot overwrite or renew the stored observation. Failed requests cannot renew receipts.
- Missing, invalid, mismatched, or expired inputs block execution. There is no synthetic fallback. Market and pending orders, alerts, and portfolio valuation use the same yfinance receipt policy.
- Prices and FX leave Python as decimal strings derived from yfinance's native scalars. This does not preserve the original upstream JSON numeric lexemes. PostgreSQL performs unit normalization, rounding, and settlement using `numeric`; JavaScript performs no financial arithmetic.
- GBP pence are normalized to pounds. History requests disable adjustment, repair, and rounding. Automatic split/dividend adjustments and complete corporate-action monitoring are not implemented. Currency/unit changes pause the instrument for review.
- Instruments retain their provider identity. Switching providers does not rewrite historical trades or convert existing fixture/Yahoo instruments into yfinance instruments.

## Docker

Follow the [README](../README.md#getting-started). The private `market-data` service runs yfinance1.7.0 on Python3.12 as a non-root user. It receives no database credentials and publishes no host port. API and worker use `http://market-data:8000` and wait for service health.

The bridge shares a two-request upstream concurrency limit across API and worker, uses short caches and bounded timeouts, and rejects excess requests without queueing them. It does not guarantee fresh receipts for an arbitrarily large active portfolio. External provider failures leave cached observations intact; expired receipts prevent further fills.

## Standalone development

Use Python3.10 or newer. From the repository root:

```bash
python3 -m venv .venv-market
. .venv-market/bin/activate
python -m pip install -r services/yfinance/requirements.txt
python services/yfinance/app.py
```

The service listens on `127.0.0.1:8000` by default. Configure both Node processes with `MARKET_PROVIDER=yfinance` and `YFINANCE_URL=http://127.0.0.1:8000`, as shown in `.env.pern.example`. Override `HOST`/`PORT` only when needed. Keep this unauthenticated internal service private.

Its read-only HTTP contract is `/health`, `/search?q=...`, `/quote?symbol=...`, `/history?symbol=...&period=...&interval=...`, and `/fx?currency=...`. FX direction is INR per unit of the requested currency. Invalid/unavailable data returns an error, with no invented previous-close or FX defaults.

## Verification

Offline service tests, with the virtual environment activated:

```bash
npm run test:market
```

The backend suite covers six-currency fills, exact reconciliation, repeated/conflicting observations, invalid/expired inputs, changed units, alerts, pending orders, and the unchanged strict Yahoo gate. The production browser flow submits a yfinance paper trade using an old source observation and unknown session, checks the absence of a delay label, and verifies the stored execution and ledger.

A separate real-provider probe ran at **2026-11-03 14:53:55 UTC**, using the actual Python service, Node adapter, and a disposable PostgreSQL database. All six representative equity orders filled:

| Region sample | Symbol | Execution price | INR settlement for one share |
| --- | --- | --- | --- |
| US | AAPL | 331.87000000 USD | 31438.05 |
| India | RELIANCE.NS | 1307.90000000 INR | 1307.90 |
| UK | VOD.L | 1.17650000 GBP | 149.53 |
| Germany | SAP.DE | 203.70000000 EUR | 21590.31 |
| Japan | 7203.T | 3051.00000000 JPY | 1825.72 |
| Hong Kong | 0700.HK | 397.20000000 HKD | 4796.90 |

Cash difference was0.00, position/execution/ledger mismatch counts were0, and independent reconciliation was balanced. See the [dated machine-readable evidence](evidence/yfinance-paper-trades-2026-11-03.json). These are real source prices and simulated account trades in an isolated database, not broker orders. Representative symbols do not establish every exchange or instrument's availability.

To repeat with the Python service running:

```bash
npm run test:db:up
YFINANCE_URL=http://127.0.0.1:8000 \
  TEST_DATABASE_ADMIN_URL=postgresql://paper_test_admin:paper_test_admin_only@127.0.0.1:55439/paper_foundation_test_admin \
  npm run --silent market:probe:yfinance > yfinance-paper-trades.json
npm run test:db:down
```

The probe refuses production mode, creates an isolated test database, and drops it afterward. It does not change the existing application database or provider configuration. Do not run concurrent probes to evade upstream quotas.


## Instrument statistics snapshots

Schema migration 005 adds display-only instrument statistics. The authenticated
`GET /api/instruments/:id/snapshot` endpoint reads a stored quote and an independent
statistics snapshot. Stored quotes return promptly and refresh in bounded background
work when older than 15 seconds; a cold quote gets one bounded bootstrap attempt.
Stock Detail polls every 15 seconds without resetting the selected chart period.
On the first visit, a separate authenticated `/api/instruments/:id/statistics` read
joins the pending bounded refresh so statistics appear as soon as it completes,
without delaying the quote or waiting for the next poll. Stored statistics still
return immediately. Successful data has no routine health/provider banner; receipt
times are in tooltips, with short notices only for loading or unavailable/older data.
The existing `/quote` endpoint and market-order refresh remain blocking.

The private bridge `/statistics?symbol=...` reads one `Ticker.info` response. Supported
optional fields are open, day high/low, previous close, volume, average volume,
market cap, trailing P/E and 52-week high/low, plus sector, industry and description.
Price fields in pence are normalized to pounds; market cap is already in major
currency units and volume/P/E are not currency-converted. Missing fields stay unavailable.

Successful statistics refreshes are spaced at least 30 minutes apart. Failures retry
no sooner than 60 seconds, preserve every stored field and its successful receipt
time, and never renew quote/FX freshness. Statistics older than 60 minutes are marked
stale and remain visible. A successful partial response replaces the entire snapshot;
old and new metrics are not combined. Receipt times are not provider observation times.
Statistics never enable or disable orders. No daily movement is inferred from a
separately fetched previous close with unknown session alignment.

The Node adapter admits up to two upstream requests and eight bounded waiting calls,
with admission consuming the existing timeout budget. Excess calls fail rather than
creating an unbounded queue. The Python bridge retains its shared two-slot limit.

Use the normal Compose rebuild/migration workflow to deploy schema 005; do not run
new API binaries against a schema-004 database. Forward migration preserves existing
account, execution, cash and position records. This implementation's verification uses
only disposable databases. Yahoo data remains subject to its terms and yfinance is
intended for personal research/education.
