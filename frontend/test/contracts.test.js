import test from 'node:test'
import assert from 'node:assert/strict'
import * as contracts from '../src/services/contracts.js'
import { displayNumber, rememberInstrument, instrumentForSymbol, currencyForSymbol, adaptPortfolio, adaptOrder, orderIntent } from '../src/services/contracts.js'
test('missing and out of range values remain unavailable instead of turning into zero', () => {
  assert.equal(displayNumber(null), null)
  assert.equal(displayNumber('NaN'), null)
  assert.equal(displayNumber('999999999999999999.99'), null)
  assert.equal(displayNumber('123.45000000'), 123.45)
})
test('price currency follows provider metadata, including pence-normalized London stocks', () => {
  rememberInstrument({id:'canonical',symbol:'VOD.L',currency:'GBP'})
  assert.equal(currencyForSymbol('VOD.L'),'GBP')
  assert.equal(currencyForSymbol('UNKNOWN.NS'),undefined)
})
test('incomplete portfolio preserves known cash and null total', () => {
  const result=adaptPortfolio({account:{cashBalance:'1000000.00'},positions:[],totalValue:null,holdingsValue:null,unrealizedPl:null,quality:'incomplete'})
  assert.equal(result.cash_balance,1000000)
  assert.equal(result.total_value,null)
  assert.equal(result.holdings_value,null)
})
test('order intent preserves submitted decimal strings and excludes browser execution prices', () => {
  assert.deepEqual(orderIntent('canonical',{side:'BUY',type:'MARKET',quantity:'0.1000',price:500}),{instrumentId:'canonical',side:'BUY',type:'MARKET',quantity:'0.1000'})
  assert.deepEqual(orderIntent('canonical',{side:'SELL',type:'STOP_LIMIT',quantity:'1',limitPrice:'10.00000001',stopPrice:'9'}),{instrumentId:'canonical',side:'SELL',type:'STOP_LIMIT',quantity:'1',limitPrice:'10.00000001',stopPrice:'9'})
})
test('owned-resource summaries preserve canonical trading metadata', () => {
  rememberInstrument({id:'cached',symbol:'CACHE',currency:'USD',name:'Cached stock',tradable:true,provider:'fixture'})
  adaptOrder({instrumentId:'cached',symbol:'CACHE',currency:'USD',quantity:'1'})
  assert.equal(instrumentForSymbol('CACHE').tradable,true)
  assert.equal(instrumentForSymbol('CACHE').provider,'fixture')
  assert.equal(instrumentForSymbol('CACHE').name,'Cached stock')
})
test('display conversion expires observations even when refresh fails and keeps source metadata', () => {
  assert.equal(typeof contracts.convertDisplayCurrency,'function')
  const now=Date.parse('2026-11-03T12:00:00Z')
  const usd={currency:'USD',rate:'83',quality:'fresh',provider:'fixture',observedAt:'2026-11-02T12:00:01Z'}
  const rates={USD:usd}
  assert.equal(contracts.convertDisplayCurrency('150','USD','INR',rates,now),12450)
  assert.equal(contracts.convertDisplayCurrency('150','USD','INR',rates,now+2000),null)
  assert.equal(contracts.convertDisplayCurrency('150','USD','USD',rates,now+2000),150)
  assert.equal(contracts.convertDisplayCurrency('150','INR','GBP',rates,now),null)
  assert.equal(contracts.convertDisplayCurrency('150','USD','INR',{USD:{...usd,quality:'stale'}},now),null)
  assert.equal(contracts.convertDisplayCurrency('150','USD','INR',{USD:{...usd,observedAt:'2026-11-03T12:00:06Z'}},now),null)
  assert.equal(rates.USD.provider,'fixture')
  assert.equal(rates.USD.observedAt,usd.observedAt)
})
test('yfinance display conversion uses recently confirmed FX while preserving its older source time',()=>{
  const now=Date.parse('2026-11-03T12:00:00Z');
  const usd={currency:'USD',provider:'yfinance',rate:'94',quality:'fresh',observedAt:'2026-10-30T20:00:00Z',fetchedAt:'2026-11-03T11:59:00Z'};
  assert.equal(contracts.convertDisplayCurrency('10','USD','INR',{USD:usd},now),940);
  assert.equal(contracts.convertDisplayCurrency('10','USD','INR',{USD:{...usd,fetchedAt:undefined}},now),null);
  assert.equal(contracts.convertDisplayCurrency('10','USD','INR',{USD:usd},now+86400000),null);
})
test('yfinance paper quotes can trade with an unknown session but missing or unavailable inputs cannot',()=>{
  assert.equal(typeof contracts.canTradeQuote,'function');
  const quote={provider:'yfinance',tradable:true,price:150,quality:'fresh',session:'UNKNOWN'};
  assert.equal(contracts.canTradeQuote(quote),true);
  assert.equal(contracts.canTradeQuote({...quote,provider:'yahoo'}),false);
  assert.equal(contracts.canTradeQuote({...quote,price:null}),false);
  assert.equal(contracts.canTradeQuote({...quote,tradable:false}),false);
  assert.equal(contracts.canTradeQuote({...quote,quality:'stale'}),false);
})
