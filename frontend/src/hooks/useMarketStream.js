import { useEffect, useRef, useState } from 'react'
import { browserQuoteStream, coalesceRefresh } from '../services/quoteStream.js'
import { resolveInstrument } from '../services/api.js'

export function useMarketStream(ids, onEvent) {
  const latest = useRef(onEvent)
  latest.current = onEvent
  const key = [...new Set(ids.filter(Boolean))].sort().join(',')
  useEffect(() => browserQuoteStream().subscribe(key ? key.split(',') : [], event => latest.current?.(event)), [key])
}

export function useSymbolQuote(symbol, onQuote) {
  const [id, setId] = useState(null)
  const [live, setLive] = useState(false)
  useEffect(() => {
    let cancelled = false
    setId(null); setLive(false)
    resolveInstrument(symbol).then(item => { if (!cancelled) setId(item.id) }).catch(() => {})
    return () => { cancelled = true }
  }, [symbol])
  useMarketStream(id ? [id] : [], event => {
    if (event.type === 'offline') setLive(false)
    if (event.type === 'quote' && event.packet.instrumentId === id) { setLive(event.live); onQuote(event.packet) }
  })
  return live
}

export function useActivityRefresh(refresh, ids = [], quotes = false) {
  const latest = useRef(refresh)
  latest.current = refresh
  const queued = useRef(null)
  const values = useRef(new Map())
  useEffect(() => {
    queued.current = coalesceRefresh(() => latest.current())
    return () => { queued.current.cancel(); queued.current = null }
  }, [])
  useMarketStream(ids, event => {
    if(event.type==='activity')queued.current?.()
    if(quotes&&event.type==='quote'){
      const signature=JSON.stringify([event.packet.quote?.price,event.packet.quote?.currency,event.packet.quality])
      if(values.current.get(event.packet.instrumentId)!==signature){values.current.set(event.packet.instrumentId,signature);queued.current?.()}
    }
  })
}
