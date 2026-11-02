import test from 'node:test'
import assert from 'node:assert/strict'
import { displayNumber, rememberInstrument, currencyForSymbol, adaptPortfolio, orderIntent } from '../src/services/contracts.js'
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
