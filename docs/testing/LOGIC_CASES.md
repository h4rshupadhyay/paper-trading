# Deterministic financial and interaction logic cases

`apps/server/test/seeded-logic.test.ts` extends the existing trading, yfinance-trading, reconciliation, tools and portfolio tests. It runs against the guarded `createHarness()` instance: a new disposable database per case, latest migrations, fixtures written through `ownerPool`, application services called through the restricted `appPool`. It never reads the application database URL, starts a stack, or contacts a live provider.

## Cases and failure classes

| ID | Cases | Behavior and failure classes |
| --- | ---: | --- |
| LOGIC-001 | 3 | Seeds `0x51eed` (335597), `0xc0ffee` (12648430), `0xdecaf` (912559): 40 transitions each plus final liquidation. Fractional quantities/prices, partial/full liquidation, reentry and attempted short sells. Detects arithmetic drift, cost loss, negative cash/positions, ledger gaps and duplicate fills. |
| LOGIC-002 | 2 | Hand-calculated buys of 3 at 0.01 and 4 at 0.02, sell 1 at 0.03: residual native/base cost 0.09428571; cash 999999.92. Sell remaining 6: cash 1000000.10, zero cost. Then test accepted buy reentry or rejected naked sell. |
| LOGIC-003 | 8 | BUY/SELL × MARKET/LIMIT/STOP/STOP_LIMIT. One price tick outside crossing remains OPEN, exact equality fills once under competing evaluators, and canonical decimal/UUID retry replays despite missing data and provider outage. |
| LOGIC-004 | 6 | INR/USD/GBP/EUR/JPY/HKD fractional FX and partial/full sells. Literal first settlements 0.03/2.50/3.00/2.72/0.02/0.30. GBP uses raw GBp at multiplier 0.01 and normalized major-unit price, detecting double normalization. |
| LOGIC-005 | 3 | Minimum quantity 0.0001 × price immediately below 50, exactly 50, and 999999999999.99999999: zero rejection, half-cent rounds up to 0.01, and large exact settlement fails insufficient cash without numeric corruption. |
| LOGIC-006 | 1 | Concurrent duplicate normalized buys plus a sell on one account. Exactly one replay, a serial ledger and unchanged state after conflicting intent retry. |
| LOGIC-007 | 1 | A gapped TRIGGERED stop-limit expires before price returns to its limit, while cancellation and two evaluators race. Either cancellation or expiry wins, never execution or resurrection; evaluator failures are not swallowed. |
| LOGIC-008 | 1 | Same pending order across missing quote, missing FX, paused and view-only states stays OPEN without reserving cash; inactive owner causes terminal rejection and blocks new submission. |
| LOGIC-009 | 1 | Concurrent watchlist insertion dedup; foreign folder rejection; folder deletion merge; two inclusive alerts at the exact same threshold, other-owner near-boundary alert, notification ownership, and no rearming on later crossings. |
| LOGIC-010 | 1 | Complete saved snapshot → new account version with missing quote → incomplete sampling preserves prior durable snapshot and dirty flag → stale known-price recovery samples current account version and exact total. |

## Independent oracle and checks

The oracle imports no production arithmetic helpers or SQL fragments. BigInt values represent quantity in 1/10000 shares, native/base costs in 1/100000000 currency units, cash in cents, and FX in 1/1000000000000 units. Rational products round to nearest with positive ties upward. A small LCG supplies repeatable operation selection, without using floating point for financial values. Random UUIDs only isolate fixture identity and idempotency keys; they do not determine expected amounts or operations.

Every modeled trade, including rejected trades, checks exact account cash/sequence, quantity and both remaining costs; nonnegative projections; native/base purchased cost equals remaining plus allocated cost; every ledger running balance and contiguous sequence; one execution for each FILLED order and none for other statuses; and application reconciliation including execution/ledger/position mismatch counts. Filled market trades also compare every execution's native amount, allocated costs and realized P/L to the model. Literal fixtures and threshold tables anchor the model to hand-checkable outputs.

The model intentionally describes long, cash-only trades. It does not invent fees, shorting, FX spreads, reserved buying power, or market calendars. Missing market data leaves pending orders pending; immediate MARKET orders require eligible data, as covered in existing trading tests. Instrument gates on already queued orders defer evaluation; inactive owners terminate queued orders. These are existing service rules, not newly specified features. This suite is not evidence of live-provider reliability or exhaustive timing schedules.

## Run and result

From `apps/server`:

```bash
TEST_DATABASE_ADMIN_URL=postgresql://paper_test_admin:paper_test_admin_only@127.0.0.1:55439/paper_foundation_test_admin \
  npm exec vitest -- --run --project integration test/seeded-logic.test.ts
```

Result: **27 tests passed**, including **120 seeded transitions plus final liquidations**. No production failure was discovered in this run. Initial test-authoring errors (a cash-ledger text alias sorted lexically, and an incorrect half-cent fixture assertion) were corrected; production code was unchanged.
