import { useState, useEffect, useRef, useCallback } from 'react'
import { Sun, Moon, Bell, ChevronDown, TrendingUp, TrendingDown } from 'lucide-react'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import { useRegion, REGIONS, tickerCurrency } from '../context/RegionContext'
import StockSearch from './StockSearch'
import ResourceError from './ResourceError'
import { alertsAPI, stocksAPI, notificationsReadEvent } from '../services/api'
import useBackgroundRefresh from '../hooks/useBackgroundRefresh'
import { convertDisplayCurrency } from '../services/contracts'

/* ── Notification bell ─────────────────────────────────────────── */
function NotificationBell() {
  const [notifs, setNotifs]   = useState([])
  const [open, setOpen]       = useState(false)
  const [marking, setMarking] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const dropdownRef           = useRef(null)
  const unreadVersion = useRef(0)

  const fetchUnread = useCallback(async () => {
    const version = ++unreadVersion.current
    setLoadError(null)
    try {
      const { data } = await alertsAPI.notifications(true)
      if (version === unreadVersion.current) setNotifs(data)
    } catch (err) {
      if (version === unreadVersion.current) setLoadError(err.response?.data?.error || 'Failed to load notifications')
    }
  }, [])

  useEffect(() => {
    fetchUnread()
    const read = ({ detail: ids }) => {
      unreadVersion.current++
      setNotifs((prev) => prev.filter((n) => !ids.includes(n.notif_id)))
    }
    window.addEventListener(notificationsReadEvent, read)
    return () => { unreadVersion.current++; window.removeEventListener(notificationsReadEvent, read) }
  }, [fetchUnread])
  useBackgroundRefresh(fetchUnread)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleMarkAll = async () => {
    const ids = notifs.map((n) => n.notif_id)
    if (!ids.length) return
    setActionError(null)
    setMarking(true)
    try {
      await alertsAPI.markRead(ids)
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to mark notifications read. Try again.')
    } finally { setMarking(false) }
  }

  const unread = notifs.length

  return (
    <div className="notif-bell-wrapper" ref={dropdownRef}>
      <button
        className="icon-btn notif-bell-btn"
        onClick={() => { setOpen((v) => !v); if (!open) fetchUnread() }}
        title="Notifications"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-dropdown-header">
            <span>Notifications</span>
            {unread > 0 && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={handleMarkAll}
                disabled={marking}
                style={{ fontSize: '0.75rem', padding: '2px 6px' }}
              >
                Mark all read
              </button>
            )}
          </div>
          <ResourceError message={actionError} />
          <ResourceError message={loadError} onRetry={fetchUnread} retryLabel="Retry notifications" />
          {notifs.length === 0 && !loadError ? (
            <p className="notif-dropdown-empty">No unread notifications</p>
          ) : (
            <ul className="notif-dropdown-list">
              {notifs.slice(0, 8).map((n) => (
                <li key={n.notif_id} className="notif-dropdown-item">
                  <div className="notif-dot" />
                  <div>
                    <p className="notif-message">{n.message}</p>
                    <span className="text-muted" style={{ fontSize: '0.72rem' }}>
                      {n.created_at ? new Date(n.created_at).toLocaleString() : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Region selector ───────────────────────────────────────────── */
function RegionSelector() {
  const { region, setRegionId } = useRegion()
  const [open, setOpen]         = useState(false)
  const ref                     = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="region-selector" ref={ref}>
      <button
        className="region-btn"
        onClick={() => setOpen((v) => !v)}
        title="Change region"
      >
        <span className="region-flag">{region.flag}</span>
        <span className="region-code">{region.id}</span>
        <ChevronDown
          size={12}
          className={`region-chevron ${open ? 'open' : ''}`}
        />
      </button>

      {open && (
        <div className="region-dropdown">
          {REGIONS.map((r) => (
            <button
              key={r.id}
              className={`region-option ${r.id === region.id ? 'active' : ''}`}
              onClick={() => { setRegionId(r.id); setOpen(false) }}
            >
              <span className="region-flag">{r.flag}</span>
              <span className="region-option-label">{r.label}</span>
              <span className="region-option-currency">{r.currency}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Live index ticker ─────────────────────────────────────────── */
function IndexTicker() {
  const { region, formatPrice } = useRegion()
  const [quote, setQuote]   = useState(null)

  useEffect(() => {
    let cancelled = false
    setQuote(null)  // clear while loading new region

    stocksAPI.indexQuote(region.index)
      .then(({ data }) => { if (!cancelled) setQuote(data) })
      .catch(() => {})

    // Refresh every 60 s
    const interval = setInterval(() => {
      stocksAPI.indexQuote(region.index)
        .then(({ data }) => { if (!cancelled) setQuote(data) })
        .catch(() => {})
    }, 60_000)

    return () => { cancelled = true; clearInterval(interval) }
  }, [region.index])

  if (!quote) return (
    <div className="index-ticker index-ticker-loading">
      <span className="index-name">{region.indexName}</span>
    </div>
  )

  const up = (quote.change_pct ?? 0) >= 0

  return (
    <div className="index-ticker">
      <span className="index-name">{region.indexName}</span>
      <span className="index-price">
        {formatPrice(quote.price, { from: tickerCurrency(region.index) })}
      </span>
      {quote.change_pct != null && <span className={`index-change ${up ? 'pos' : 'neg'}`}>
        {up
          ? <TrendingUp size={11} />
          : <TrendingDown size={11} />
        }
        {up ? '+' : ''}{quote.change_pct.toFixed(2)}%
      </span>}
    </div>
  )
}

/* ── Header ────────────────────────────────────────────────────── */
export default function Header({ title }) {
  const { refreshError, refreshUser } = useAuth()
  const [refreshingAccount, setRefreshingAccount] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const { rates, ratesLoaded, fxAsOf } = useRegion()
  const observations=Object.values(rates).filter(item=>item.currency!=='INR')
  const conversionUnavailable=ratesLoaded && (!observations.length || observations.some(item=>convertDisplayCurrency('1',item.currency,'INR',rates,fxAsOf)==null))

  return (
    <>
    <header className="topbar">
      {(title || conversionUnavailable) && <div className="topbar-left">
        {title && <h1 className="page-title">{title}</h1>}
        {conversionUnavailable && <small role="status" className="text-muted fx-status">Currency conversion unavailable</small>}
      </div>}

      <div className="topbar-center">
        <StockSearch />
      </div>

      <div className="topbar-right">
        <IndexTicker />
        <NotificationBell />
        <RegionSelector />
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
    {refreshError && <div className="error-banner" role="alert">
      Account display could not refresh. Your accepted orders are unchanged.{' '}
      <button className="btn btn-sm btn-outline" disabled={refreshingAccount} onClick={async () => {
        setRefreshingAccount(true)
        try { await refreshUser() } catch (_) {} finally { setRefreshingAccount(false) }
      }}>Refresh account</button>
    </div>}
    </>
  )
}
