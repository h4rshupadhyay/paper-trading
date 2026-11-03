import { useState, useEffect, useCallback } from 'react'
import {
  Bell, BellOff, Trash2, Plus, Loader2, CheckCheck,
} from 'lucide-react'
import Header from '../components/Header'
import ResourceError from '../components/ResourceError'
import TickerInput from '../components/TickerInput'
import { alertsAPI } from '../services/api'
import { useRegion, tickerCurrency } from '../context/RegionContext'

export default function Alerts() {
  const { formatPrice } = useRegion()
  const fmt = (n, ticker) => formatPrice(n, { from: tickerCurrency(ticker) })
  const [alerts, setAlerts]           = useState([])
  const [notifs, setNotifs]           = useState([])
  const [loadingAlerts, setLoadingAlerts]   = useState(true)
  const [loadingNotifs, setLoadingNotifs]   = useState(true)
  const [showAllNotifs, setShowAllNotifs]   = useState(false)

  const [actionError, setActionError] = useState(null)
  const [notifsError, setNotifsError] = useState(null)
  const [alertsError, setAlertsError] = useState(null)

  // Create form
  const [ticker, setTicker]           = useState('')
  const [condition, setCondition]     = useState('ABOVE')
  const [targetPrice, setTargetPrice] = useState('')
  const [creating, setCreating]       = useState(false)
  const [createError, setCreateError] = useState(null)

  const [deleting, setDeleting]       = useState(null)
  const [marking, setMarking]         = useState(false)
  const [toast, setToast]             = useState(null)

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const fetchAlerts = useCallback(async () => {
    setLoadingAlerts(true)
    setAlertsError(null)
    try {
      const { data } = await alertsAPI.list()
      setAlerts(data)
    } catch (err) {
      setAlertsError(err.response?.data?.error || 'Failed to load alerts')
    } finally { setLoadingAlerts(false) }
  }, [])

  const fetchNotifs = useCallback(async (unreadOnly = !showAllNotifs) => {
    setLoadingNotifs(true)
    setNotifsError(null)
    try {
      const { data } = await alertsAPI.notifications(unreadOnly)
      setNotifs(data)
    } catch (err) {
      setNotifsError(err.response?.data?.error || 'Failed to load notifications')
    } finally { setLoadingNotifs(false) }
  }, [showAllNotifs])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])
  useEffect(() => { fetchNotifs() }, [fetchNotifs])

  // Poll every 15 s so triggered alerts and new notifications appear automatically
  useEffect(() => {
    const id = setInterval(() => {
      fetchAlerts()
      fetchNotifs()
    }, 15_000)
    return () => clearInterval(id)
  }, [fetchAlerts, fetchNotifs])

  const handleCreate = async (e) => {
    e.preventDefault()
    setCreateError(null)
    const price = targetPrice
    if (!ticker.trim() || !/^\d+(\.\d{1,8})?$/.test(price) || Number(price) <= 0) {
      setCreateError('Fill in all fields correctly')
      return
    }
    setCreating(true)
    try {
      const { data } = await alertsAPI.create(ticker.trim().toUpperCase(), condition, price)
      setAlerts((prev) => [data, ...prev])
      setTicker('')
      setTargetPrice('')
      showToast('Alert created')
    } catch (err) {
      setCreateError(err.response?.data?.error || 'Failed to create alert')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (alert_id) => {
    setActionError(null)
    setDeleting(alert_id)
    try {
      await alertsAPI.delete(alert_id)
      setAlerts((prev) => prev.filter((a) => a.alert_id !== alert_id))
      showToast('Alert deleted')
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to delete alert. Try again.')
    } finally { setDeleting(null) }
  }

  const handleMarkRead = async (ids) => {
    setActionError(null)
    setMarking(true)
    try {
      await alertsAPI.markRead(ids)
      setNotifs((prev) =>
        prev.map((n) => ids.includes(n.notif_id) ? { ...n, is_read: true } : n),
      )
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to mark notifications read. Try again.')
    } finally { setMarking(false) }
  }

  const handleMarkAllRead = () => {
    const unread = notifs.filter((n) => !n.is_read).map((n) => n.notif_id)
    if (unread.length) handleMarkRead(unread)
  }

  const unreadCount = notifs.filter((n) => !n.is_read).length

  return (
    <div className="page-layout">
      <Header title="Alerts" />
      <main className="page-content">
        <ResourceError message={actionError} />

        {/* ── Create alert ── */}
        <section className="card">
          <h2 className="card-title" style={{ marginBottom: 14 }}>
            <Bell size={15} style={{ marginRight: 6 }} />
            Create Price Alert
          </h2>
          <form className="alert-form" onSubmit={handleCreate}>
            <TickerInput
              value={ticker}
              onChange={setTicker}
              onSelect={(t) => setTicker(t)}
              placeholder="Search ticker (e.g. RELIANCE.NS)"
              disabled={creating}
            />
            <div className="condition-toggle">
              {['ABOVE', 'BELOW'].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`period-btn ${condition === c ? 'active' : ''}`}
                  onClick={() => setCondition(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <input
              className="form-input"
              type="number"
              placeholder="Target price"
              min="0"
              step="any"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
              Set Alert
            </button>
          </form>
          {createError && (
            <p className="form-error" style={{ marginTop: '0.5rem' }}>{createError}</p>
          )}
        </section>

        {/* ── Active alerts ── */}
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Active Alerts</h2>
              <p className="card-sub">{alerts.filter((a) => a.is_active).length} active</p>
            </div>
          </div>

          <ResourceError message={alertsError} onRetry={fetchAlerts} retryLabel="Retry alerts" />
          {loadingAlerts ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <Loader2 size={20} className="spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : alerts.length === 0 && !alertsError ? (
            <div className="empty-state">
              <BellOff size={36} opacity={0.3} />
              <p>No alerts set. Create one above.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Condition</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.alert_id}>
                      <td><span className="ticker-badge">{a.ticker}</span></td>
                      <td>
                        <span
                          className={`type-badge ${a.condition === 'ABOVE' ? 'pos' : 'neg'}`}
                        >
                          {a.condition}
                        </span>
                      </td>
                      <td className="fw-medium">{fmt(a.target_price, a.ticker)}</td>
                      <td>
                        <span className={`status-pill ${a.is_active ? 'status-open' : 'status-filled'}`}>
                          {a.is_active ? 'Active' : 'Triggered'}
                        </span>
                      </td>
                      <td className="text-muted">
                        {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td>
                        <button
                          className="btn btn-sm btn-ghost btn-danger"
                          onClick={() => handleDelete(a.alert_id)}
                          disabled={deleting === a.alert_id}
                          title="Delete alert"
                        >
                          {deleting === a.alert_id
                            ? <Loader2 size={13} className="spin" />
                            : <Trash2 size={13} />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Notifications ── */}
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Bell size={15} style={{ marginRight: 6 }} />
                Notifications
                {unreadCount > 0 && (
                  <span className="notif-count-badge">{unreadCount} unread</span>
                )}
              </h2>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-sm btn-outline"
                onClick={() => setShowAllNotifs((v) => !v)}
              >
                {showAllNotifs ? 'Show unread' : 'Show all'}
              </button>
              {unreadCount > 0 && (
                <button
                  className="btn btn-sm btn-outline"
                  onClick={handleMarkAllRead}
                  disabled={marking}
                >
                  <CheckCheck size={13} /> Mark all read
                </button>
              )}
            </div>
          </div>

          <ResourceError message={notifsError} onRetry={() => fetchNotifs()} retryLabel="Retry notifications" />
          {loadingNotifs ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <Loader2 size={20} className="spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : notifs.length === 0 && !notifsError ? (
            <div className="empty-state">
              <Bell size={36} opacity={0.3} />
              <p>{showAllNotifs ? 'No notifications.' : 'No unread notifications.'}</p>
            </div>
          ) : (
            <ul className="notif-list">
              {notifs.map((n) => (
                <li key={n.notif_id} className={`notif-item ${n.is_read ? 'read' : 'unread'}`}>
                  <div className="notif-dot" />
                  <div className="notif-content">
                    <p className="notif-message">{n.message}</p>
                    <span className="notif-time text-muted">
                      {n.created_at ? new Date(n.created_at).toLocaleString() : ''}
                    </span>
                  </div>
                  {!n.is_read && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => handleMarkRead([n.notif_id])}
                      title="Mark as read"
                    >
                      <CheckCheck size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {toast && <div className="toast success">{toast}</div>}
    </div>
  )
}
