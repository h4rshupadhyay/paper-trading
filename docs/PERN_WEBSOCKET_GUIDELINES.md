# Yahoo/yfinance WebSocket guidelines

Historical research checked 4 November 2026 against upstream documentation and
the then-pinned `yfinance==1.7.0` source. The application now uses 1.8.0 with shared
streaming; see [current implementation](PERN_STREAMING.md) and
[verification](testing/STREAMING_2026-11-04.md). The observations below record the
research stage, not the current deployment state.

## Does WebSocket prevent rate limiting?

**No guarantee.** Streaming can reduce repeated HTTP quote polling by receiving updates over an existing connection; that is an architectural inference from the documented subscription/listening interface. It does not establish immunity from throttling, connection refusal or disconnection. The reviewed yfinance WebSocket/API pages and Yahoo market-data help pages publish **no numeric WebSocket quota** for connections, symbols per connection, subscription messages or reconnect attempts. Treat these limits as unknown, not unlimited. No reviewed source promises a delivery interval or uptime SLA. [yfinance WebSocket guide](https://ranaroussi.github.io/yfinance/reference/yfinance.websocket.html), [AsyncWebSocket API](https://ranaroussi.github.io/yfinance/reference/api/yfinance.AsyncWebSocket.html)

HTTP requests for history, fundamentals and other non-streaming data remain separate operations. Moving quote updates onto a socket does not prove those requests cannot encounter HTTP rate limits. [yfinance public API overview](https://ranaroussi.github.io/yfinance/reference/index.html)

## Verified client behavior, not Yahoo quotas

In the pinned [1.7.0 implementation](https://raw.githubusercontent.com/ranaroussi/yfinance/1.7.0/yfinance/live.py):

- The default endpoint is `wss://streamer.finance.yahoo.com/?version=2`.
- `AsyncWebSocket.subscribe()` keeps a set of symbols and sends the full current set; `unsubscribe()` removes symbols and sends an unsubscribe message.
- Its background task resends subscriptions every **15 seconds**. This is a subscription heartbeat, not a price update cadence, quota or freshness guarantee.
- The handled listener-error path waits **3 seconds** before calling `_connect()`. This is library behavior, not a Yahoo-approved retry policy. With exception hiding disabled, the exception is raised instead.
- Recovery needs verification: `_connect()` creates a connection only when `_ws is None`; `close()` does not reset `_ws` or the heartbeat task reference. Do not assume this loop reliably replaces a dead connection or restores subscriptions.

These observations are specific to the async client; the synchronous implementation differs. The running container's version/source was also checked against 1.7.0 during this investigation.

## Market availability and delays

Yahoo says realtime streaming is available for many exchanges during market hours, sometimes pre/post market, but not every market streams in realtime. Its exchange table lists NSE `.NS` as realtime and BSE `.BO` as 15-minute delayed. These describe Yahoo Finance coverage, **not guaranteed socket support or delivery latency for every instrument**. A successful connection or subscription is insufficient evidence that a quote is fresh. [Yahoo realtime help](https://help.yahoo.com/kb/SLN2321.html), [Yahoo exchange/delay table](https://help.yahoo.com/kb/SLN2310.html)

## Practical application guidance

Engineering recommendations, not published Yahoo limits: share a bounded upstream stream across local consumers, subscribe only to needed symbols, avoid subscription churn, and use capped exponential backoff with jitter when rebuilding failed clients. Monitor disconnects, provider observation timestamps and receive times independently; preserve stale/unavailable states rather than refreshing the observation time locally. Verify the selected instruments during their regular sessions before relying on them.

Streaming alone does not validate this app's execution requirements for session status, currency units, FX or corporate actions. Keep existing execution eligibility gates until all required evidence is established.

The project states that yfinance is unaffiliated with Yahoo, intended for research/education, and that Yahoo Finance API use is personal; it directs users to Yahoo's terms for data rights. Yahoo's help page separately prohibits redistribution and describes data as informational. A working stream does not establish permission to redistribute quotes in a shared application. [yfinance 1.7.0 README](https://raw.githubusercontent.com/ranaroussi/yfinance/1.7.0/README.md), [Yahoo data-provider notice](https://help.yahoo.com/kb/SLN2310.html)

Research limitation: direct Yahoo Help fetches returned HTTP 429, while current first-party search extracts exposed the cited help content. That retrieval result concerns the documentation request; it is not evidence of the application's feed being throttled. Yahoo legal pages were not successfully retrieved, so this note does not claim a complete review of their terms.
