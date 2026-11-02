# Paper trading

Language for the proposed trading system. Product choices in the accompanying design remain subject to approval.

## Language

**User**:
A person registered to use the application. A user owns a trading account.
_Avoid_: Account when referring to the person's identity.

**Account**:
A user's paper-money balance and trading activity, measured in a fixed base currency.
_Avoid_: User when referring to funds or trading state.

**Instrument**:
A stock or other quoted asset identified by its market and symbol. A quoted index can be viewed without being eligible for trading.
_Avoid_: Ticker when referring to the asset itself.

**Symbol**:
An instrument's identifier in a market-data source, such as `AAPL` or `RELIANCE.NS`.

**Quote**:
A price observation for an instrument, with its currency, observation time and market session.
_Avoid_: Execution price when referring to a price that has not been used to fill an order.

**Order**:
A user's instruction to buy or sell a quantity of an instrument, immediately or when its conditions are satisfied.
_Avoid_: Transaction when referring to an unfilled instruction.

**Execution**:
The completed fill of an order at a recorded price and exchange rate. In the initial simulation an order has at most one execution, covering its full quantity.
_Avoid_: Order when referring to the completed trade record.

**Cash movement**:
A recorded credit or debit in an account's base currency, including the opening credit and trade settlements.
_Avoid_: Execution when referring to a non-trade credit or debit.

**Position**:
The quantity of an instrument currently owned by an account and its remaining cost basis.
_Avoid_: Portfolio when referring to a single instrument holding.

**Cost basis**:
The acquisition cost allocated to the quantity still owned. A sale removes the proportional average cost of the quantity sold.

**Portfolio**:
An account's cash and positions considered together for valuation and performance reporting.

**Base currency**:
The fixed currency used for an account's cash, settlements and aggregate valuation.

**Quote currency**:
The currency of an instrument's quoted price, expressed in major currency units.
_Avoid_: Display currency when referring to the source price currency.

**Display currency**:
The user's chosen currency for presenting values. Changing it does not change cash, executions or cost basis.

**Valuation snapshot**:
A record of a portfolio's value at an observation time, using identified quote and exchange-rate observations.

**Price alert**:
A user's one-shot request to be notified when an instrument's quote reaches a threshold. An alert does not instruct a trade.
