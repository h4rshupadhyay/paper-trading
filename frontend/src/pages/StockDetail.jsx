import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  TrendingUp, TrendingDown, Star, StarOff,
  ShoppingCart, RefreshCw, ChevronLeft, ChevronDown,
} from 'lucide-react'
import Header from '../components/Header'
import ResourceError from '../components/ResourceError'
import PriceChart from '../components/PriceChart'
import OrderForm from '../components/OrderForm'
import { Skeleton } from '../components/LoadingSkeleton'
import { stocksAPI, watchlistAPI } from '../services/api'
import { canTradeQuote } from '../services/contracts'
import { useRegion, tickerCurrency } from '../context/RegionContext'

function StatItem({ label, value }) {
  return (
    <div className="stat-item">
      <span className="stat-item-label">{label}</span>
      <span className="stat-item-value">{value ?? '—'}</span>
    </div>
  )
}

export default function StockDetail() {
  const { ticker } = useParams()
  return <InstrumentDetail key={ticker} ticker={ticker} />
}

function InstrumentDetail({ ticker }) {
  const navigate    = useNavigate()
  const { formatPrice, region } = useRegion()

  // Currency of this specific stock's prices — fixed, based on ticker suffix
  const priceCurr = tickerCurrency(ticker)

  // Format any price from this stock (converts from priceCurr → region.currency)
  const fp = (n) => formatPrice(n, { from: priceCurr })

  // Large number formatter (market cap, volume) — also converts
  const fmtNum = (n) => {
    if (n == null) return '—'
    const converted = formatPrice(n, { from: priceCurr, compact: true })
    return converted
  }

  const [quote, setQuote]         = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [showOrder, setShowOrder] = useState(false)
  const [watchlistError, setWatchlistError] = useState(null)
  const [inWatchlist, setInWatchlist] = useState(false)
  const [wlLoading, setWlLoading] = useState(false)
  const [orderSuccess, setOrderSuccess] = useState(null)
  // Watchlist folder picker
  const [folders, setFolders]           = useState([])
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const folderPickerRef = useRef(null)

  const loaded = useRef(false)
  const requestVersion = useRef(0)
  const fetchQuote = useCallback(async () => {
    const version = ++requestVersion.current
    if (!loaded.current) setLoading(true)
    setError(null)
    try {
      const { data } = await stocksAPI.snapshot(ticker)
      if (version !== requestVersion.current) return
      loaded.current = true
      setQuote(data)
    } catch (e) {
      if (version === requestVersion.current) setError(e.response?.data?.error || 'Failed to fetch stock data')
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [ticker])

  const checkWatchlist = useCallback(async () => {
    setWatchlistError(null)
    try {
      const { data } = await watchlistAPI.get()
      setInWatchlist(data.watchlist?.some((w) => w.ticker === ticker))
      setFolders(data.folders || [])
    } catch (err) {
      setWatchlistError(err.response?.data?.error || 'Failed to load watchlist')
    }
  }, [ticker])

  useEffect(() => {
    fetchQuote()
    checkWatchlist()
    const timer = setInterval(fetchQuote, 15000)
    return () => { clearInterval(timer); requestVersion.current++ }
  }, [fetchQuote, checkWatchlist])

  // Close folder picker on outside click
  useEffect(() => {
    const handler = (e) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target)) {
        setShowFolderPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleUnwatch = async () => {
    setWatchlistError(null)
    setWlLoading(true)
    try {
      await watchlistAPI.remove(ticker)
      setInWatchlist(false)
    } catch (err) {
      setWatchlistError(err.response?.data?.error || 'Failed to unwatch instrument. Try again.')
    }
    finally { setWlLoading(false) }
  }

  const handleAddToFolder = async (folderId) => {
    setShowFolderPicker(false)
    setWatchlistError(null)
    setWlLoading(true)
    try {
      await watchlistAPI.add(ticker, folderId)
      setInWatchlist(true)
    } catch (err) {
      setWatchlistError(err.response?.data?.error || 'Failed to watch instrument. Try again.')
    }
    finally { setWlLoading(false) }
  }

  const handleOrderSuccess = (result) => {
    setOrderSuccess(result.message)
    setTimeout(() => setOrderSuccess(null), 3000)
    fetchQuote()
  }

  const price      = quote?.price
  const changePct  = quote?.change_pct
  const priceUp    = changePct != null ? changePct >= 0 : null

  return (
    <div className="page-layout">
      <Header />

      <main className="page-content">
        <ResourceError message={watchlistError} onRetry={checkWatchlist} retryLabel="Retry watchlist" />
        {/* Back */}
        <button className="back-btn" onClick={() => navigate(-1)}>
          <ChevronLeft size={16} /> Back
        </button>

        {error && quote && <ResourceError message={error} onRetry={fetchQuote} retryLabel="Retry stock data" />}
        {orderSuccess && (
          <div className="toast success">{orderSuccess}</div>
        )}

        {loading ? (
          <div className="card">
            <Skeleton height="2rem" width="30%" />
            <Skeleton height="1rem" width="50%" style={{ marginTop: '0.5rem' }} />
            <Skeleton height="3rem" width="20%" style={{ marginTop: '1rem' }} />
          </div>
        ) : error && !quote ? (
          <div className="error-banner">{error}</div>
        ) : quote && (
          <>
            {/* Quote header */}
            <section className="card stock-header">
              <div className="stock-header-left">
                <div className="stock-title">
                  <h1 className="stock-ticker">{quote.ticker}</h1>
                  <span className="stock-exchange">{quote.exchange}</span>
                </div>
                <p className="stock-company">{quote.company_name}</p>
                <p className="text-muted">Quote: {quote.quality}{quote.fetchedAt ? ` · received ${new Date(quote.fetchedAt).toLocaleString()}` : ''}</p>
                {quote.provider !== 'yfinance' && <p className="text-muted">{quote.currency} · {quote.provider === "fixture" ? "Simulated fixture data" : quote.provider} · {quote.quality} · {quote.session || "Unknown session"}{quote.observedAt ? ` · ${new Date(quote.observedAt).toLocaleString()}` : ""}</p>}
                {quote.unavailableReason && <p className="error-banner">{quote.unavailableReason}</p>}
                <p className="stock-sector">{[quote.sector, quote.industry].filter(Boolean).join(' · ')}</p>
              </div>

              <div className="stock-header-right">
                <div className="stock-price-wrap">
                  <span className="stock-price">
                    {price != null ? fp(price) : '—'}
                  </span>
                  {changePct != null && (
                    <span className={`stock-change ${priceUp ? 'pos' : 'neg'}`}>
                      {priceUp
                        ? <TrendingUp size={16} />
                        : <TrendingDown size={16} />
                      }
                      {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
                    </span>
                  )}
                </div>

                <div className="stock-actions">
                  {inWatchlist ? (
                    <button
                      className="btn btn-ghost"
                      onClick={handleUnwatch}
                      disabled={wlLoading}
                      title="Remove from watchlist"
                    >
                      <StarOff size={15} /> Unwatch
                    </button>
                  ) : (
                    <div className="wl-add-wrap" ref={folderPickerRef}>
                      <button
                        className="btn btn-outline wl-add-btn"
                        onClick={() => setShowFolderPicker((v) => !v)}
                        disabled={wlLoading}
                        title="Add to watchlist"
                      >
                        <Star size={15} />
                        Watch
                        <ChevronDown size={13} style={{ marginLeft: 2 }} />
                      </button>
                      {showFolderPicker && (
                        <div className="wl-folder-picker">
                          <div className="wl-fp-header">Add to list</div>
                          <button
                            className="wl-fp-item"
                            onMouseDown={() => handleAddToFolder(null)}
                          >
                            Watchlist (default)
                          </button>
                          {folders.map((f) => (
                            <button
                              key={f.folder_id}
                              className="wl-fp-item"
                              onMouseDown={() => handleAddToFolder(f.folder_id)}
                            >
                              {f.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={() => setShowOrder(true)}
                    disabled={!canTradeQuote(quote)}
                  >
                    <ShoppingCart size={15} /> Trade
                  </button>
                </div>
              </div>
            </section>

            {/* Key stats */}
            <section className="card">
              <h2 className="card-title">Key Statistics</h2>
              <p className="text-muted" role="status">Statistics: {quote.statisticsQuality || 'unavailable'}{quote.statisticsFetchedAt ? ` · received ${new Date(quote.statisticsFetchedAt).toLocaleString()}` : ' · awaiting provider data'}. These values do not determine trade eligibility.</p>
              <div className="stats-grid-4">
                <StatItem label="Open"        value={fp(quote.open)} />
                <StatItem label="Day High"    value={fp(quote.day_high)} />
                <StatItem label="Day Low"     value={fp(quote.day_low)} />
                <StatItem label="Prev Close"  value={fp(quote.previous_close)} />
                <StatItem label="Volume"      value={quote.volume != null ? Number(quote.volume).toLocaleString() : '—'} />
                <StatItem label="Avg Volume"  value={quote.avg_volume != null ? Number(quote.avg_volume).toLocaleString() : '—'} />
                <StatItem label="Market Cap"  value={fmtNum(quote.market_cap)} />
                <StatItem label="P/E Ratio"   value={quote.pe_ratio?.toFixed(2)} />
                <StatItem label="52W High"    value={fp(quote['52w_high'])} />
                <StatItem label="52W Low"     value={fp(quote['52w_low'])} />
              </div>
            </section>

            {/* Chart */}
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">Price History</h2>
                <button className="icon-btn" onClick={fetchQuote} title="Refresh price">
                  <RefreshCw size={15} />
                </button>
              </div>
              <PriceChart ticker={ticker} />
            </section>

            {/* Description */}
            {quote.description && (
              <section className="card">
                <h2 className="card-title">About {quote.company_name}</h2>
                <p className="stock-description">{quote.description}</p>
              </section>
            )}
          </>
        )}

        {/* Order modal */}
        {showOrder && (
          <OrderForm
            ticker={ticker}
            price={price}
            onClose={() => setShowOrder(false)}
            onSuccess={handleOrderSuccess}
          />
        )}
      </main>
    </div>
  )
}
