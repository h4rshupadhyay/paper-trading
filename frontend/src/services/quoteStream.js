import { displayNumber } from './contracts.js'

const time = value => Date.parse(value) || 0
const stamp = value => time(value?.quote?.observedAt ?? value?.observedAt)
const fetched = value => time(value?.quote?.fetchedAt ?? value?.fetchedAt)
// Preserve source/provider timestamps: a browser receipt is never a new observation.
export function mergeQuote(current, incoming) {
  if (!incoming) return current
  const fields = incoming.quote ? { ...incoming.quote, quality: incoming.quality, unavailableReason: incoming.unavailableReason } : {...incoming}
  if (current && (stamp(current) > stamp(incoming) || (stamp(current) === stamp(incoming) && fetched(current) > fetched(incoming)))) {
    const { price, currency, observedAt, fetchedAt, quality, unavailableReason, session, provider, rawPrice, rawCurrency, actionKey, ...metadata } = fields
    return { ...current, ...metadata, ...(fields.unavailableReason ? {quality:'unavailable',unavailableReason:fields.unavailableReason} : {}) }
  }
  if(current?.quality==='stale'&&fields.quality==='fresh'&&stamp(current)===stamp(incoming)&&fetched(current)===fetched(incoming))fields.quality='stale'
  return { ...current, ...fields, price: displayNumber(fields.price) }
}
export function mergeWatchlistQuotes(items, packets) {
  return items.map(item => {
    const packet = packets.get(item.instrumentId ?? item.id)
    return packet ? mergeQuote(item, packet) : item
  })
}
export function coalesceRefresh(run, env = globalThis) {
  let timer, running = false, dirty = false, stopped = false
  const schedule = () => {
    if (stopped || running || timer != null || !dirty) return
    timer = env.setTimeout(async () => {
      timer = undefined; running = true; dirty = false
      try { await run() } catch (_) { /* Resource owners present failures. */ }
      finally { running = false; schedule() }
    }, 1000)
  }
  const request = () => { dirty = true; schedule() }
  request.cancel = () => { stopped = true; dirty = false; env.clearTimeout(timer); timer = undefined }
  return request
}

export function createQuoteStream(env) {
  const consumers = new Set(), cache = new Map()
  let source, timer, expiry, removers = [], key, retries = 0, stopped = false
  const emit = event => { for (const consumer of consumers) if (event.type !== 'quote' || consumer.ids.includes(event.packet.instrumentId)) consumer.notify(event) }
  const close = () => { source?.close(); source = undefined; key = undefined }
  const clear = () => { env.clearTimeout(timer); timer = undefined }
  const expire = () => {
    let next = Infinity
    for (const [id, entry] of cache) {
      if (!entry.expired && env.now() - entry.receivedAt >= 60000) {
        entry.expired = true
        entry.packet = { ...entry.packet, quality: 'stale', quote: { ...entry.packet.quote, quality: 'stale' } }
        emit({ type: 'quote', packet: entry.packet, live: false })
      }
      if (!entry.expired) next = Math.min(next, entry.receivedAt + 60000 - env.now())
      if (!consumers.size) cache.delete(id)
    }
    env.clearTimeout(expiry)
    if (next !== Infinity) expiry = env.setTimeout(expire, Math.max(1, next))
  }
  const connect = () => {
    timer = undefined
    if (!consumers.size || stopped || !env.visible()) return
    const ids = [...new Set([...consumers].flatMap(item => item.ids))].slice(0, 100).sort()
    for(const id of cache.keys())if(!ids.includes(id))cache.delete(id)
    const nextKey = ids.join(',')
    if (source && nextKey === key) return
    close(); key = nextKey
    const active = env.connect(`/api/market/stream?ids=${encodeURIComponent(nextKey)}`)
    source = active
    active.addEventListener('open', () => { if (source === active) retries = 0 })
    active.addEventListener('quote', event => {
      if (source !== active) return
      let packet
      try { packet = JSON.parse(event.data) } catch (_) { return }
      if(!packet||typeof packet!=='object'||Array.isArray(packet))return
      if (!ids.includes(packet.instrumentId) || !stamp(packet) || !fetched(packet) || displayNumber(packet.quote?.price) <= 0 || displayNumber(packet.quote?.price) == null) return
      const previous = cache.get(packet.instrumentId)
      if(stamp(packet)>env.now()+5000||fetched(packet)>env.now()+5000)return
      if (previous && (stamp(packet)<stamp(previous.packet)
        ||(stamp(packet)===stamp(previous.packet)&&fetched(packet)<=fetched(previous.packet))) && packet.quality!=='unavailable') return
      const receivedAt=Math.min(env.now(),fetched(packet)),expired=env.now()-receivedAt>=60000
      if(expired&&packet.quality==='fresh')packet={...packet,quality:'stale',quote:{...packet.quote,quality:'stale'}}
      cache.set(packet.instrumentId, { packet, receivedAt, expired })
      emit({ type: 'quote', packet, live: packet.quality === 'fresh' }); expire()
    })
    active.addEventListener('activity', () => { if (source === active) emit({ type: 'activity' }) })
    active.onerror = () => {
      if (source !== active) return
      close(); emit({ type: 'offline' }); clear()
      if (consumers.size && env.visible() && !stopped) timer = env.setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)))
    }
  }
  const schedule = () => { clear(); if (!consumers.size || stopped || !env.visible()) { close(); return } timer = env.setTimeout(connect, 100) }
  const visibility = () => { close(); emit({ type: 'offline' }); schedule() }
  const logout = () => { stopped = true; clear(); close(); env.clearTimeout(expiry); cache.clear(); emit({ type: 'offline' }) }
  return {
    subscribe(ids, notify) {
      if (!consumers.size) {
        stopped = false
        removers = [env.listen('visibilitychange', visibility), env.listen('paper:unauthenticated', logout), env.listen('paper:authenticated', () => { stopped = false; schedule() })]
      }
      const consumer = { ids: [...new Set(ids.filter(Boolean))].slice(0, 100), notify }
      consumers.add(consumer)
      for (const id of consumer.ids) if (cache.has(id)) notify({ type: 'quote', packet: cache.get(id).packet, live: !cache.get(id).expired && cache.get(id).packet.quality === 'fresh' })
      schedule()
      return () => {
        consumers.delete(consumer)
        if (!consumers.size) { clear(); close(); env.clearTimeout(expiry); cache.clear(); removers.forEach(remove => remove()); removers = [] }
        else schedule()
      }
    },
  }
}

let shared
export function browserQuoteStream() {
  shared ??= createQuoteStream({ now: Date.now, setTimeout: (...args) => window.setTimeout(...args), clearTimeout: id => window.clearTimeout(id),
    visible: () => document.visibilityState === 'visible',
    connect: url => new EventSource(url, { withCredentials: true }),
    listen: (name, fn) => { const target = name === 'visibilitychange' ? document : window; target.addEventListener(name, fn); return () => target.removeEventListener(name, fn) },
  })
  return shared
}
