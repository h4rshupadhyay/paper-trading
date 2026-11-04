import test from 'node:test'
import assert from 'node:assert/strict'
import api,{portfolioAPI} from '../src/services/api.js'

test('portfolio history requests the selected range once and preserves actual boundary values',async()=>{
 const previous=api.defaults.adapter
 const requests=[]
 api.defaults.adapter=async config=>{requests.push(config);return {config,status:200,statusText:'OK',headers:{},data:{period:'5y',interval:'1mo',firstValue:'100.00',lastValue:'140.00',items:[{id:'a',sampledAt:'2021-11-04T00:00:00Z',totalValue:'110.00',cashBalance:'20.00',holdingsValue:'90.00'}]}}}
 try{
  const {data}=await portfolioAPI.history('5y')
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/portfolio/history');assert.equal(requests[0].params.period,'5y')
  assert.equal(data.firstValue,100);assert.equal(data.lastValue,140)
  assert.equal(data.snapshots[0].time,Date.parse('2021-11-04T00:00:00Z'))
  assert.equal(data.snapshots[0].total_value,110)
 }finally{api.defaults.adapter=previous}
})

test('portfolio date labels distinguish years and retain the full observation date in tooltips',async()=>{
 const {portfolioTick,portfolioTooltipDate,adaptPortfolioHistory}=await import('../src/services/portfolioHistory.js')
 const timestamp=Date.parse('2024-02-29T12:30:00Z')
 assert.match(portfolioTick(timestamp,'5y'),/2024/)
 assert.match(portfolioTick(timestamp,'1y'),/2024/)
 assert.match(portfolioTooltipDate(timestamp),/2024/)
 assert.match(portfolioTooltipDate(timestamp),/29/)
 assert.deepEqual(adaptPortfolioHistory({items:[],firstValue:null,lastValue:null}).snapshots,[])
 assert.equal(adaptPortfolioHistory({items:[],firstValue:null,lastValue:null}).firstValue,null)
})
