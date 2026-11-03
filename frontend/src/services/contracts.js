// Numeric conversion is confined to presentation; all submitted decimals stay strings.
const instruments = new Map()
export function rememberInstrument(instrument) {
  if (instrument?.symbol) {
    const key=instrument.symbol.toUpperCase()
    const previous=instruments.get(key)
    instruments.set(key,{...(previous?.id===instrument.id?previous:{}),...instrument})
  }
  return instrument
}
export const instrumentForSymbol = symbol => instruments.get(symbol?.toUpperCase())
export const currencyForSymbol = symbol => instrumentForSymbol(symbol)?.currency
export function displayNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && Math.abs(number) <= 1e15 ? number : null
}
export function convertDisplayCurrency(value,source,target,observations,now=Date.now()) {
  const number=displayNumber(value)
  if(number==null || !source || !target)return null
  if(source===target)return number
  const rate=currency=>{
    if(currency==='INR')return 1
    const item=observations[currency],observedAt=Date.parse(item?.observedAt)
    const value=displayNumber(item?.rate)
    return item?.quality==='fresh' && Number.isFinite(observedAt)
      && now-observedAt<=86400000 && observedAt-now<=5000 && value>0 ? value : null
  }
  const from=rate(source),to=rate(target)
  return from && to ? displayNumber(number*from/to) : null
}
export function orderIntent(instrumentId, input) {
  const intent = { instrumentId, side: input.side, type: input.type, quantity: String(input.quantity) }
  if (['LIMIT','STOP_LIMIT'].includes(input.type)) intent.limitPrice=String(input.limitPrice)
  if (['STOP','STOP_LIMIT'].includes(input.type)) intent.stopPrice=String(input.stopPrice)
  if (input.expiresAt) intent.expiresAt=input.expiresAt
  return intent
}
export function adaptPortfolio(data) {
  const holdings = data.positions.map(position => {
    rememberInstrument({id:position.instrumentId,symbol:position.symbol,currency:position.currency,name:position.name})
    const quantity=displayNumber(position.quantity), native=displayNumber(position.nativeCost), base=displayNumber(position.baseCost)
    const pl=displayNumber(position.unrealizedPl)
    return {...position, ticker:position.symbol, stock_id:position.instrumentId, company_name:position.name,
      quantity, avg_buy_price:quantity && native!=null ? native/quantity : null,
      current_price:displayNumber(position.price), market_value:displayNumber(position.value),
      total_invested:base,pl,pl_pct:base && pl!=null ? pl/base*100 : null,sector:'Unclassified'}
  })
  const invested=holdings.reduce((sum,h)=>sum+(h.total_invested??0),0)
  const pl=displayNumber(data.unrealizedPl)
  return {...data,holdings,cash_balance:displayNumber(data.account.cashBalance),total_value:displayNumber(data.totalValue),
    holdings_value:displayNumber(data.holdingsValue),total_pl:pl,total_invested:invested,
    total_pl_pct:pl!=null && invested ? pl/invested*100 : null}
}
export function adaptOrder(order) {
  rememberInstrument({id:order.instrumentId,symbol:order.symbol,currency:order.currency})
  return {...order,order_id:order.id,transaction_id:order.id,ticker:order.symbol,company_name:order.symbol,
    type:order.side,side:order.side,order_type:order.type,quantity:displayNumber(order.quantity),
    limit_price:displayNumber(order.limitPrice),stop_price:displayNumber(order.stopPrice),
    filled_price:displayNumber(order.executionPrice??order.price),price:displayNumber(order.executionPrice??order.price),
    total_amount:displayNumber(order.baseSettlement),created_at:order.createdAt,time:order.completedAt??order.createdAt,executed_at:order.executedAt,
    expires_at:order.expiresAt,filled_at:order.completedAt,rejection_reason:order.rejectionReason}
}
