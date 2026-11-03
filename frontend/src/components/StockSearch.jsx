/**
 * StockSearch — filter the shared instrument catalogue locally, then use a
 * debounced remote search for symbols without local matches. Quotes load only
 * on the detail page.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Loader2 } from 'lucide-react'
import { stocksAPI } from '../services/api'
import { useRegion } from '../context/RegionContext'
import useTickerCatalogue from '../hooks/useTickerCatalogue'
import { filterTickers } from '../services/tickerCatalogue'

export default function StockSearch() {
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState([])   // {ticker, company_name}[]
  const [loading, setLoading]     = useState(false)
  const [open, setOpen]           = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const { catalogue, retry } = useTickerCatalogue()

  const { regionId }  = useRegion()
  const navigate      = useNavigate()
  const wrapperRef    = useRef(null)
  const inputRef      = useRef(null)
  const apiTimerRef   = useRef(null)   // debounce for API fallback only

  // Clear results when region changes
  useEffect(() => {
    setQuery('')
    setResults([])
    setOpen(false)
  }, [regionId])

  // Instant local filter on every keystroke
  useEffect(() => {
    let cancelled = false
    clearTimeout(apiTimerRef.current)

    const q = query.trim()
    if (!q) {
      setResults([])
      setOpen(false)
      setLoading(false)
      return
    }

    if (catalogue) {
      const local = filterTickers(catalogue, q, regionId, 10)
      if (local.length > 0) {
        setResults(local.map((t) => ({ ticker: t.s, company_name: t.n })))
        setOpen(wrapperRef.current?.contains(document.activeElement) ?? false)
        setActiveIdx(-1)
        setLoading(false)
        return
      }
    }

    // No local match — fall back to API after 350 ms (unknown/exotic tickers)
    if (q.length >= 1) {
      setLoading(true)
      apiTimerRef.current = setTimeout(() => {
        stocksAPI.search(q)
          .then(({ data }) => {
            if (cancelled) return
            setResults(data || [])
            setOpen(true)
            setActiveIdx(-1)
          })
          .catch(() => { if (!cancelled) setResults([]) })
          .finally(() => { if (!cancelled) setLoading(false) })
      }, 350)
    }
    return () => { cancelled = true; clearTimeout(apiTimerRef.current) }
  }, [query, regionId, catalogue])

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const goToStock = useCallback((ticker) => {
    setQuery('')
    setOpen(false)
    setResults([])
    clearTimeout(apiTimerRef.current)
    navigate(`/stocks/${ticker}`)
  }, [navigate])

  const handleKeyDown = (e) => {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0) goToStock(results[activeIdx].ticker)
      else if (results.length === 1) goToStock(results[0].ticker)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const showSpinner = loading && results.length === 0

  return (
    <div className="search-wrapper" ref={wrapperRef}>
      <div className="search-input-wrap">
        {showSpinner
          ? <Loader2 size={16} className="search-icon spin" />
          : <Search size={16} className="search-icon" />
        }
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          aria-label="Search stocks"
          placeholder="Search stocks… (e.g. AAPL, Tesla)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { retry(); if (results.length > 0) setOpen(true) }}
          autoComplete="off"
          spellCheck="false"
        />
      </div>

      {open && results.length > 0 && (
        <ul className="search-dropdown" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.ticker}
              role="option"
              aria-selected={i === activeIdx}
              className={`search-item${i === activeIdx ? ' active' : ''}`}
              onMouseDown={() => goToStock(r.ticker)}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <div className="search-item-left">
                <span className="search-ticker">{r.ticker}</span>
                <span className="search-name">{r.company_name}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && !loading && results.length === 0 && query.length > 1 && (
        <div className="search-empty">No results for "{query}"</div>
      )}
    </div>
  )
}
