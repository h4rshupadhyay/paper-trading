import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, ChevronLeft, ChevronRight, ArrowUpRight } from 'lucide-react'
import Header from '../components/Header'
import { SkeletonTable } from '../components/LoadingSkeleton'
import { tradingAPI } from '../services/api'
import { useRegion, tickerCurrency } from '../context/RegionContext'

const TYPE_COLOR = { BUY: 'pos', SELL: 'neg' }

export default function Orders() {
  const navigate = useNavigate()

  const [orders, setOrders]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [page, setPage]       = useState(1)
  const [total, setTotal]     = useState(0)
  const [pages, setPages]     = useState(1)
  const PER_PAGE = 20

  const fetchOrders = useCallback(async (p = page) => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await tradingAPI.orders(p, PER_PAGE)
      setOrders(data.orders || [])
      setTotal(data.total  || 0)
      setPages(data.pages  || 1)
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [page]) // eslint-disable-line

  useEffect(() => { fetchOrders(page) }, [page]) // eslint-disable-line

  const { formatPrice, formatCurrency } = useRegion()
  const fmt = (n, ticker) => formatPrice(n, { from: tickerCurrency(ticker) })

  const fmtDate = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="page-layout">
      <Header title="Order History" />

      <main className="page-content">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">All Orders</h2>
              <p className="card-sub">{total} loaded orders</p>
            </div>
            <button className="icon-btn" onClick={() => fetchOrders(page)} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {loading ? (
            <SkeletonTable rows={10} cols={6} />
          ) : !orders.length ? (
            <div className="empty-state">
              <p>No orders yet. Place your first trade!</p>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Type</th>
                      <th>Stock</th>
                      <th>Status</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th>Total</th>
                      <th>Date / Time</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.transaction_id}>
                        <td className="text-muted">{o.transaction_id}</td>
                        <td>
                          <span className={`type-badge ${TYPE_COLOR[o.type]}`}>
                            {o.type}
                          </span>
                        </td>
                        <td>
                          <div className="stock-cell">
                            <span className="ticker-badge">{o.ticker}</span>
                            <span className="company-name">{o.company_name}</span>
                          </div>
                        </td>
                        <td title={o.rejection_reason || ""}>{o.status}</td>
                        <td>{o.quantity}</td>
                        <td>{fmt(o.price, o.ticker)}</td>
                        <td className="fw-medium">{formatCurrency(o.total_amount)}</td>
                        <td className="text-muted">{fmtDate(o.time)}</td>
                        <td>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => navigate(`/stocks/${o.ticker}`)}
                          >
                            <ArrowUpRight size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {pages > 1 && (
                <div className="pagination">
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="page-info">
                    Page {page} of {pages}
                  </span>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  )
}
