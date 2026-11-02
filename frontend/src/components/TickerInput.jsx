import { stocksAPI } from '../services/api'
/**
 * TickerInput — controlled text input with live ticker autocomplete.
 *
 * Uses the same pre-loaded tickers.json cache as StockSearch.
 * Unlike StockSearch, this is a plain form input — it doesn't navigate.
 *
 * Props
 *   value       string           controlled value
 *   onChange    (val) => void    called on every keystroke (upper-cased)
 *   onSelect    (ticker) => void called when user picks a suggestion
 *   placeholder string
 *   disabled    bool
 *   className   string
 */
import { useState, useRef, useEffect } from 'react'
import { useRegion } from '../context/RegionContext'

// Re-use the same module-level cache as StockSearch (defined outside the module
// to survive re-renders and route changes).
let _tickerCache = null
let _loadPromise  = null

async function loadTickers() {
  if (_tickerCache) return _tickerCache
  if (_loadPromise)  return _loadPromise
  _loadPromise = stocksAPI.catalogue()
    .then(({data}) => data)
    .then((data) => { _tickerCache = Array.isArray(data) ? data : []; return _tickerCache })
    .catch(() => { _tickerCache = []; return [] })
  return _loadPromise
}

function filterLocal(tickers, q, regionId) {
  const upper = q.toUpperCase()
  const lower = q.toLowerCase()
  const exact = [], prefix = [], contains = []

  for (const t of tickers) {
    if (t.r && t.r !== regionId) continue
    const sym  = t.s.toUpperCase()
    const name = t.n.toLowerCase()
    if (sym === upper)                                      exact.push(t)
    else if (sym.startsWith(upper) || name.startsWith(lower)) prefix.push(t)
    else if (sym.includes(upper)   || name.includes(lower))   contains.push(t)
    if (exact.length + prefix.length + contains.length >= 8) break
  }
  return [...exact, ...prefix, ...contains].slice(0, 8)
}

export default function TickerInput({
  value,
  onChange,
  onSelect,
  placeholder = 'Ticker (e.g. RELIANCE.NS)',
  disabled = false,
  className = '',
}) {
  const [results, setResults]     = useState([])
  const [open, setOpen]           = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const wrapperRef = useRef(null)
  const { regionId } = useRegion()

  // Pre-load on mount
  useEffect(() => {
    if (!_tickerCache) loadTickers()
  }, [])

  // Filter on every value change
  useEffect(() => {
    const q = value.trim()
    if (!q) { setResults([]); setOpen(false); return }
    if (_tickerCache) {
      const local = filterLocal(_tickerCache, q, regionId)
      if (local.length) {
        setResults(local.map((t) => ({ ticker: t.s, company_name: t.n })))
        setOpen(true)
        setActiveIdx(-1)
        return
      }
    }
    setResults([])
    setOpen(false)
  }, [value, regionId])

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const pick = (ticker) => {
    onSelect?.(ticker)
    onChange(ticker)
    setOpen(false)
    setResults([])
  }

  const handleKeyDown = (e) => {
    if (!open || !results.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIdx >= 0) pick(results[activeIdx].ticker)
      else if (results.length === 1) pick(results[0].ticker)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className={`ticker-input-wrap ${className}`} ref={wrapperRef}>
      <input
        type="text"
        className="form-input"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck="false"
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && results.length > 0 && (
        <ul className="ticker-dropdown" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.ticker}
              role="option"
              aria-selected={i === activeIdx}
              className={`ticker-dropdown-item${i === activeIdx ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(r.ticker) }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="ticker-dd-symbol">{r.ticker}</span>
              <span className="ticker-dd-name">{r.company_name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
