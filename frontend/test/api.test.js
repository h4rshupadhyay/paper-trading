import test from 'node:test'
import assert from 'node:assert/strict'
import api, { stocksAPI, portfolioAPI } from '../src/services/api.js'
import { rememberInstrument } from '../src/services/contracts.js'

test('a summary-only instrument loads canonical metadata before showing a quote', async () => {
  rememberInstrument({id:'partial',symbol:'PARTIAL',currency:'USD'})
  const original=api.defaults.adapter
  const requests=[]
  api.defaults.adapter=async config=>{
    requests.push(config.url)
    const data=config.url.endsWith('/quote')
      ? {quote:{price:'150',observedAt:new Date().toISOString()},quality:'fresh'}
      : {instrument:{id:'partial',symbol:'PARTIAL',currency:'USD',tradable:true,provider:'fixture',name:'Partial stock'}}
    return {config,status:200,statusText:'OK',headers:{},data}
  }
  try {
    const {data}=await stocksAPI.quote('PARTIAL')
    assert.equal(data.tradable,true)
    assert.equal(data.provider,'fixture')
    assert.ok(requests.includes('/instruments/partial'))
  } finally {api.defaults.adapter=original}
})

test('snapshot ranges include every cursor page in chronological order', async () => {
  const original=api.defaults.adapter
  const requests=[]
  api.defaults.adapter=async config=>{
    requests.push(config.params)
    return {config,status:200,statusText:'OK',headers:{},data:config.params.cursor
      ? {items:[{id:'old',sampledAt:'2026-11-01T00:00:00Z',totalValue:'1000000.00'}],nextCursor:null}
      : {items:[{id:'new',sampledAt:'2026-11-02T00:00:00Z',totalValue:'1000010.00'}],nextCursor:'new'}}
  }
  try {
    const {data}=await portfolioAPI.snapshots(730)
    assert.deepEqual(data.snapshots.map(item=>item.id),['old','new'])
    assert.equal(requests.length,2)
    assert.ok(requests.every(params=>params.days===730))
  } finally {api.defaults.adapter=original}
})
