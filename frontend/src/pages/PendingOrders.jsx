import { useState, useEffect, useCallback } from 'react'
import { Clock, Ban, CheckCircle, Plus, Loader2, X } from 'lucide-react'
import Header from '../components/Header'
import OrderForm from '../components/OrderForm'
import TickerInput from '../components/TickerInput'
import { pendingOrdersAPI, stocksAPI } from '../services/api'
import { useRegion, tickerCurrency } from '../context/RegionContext'

const STATUS_TABS = ['OPEN', 'TRIGGERED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']

const STATUS_ICON = {
  OPEN:      <Clock size={14} style={{ color: 'var(--yellow)' }} />,
  FILLED:    <CheckCircle size={14} style={{ color: 'var(--green)' }} />,
  CANCELLED: <Ban size={14} style={{ color: 'var(--text-muted)' }} />,
}

/** Small first-step modal: just pick a ticker, then open the full OrderForm */
function TickerPicker({ onConfirm, onClose }) {
  const [ticker, setTicker]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  const confirm = async (t) => {
    if (!t) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await stocksAPI.quote(t)
      onConfirm(t, data.price ?? null)
    } catch (err) {
      setError(err.response?.data?.error || 'Ticker not found')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    confirm(ticker.trim().toUpperCase())
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" style={{ maxWidth: 340 }}>
        <div className="modal-header">
          <span className="modal-ticker">New Order</span>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="order-body">
          <label className="form-label">
            Ticker Symbol
            <TickerInput
              value={ticker}
              onChange={setTicker}
              onSelect={(t) => confirm(t)}
              placeholder="e.g. AAPL, RELIANCE.NS"
              disabled={loading}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="order-submit buy" type="submit" disabled={loading || !ticker.trim()}>
            {loading ? <Loader2 size={15} className="spin" /> : 'Continue →'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function PendingOrders() {
  const { formatPrice } = useRegion()
  const fmt = (n, ticker) => n != null ? formatPrice(n, { from: tickerCurrency(ticker) }) : '—'

  const [activeTab, setActiveTab]         = useState('OPEN')
  const [orders, setOrders]               = useState([])
  const [loading, setLoading]             = useState(true)
  const [cancelling, setCancelling]       = useState(null)
  const [toast, setToast]                 = useState(null)

  // modal flow: null | 'pick' | { ticker, price }
  const [modal, setModal] = useState(null)

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const fetchOrders = useCallback(async (status = activeTab) => {
    setLoading(true)
    try {
      const { data } = await pendingOrdersAPI.list(status)
      setOrders(data)
    } catch (_) {}
    finally { setLoading(false) }
  }, [activeTab])

  useEffect(() => { fetchOrders(activeTab) }, [activeTab])

  const handleCancel = async (order_id) => {
    setCancelling(order_id)
    try {
      await pendingOrdersAPI.cancel(order_id)
      setOrders((prev) => prev.filter((o) => o.order_id !== order_id))
      showToast('Order cancelled')
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to cancel')
    } finally {
      setCancelling(null)
    }
  }

  const handleOrderSuccess = (result) => {
    setModal(null)
    showToast(result?.message || 'Order placed')
    fetchOrders('OPEN')
    setActiveTab('OPEN')
  }

  return (
    <div className="page-layout">
      <Header title="Pending Orders" />
      <main className="page-content">

        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Clock size={15} style={{ marginRight: 6 }} />
                Pending Orders
              </h2>
              <p className="card-sub">{orders.length} {activeTab.toLowerCase()} orders</p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setModal('pick')}>
              <Plus size={14} /> New Order
            </button>
          </div>

          {/* Status tabs */}
          <div className="status-tabs">
            {STATUS_TABS.map((t) => (
              <button
                key={t}
                className={`status-tab ${activeTab === t ? 'active' : ''}`}
                onClick={() => setActiveTab(t)}
              >
                {STATUS_ICON[t]} {t}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <Loader2 size={22} className="spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : orders.length === 0 ? (
            <div className="empty-state">
              <Clock size={36} opacity={0.3} />
              <p>No {activeTab.toLowerCase()} orders.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th>Qty</th>
                    <th>Limit</th>
                    <th>Stop</th>
                    <th>Status</th>
                    <th>Filled At</th>
                    <th>Filled Price</th>
                    <th>Expires</th>
                    {['OPEN', 'TRIGGERED'].includes(activeTab) && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.order_id}>
                      <td>
                        <div className="stock-cell">
                          <span className="ticker-badge">{o.ticker}</span>
                          <span className="company-name">{o.company_name}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`type-badge ${o.order_side === 'BUY' ? 'pos' : 'neg'}`}>
                          {o.order_side}
                        </span>
                      </td>
                      <td>
                        <span className="order-type-badge">{o.order_type.replace('_', ' ')}</span>
                      </td>
                      <td className="fw-medium">{Number(o.quantity).toLocaleString()}</td>
                      <td>{fmt(o.limit_price,  o.ticker)}</td>
                      <td>{fmt(o.stop_price,   o.ticker)}</td>
                      <td>
                        <span className={`status-pill status-${o.status.toLowerCase()}`}>
                          {o.status}
                        </span>
                      </td>
                      <td className="text-muted">
                        {o.filled_at ? new Date(o.filled_at).toLocaleString() : '—'}
                      </td>
                      <td>{fmt(o.filled_price, o.ticker)}</td>
                      <td className="text-muted">
                        {o.expires_at ? new Date(o.expires_at).toLocaleString() : '—'}
                      </td>
                      {['OPEN', 'TRIGGERED'].includes(activeTab) && (
                        <td>
                          <button
                            className="btn btn-sm btn-ghost btn-danger"
                            onClick={() => handleCancel(o.order_id)}
                            disabled={cancelling === o.order_id}
                            title="Cancel order"
                          >
                            {cancelling === o.order_id
                              ? <Loader2 size={13} className="spin" />
                              : <X size={13} />}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* Step 1: pick a ticker */}
      {modal === 'pick' && (
        <TickerPicker
          onClose={() => setModal(null)}
          onConfirm={(ticker, price) => setModal({ ticker, price })}
        />
      )}

      {/* Step 2: full order form (same as ticker page) */}
      {modal && modal !== 'pick' && (
        <OrderForm
          ticker={modal.ticker}
          price={modal.price}
          onClose={() => setModal(null)}
          onSuccess={handleOrderSuccess}
        />
      )}

      {toast && <div className="toast success">{toast}</div>}
    </div>
  )
}
