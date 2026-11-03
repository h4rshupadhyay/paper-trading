/**
 * StockSearch — instant client-side search from a pre-loaded ticker list.
 *
 * Architecture:
 *  • On first mount, fetches /api/stocks/tickers (tickers.json, ~30 KB, cached 24 h).
 *  • All subsequent filtering is pure JS — zero API calls on every keystroke.
 *  • If the query matches nothing locally AND looks like a valid ticker symbol,
 *    falls back to the backend search API (covers newly-added / exotic tickers).
 *  • Price data is never fetched in the dropdown — the full quote loads on the
 *    detail page only.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Loader2 } from 'lucide-react'
import { stocksAPI } from '../services/api'
import { useRegion } from '../context/RegionContext'

// Module-level cache — shared across all component instances, persists for the
// lifetime of the browser tab.  Avoids re-fetching on route changes.
let _tickerCache = null           // resolved array once loaded
let _loadPromise  = null           // in-flight promise (prevents duplicate fetches)

async function loadTickers() {
  if (_tickerCache) return _tickerCache
  if (_loadPromise)  return _loadPromise

  _loadPromise = stocksAPI.catalogue()
    .then(({data}) => data)
    .then((data) => {
      _tickerCache = Array.isArray(data) ? data : []
      return _tickerCache
    })
    .catch(() => {
      _tickerCache = []
      return []
    })

  return _loadPromise
}

/** Filter tickers.json entries against a query string, within the given region. */
function filterLocal(tickers, q, regionId) {
  const upper = q.toUpperCase()
  const lower = q.toLowerCase()

  const exact    = []
  const prefix   = []
  const contains = []

  for (const t of tickers) {
    // Region gate: only show tickers tagged for this region (field `r`)
    if (t.r && t.r !== regionId) continue

    const sym  = t.s.toUpperCase()
    const name = t.n.toLowerCase()

    if (sym === upper) {
      exact.push(t)
    } else if (sym.startsWith(upper) || name.startsWith(lower)) {
      prefix.push(t)
    } else if (sym.includes(upper) || name.includes(lower)) {
      contains.push(t)
    }

    if (exact.length + prefix.length + contains.length >= 10) break
  }

  return [...exact, ...prefix, ...contains].slice(0, 10)
}

export default function StockSearch() {
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState([])   // {ticker, company_name}[]
  const [loading, setLoading]     = useState(false)
  const [open, setOpen]           = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [ready, setReady]         = useState(!!_tickerCache)

  const { regionId }  = useRegion()
  const navigate      = useNavigate()
  const wrapperRef    = useRef(null)
  const inputRef      = useRef(null)
  const apiTimerRef   = useRef(null)   // debounce for API fallback only

  // Pre-load the ticker list immediately on mount
  useEffect(() => {
    if (_tickerCache) return   // already loaded
    loadTickers().then(() => setReady(true))
  }, [])

  // Clear results when region changes
  useEffect(() => {
    setQuery('')
    setResults([])
    setOpen(false)
  }, [regionId])

  // Instant local filter on every keystroke
  useEffect(() => {
    clearTimeout(apiTimerRef.current)

    const q = query.trim()
    if (!q) {
      setResults([])
      setOpen(false)
      return
    }

    if (_tickerCache) {
      const local = filterLocal(_tickerCache, q, regionId)
      if (local.length > 0) {
        setResults(local.map((t) => ({ ticker: t.s, company_name: t.n })))
        setOpen(true)
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
            setResults(data || [])
            setOpen(true)
            setActiveIdx(-1)
          })
          .catch(() => setResults([]))
          .finally(() => setLoading(false))
      }, 350)
    }
  }, [query])

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
          placeholder={ready ? 'Search stocks… (e.g. AAPL, Tesla)' : 'Loading tickers…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
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
