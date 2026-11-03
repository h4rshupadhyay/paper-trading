import axios from 'axios'
import { rememberInstrument, instrumentForSymbol, displayNumber, orderIntent, adaptPortfolio, adaptOrder } from './contracts.js'

const api=axios.create({baseURL:'/api',withCredentials:true,headers:{'Content-Type':'application/json'}})
let csrfPromise
export const resetCsrf=()=>{csrfPromise=undefined}
api.interceptors.request.use(async config=>{
  if (!['get','head','options'].includes(config.method??'get') && !['/auth/register','/auth/login'].includes(config.url)) {
    csrfPromise??=api.get('/auth/csrf').then(({data})=>data.csrfToken).catch(error=>{resetCsrf();throw error})
    config.headers['X-CSRF-Token']=await csrfPromise
  }
  return config
})
api.interceptors.response.use(response=>response,error=>{
  if(error.response?.data?.error?.message){
    error.response.data.code=error.response.data.error.code
    error.response.data.error=error.response.data.error.message
  }
  if(error.response?.status===401){resetCsrf();window.dispatchEvent(new Event('paper:unauthenticated'))}
  return Promise.reject(error)
})
const mapped=(promise,convert)=>promise.then(response=>({...response,data:convert(response.data)}))
async function instrument(symbol) {
  let item=instrumentForSymbol(symbol)
  if(!item?.id){
    const {data}=await api.get('/instruments',{params:{q:symbol}})
    data.items.forEach(rememberInstrument)
    item=data.items.find(value=>value.symbol.toUpperCase()===symbol.toUpperCase())
  }
  if(!item) throw new Error('Instrument unavailable')
  if(typeof item.tradable!=='boolean' || !item.provider || !item.name){
    const {data}=await api.get(`/instruments/${item.id}`)
    item=rememberInstrument(data.instrument)
  }
  return item
}
async function all(path,params={},maxItems=10000) {
  const items=[];let cursor
  do {
    const {data}=await api.get(path,{params:{...params,limit:100,...(cursor?{cursor}:{})}})
    items.push(...data.items);cursor=data.nextCursor
  } while(cursor && items.length<maxItems)
  return items
}
function stock(item){rememberInstrument(item);return {...item,ticker:item.symbol,company_name:item.name}}
function note(item){return {...item,note_id:item.id,ticker:item.symbol??'',created_at:item.createdAt,updated_at:item.updatedAt}}
function entry(item,defaultId){rememberInstrument({id:item.instrumentId,symbol:item.symbol,currency:item.currency});return {...item,
  watchlist_id:item.id,folder_id:item.folderId===defaultId?null:item.folderId,ticker:item.symbol,company_name:item.name,price:displayNumber(item.price),change_pct:null}}
function alert(item){rememberInstrument({id:item.instrumentId,symbol:item.symbol,currency:item.currency});return {...item,
  alert_id:item.id,ticker:item.symbol,target_price:displayNumber(item.targetPrice),is_active:item.active,created_at:item.createdAt,triggered_at:item.triggeredAt}}
function notification(item){return {...item,notification_id:item.id,notif_id:item.id,is_read:!!item.readAt,created_at:item.createdAt}}
export const authAPI={
  register:(username,email,password)=>api.post('/auth/register',{username,email,password}),
  login:async(username,password)=>{const response=await api.post('/auth/login',{username,password});resetCsrf();return response},
  me:()=>api.get('/auth/me'),logout:async()=>{await api.post('/auth/logout');resetCsrf()},account:()=>api.get('/account'),
}
export const stocksAPI={
  search:q=>mapped(api.get('/instruments',{params:{q}}),data=>data.items.map(stock)),
  catalogue:()=>mapped(api.get('/instruments'),data=>data.items.map(item=>{stock(item);return{s:item.symbol,n:item.name,r:({NMS:'US',NYQ:'US',NSI:'IN',BSE:'IN',LSE:'UK',GER:'EU',JPX:'JP',HKG:'HK'})[item.exchange]}})),
  quote:async symbol=>{
    const item=await instrument(symbol)
    const {data}=await api.get(`/instruments/${item.id}/quote`)
    return {data:{...stock(item),...data.quote,price:displayNumber(data.quote?.price),change_pct:null,
      quality:data.quality,unavailableReason:data.unavailableReason,tradable:item.tradable,
      observedAt:data.quote?.observedAt,provider:item.provider}}
  },
  history:async(symbol,period='1mo',interval='1d')=>{
    const item=await instrument(symbol)
    return mapped(api.get(`/instruments/${item.id}/history`,{params:{period,interval}}),data=>({
      ...data,data:data.items.map(value=>({date:value.observedAt,time:value.observedAt,open:displayNumber(value.open),high:displayNumber(value.high),low:displayNumber(value.low),close:displayNumber(value.close),volume:displayNumber(value.volume)}))}))
  },
  indexQuote:symbol=>stocksAPI.quote(symbol),
}
export const currencyAPI={rates:()=>api.get('/fx-rates')}
export async function placeOrder(symbol,input,key) {
  const item=await instrument(symbol)
  const response=await api.post('/orders',orderIntent(item.id,input),{headers:{'Idempotency-Key':key}})
  if(response.data.order.status==='REJECTED') throw new Error(response.data.order.rejectionReason||'Order rejected')
  return response
}
const orderCursors=new Map([[1,undefined]])
export const tradingAPI={
  buy:(symbol,quantity,key)=>placeOrder(symbol,{side:'BUY',type:'MARKET',quantity},key),
  sell:(symbol,quantity,key)=>placeOrder(symbol,{side:'SELL',type:'MARKET',quantity},key),
  orders:async(page=1,limit=20)=>{
    if(page===1){orderCursors.clear();orderCursors.set(1,undefined)}
    const {data}=await api.get('/orders',{params:{limit,...(orderCursors.get(page)?{cursor:orderCursors.get(page)}:{})}})
    if(data.nextCursor)orderCursors.set(page+1,data.nextCursor)
    return {data:{orders:data.items.map(adaptOrder),total:(page-1)*limit+data.items.length,pages:data.nextCursor?page+1:page}}
  },
}
export const portfolioAPI={get:()=>mapped(api.get('/portfolio'),adaptPortfolio),
  snapshots:async days=>({data:{snapshots:(await all('/portfolio/snapshots',{days},Infinity)).reverse().map(item=>({
    ...item,snapshot_at:item.sampledAt,timestamp:item.sampledAt,date:item.sampledAt,total_value:displayNumber(item.totalValue),cash_balance:displayNumber(item.cashValue??item.cashBalance),holdings_value:displayNumber(item.holdingsValue)}))}})}
export const watchlistAPI={
  get:()=>mapped(api.get('/watchlists'),data=>{const defaultId=data.folders.find(f=>f.isDefault)?.id;return{
    folders:data.folders.filter(f=>!f.isDefault).map(f=>({...f,folder_id:f.id})),watchlist:data.items.map(item=>entry(item,defaultId))}}),
  add:async(symbol,folderId)=>api.post('/watchlists/entries',{instrumentId:(await instrument(symbol)).id,...(folderId?{folderId}:{})}),
  remove:async symbol=>{const {data}=await watchlistAPI.get();await Promise.all(data.watchlist.filter(item=>item.ticker===symbol).map(item=>watchlistAPI.removeItem(item.watchlist_id)))},
  removeItem:id=>api.delete(`/watchlists/entries/${id}`),
  createFolder:name=>mapped(api.post('/watchlists/folders',{name}),data=>({...data.folder,folder_id:data.folder.id})),
  renameFolder:(id,name)=>api.patch(`/watchlists/folders/${id}`,{name}),deleteFolder:id=>api.delete(`/watchlists/folders/${id}`),
  moveItem:async(id,folderId)=>{
    if(!folderId){const {data}=await api.get('/watchlists/folders');folderId=data.items.find(f=>f.isDefault).id}
    return api.patch(`/watchlists/entries/${id}`,{folderId})
  },
}
export const pendingOrdersAPI={
  list:async status=>({data:(await all('/orders',{status})).filter(item=>item.type!=='MARKET').map(adaptOrder)}),
  place:input=>placeOrder(input.ticker,{side:input.side,type:input.order_type,quantity:input.quantity,
    limitPrice:input.limit_price,stopPrice:input.stop_price,expiresAt:input.expires_at},input.idempotencyKey),
  cancel:id=>api.post(`/orders/${id}/cancel`),
}
export const notesAPI={
  list:async()=>({data:(await all('/notes')).map(note)}),get:id=>mapped(api.get(`/notes/${id}`),data=>note(data.note)),
  create:async(title,body,symbol)=>mapped(api.post('/notes',{title,body,...(symbol?{instrumentId:(await instrument(symbol)).id}:{})}),data=>note(data.note)),
  update:(id,title,body)=>mapped(api.patch(`/notes/${id}`,{title,body}),data=>note(data.note)),delete:id=>api.delete(`/notes/${id}`),
}
export const alertsAPI={
  list:async()=>({data:(await all('/alerts')).map(alert)}),
  create:async(symbol,condition,targetPrice)=>mapped(api.post('/alerts',{instrumentId:(await instrument(symbol)).id,condition,targetPrice:String(targetPrice)}),data=>alert(data.alert)),
  delete:id=>api.delete(`/alerts/${id}`),
  notifications:async unread=>({data:(await all('/notifications',unread?{unread:'true'}:{})).map(notification)}),
  markRead:ids=>api.post('/notifications/read',{ids}),
}
export default api
