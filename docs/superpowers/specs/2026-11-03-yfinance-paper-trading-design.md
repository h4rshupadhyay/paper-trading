# yfinance paper trading

The user put licensed/free-provider acceptance research aside and selected yfinance. When asked about execution semantics, the user explicitly instructed: “don't label , trade with those prices only”. This authorizes paper execution at valid yfinance observations, including delayed or closed-market observations, without a delayed-data label. The old strict live-feed acceptance task is deferred; this change does not claim exchange-grade execution acceptance.

## Design

Keep React, Express/Node, the Node worker and PostgreSQL. Add an internal Python yfinance service shared by API/worker. It has no database credentials and exposes only health, search, quote, raw history and INR-directed FX. Do not revive the legacy Flask/Oracle runtime or its zero-price/hardcoded-FX fallbacks.

The provider identity is `yfinance`; old Yahoo instruments keep their existing identity. yfinance equities are paper-tradable; indices remain view-only. Read the latest valid yfinance quote/FX values, normalize currencies in PostgreSQL, and settle using existing SQL decimal accounting. Unknown/closed sessions and old source timestamps alone no longer block this selected provider. A quote must have been successfully fetched/confirmed within60 seconds and FX within24 hours; source timestamps cannot be in the future. Repeated retrieval of identical source observations updates receipt time without changing source time or replacing conflicting same-time values. An outage cannot renew receipts or substitute fixtures, previous closes invented by the app, zero values, or fixed exchange rates.

At the Python boundary, yfinance's native numeric scalars become decimal strings without price arithmetic; downstream normalization/settlement remains PostgreSQL numeric. Historical data requests explicitly disable automatic adjustment and repair. No automatic split/dividend position adjustment is added; the existing unit/currency pause remains. A stable yfinance raw-price action identity does not claim complete corporate-action monitoring.

The UI enables trading for available yfinance equities even when the recorded source quality is stale or session unknown; it adds no delayed-data label. Missing data still disables/blocks execution. Fixture behavior and the strict `yahoo` provider policy remain unchanged. Paper accounting rules, idempotency, owner isolation, pending-order expiry/cancellation and persistence remain unchanged.

## Internal service contract

- `GET /health` returns `{ok:true}`.
- `GET /search?q=...` returns `{items:ProviderInstrument[]}` using the existing backend DTO. Empty search bootstraps AAPL, RELIANCE.NS, VOD.L, SAP.DE, 7203.T and 0700.HK. Limit discovery to six bootstrap/four searched instruments.
- `GET /quote?symbol=...` returns `{instrument:ProviderInstrument,quote:{rawPrice,rawCurrency,observedAt,session:"UNKNOWN",actionKey:"yfinance-raw"}}`.
- `GET /history?symbol=...&period=...&interval=...` returns `{instrument:ProviderInstrument,items:ProviderBar[]}`; at most2000 raw bars and the existing supported ranges/intervals.
- `GET /fx?currency=...` returns `{currency,rate,observedAt}` meaning INR per one unit, validating Yahoo's exact pair/currency metadata. INR identity is exactly1.

No sidecar host port is published by Compose. Calls have bounded timeouts/concurrency and short caches retain actual observation time. Failures return unavailable responses, not plausible-looking prices. Default environment examples select yfinance; standalone development uses an explicit service URL.
