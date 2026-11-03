import test from 'node:test'
import assert from 'node:assert/strict'
import api, { stocksAPI, portfolioAPI, alertsAPI, resetCsrf } from '../src/services/api.js'
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

for (const count of [0, 1, 100, 101, 205]) {
  test(`mark read handles ${count} notifications within the API batch limit`, async () => {
    const original=api.defaults.adapter
    const ids=Array.from({length:count},(_,i)=>`notification-${i}`)
    const sent=[]
    resetCsrf()
    api.defaults.adapter=async config=>{
      let data
      if(config.url==='/auth/csrf') data={csrfToken:'test-csrf'}
      else {
        assert.equal(config.url,'/notifications/read')
        assert.equal(config.headers['X-CSRF-Token'],'test-csrf')
        const batch=JSON.parse(config.data).ids
        assert.ok(batch.length>0 && batch.length<=100,'server accepts only 1–100 IDs')
        sent.push(...batch)
        data={items:batch.map(id=>({id,readAt:'2026-11-03T12:00:00Z'}))}
      }
      return {config,status:200,statusText:'OK',headers:{},data}
    }
    try {
      const response=await alertsAPI.markRead(ids)
      assert.deepEqual(sent,ids)
      assert.deepEqual(response.data.items,ids.map(id=>({id,readAt:'2026-11-03T12:00:00Z'})))
    } finally {api.defaults.adapter=original;resetCsrf()}
  })
}

test('mark read rejects a failed batch and leaves later notifications for retry', async () => {
  const original=api.defaults.adapter
  const ids=Array.from({length:205},(_,i)=>`notification-${i}`)
  const completed=[]
  const failure=new Error('read service unavailable')
  let attempts=0
  resetCsrf()
  api.defaults.adapter=async config=>{
    let data
    if(config.url==='/auth/csrf') data={csrfToken:'test-csrf'}
    else {
      const batch=JSON.parse(config.data).ids
      assert.ok(batch.length<=100,'server accepts at most 100 IDs')
      if(++attempts===2) throw failure
      completed.push(...batch)
      data={items:batch.map(id=>({id,readAt:'2026-11-03T12:00:00Z'}))}
    }
    return {config,status:200,statusText:'OK',headers:{},data}
  }
  try {
    await assert.rejects(alertsAPI.markRead(ids),error=>error===failure)
    assert.equal(attempts,2)
    assert.deepEqual(completed,ids.slice(0,100))
  } finally {api.defaults.adapter=original;resetCsrf()}
})
