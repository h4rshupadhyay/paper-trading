import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import {
  TrendingUp,
  RefreshCw, ArrowUpRight,
} from 'lucide-react'
import Header from '../components/Header'
import { SkeletonCard, SkeletonTable, SkeletonChart } from '../components/LoadingSkeleton'
import { portfolioAPI } from '../services/api'
import { useAuth } from '../context/AuthContext'
import { useRegion, tickerCurrency } from '../context/RegionContext'

function StatCard({ label, value, sub, positive }) {
  return (
    <div className="stat-card">
      <div className="stat-header">
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {sub != null && (
        <div className={`stat-sub ${positive === true ? 'pos' : positive === false ? 'neg' : ''}`}>
          {sub}
        </div>
      )}
    </div>
  )
}

function PortfolioChart({ snapshots, loading, formatCurrency, region }) {
  if (loading) return <SkeletonChart />
  if (!snapshots?.length) return (
    <div className="chart-empty" style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      Make your first trade to see your portfolio growth chart
    </div>
  )

  const first = snapshots[0]?.total_value
  const last  = snapshots[snapshots.length - 1]?.total_value
  const up    = last >= first
  const color = up ? 'var(--green)' : 'var(--red)'

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={snapshots} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.12} />
            <stop offset="95%" stopColor={color} stopOpacity={0}   />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={(v) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          tickLine={false} axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v) => formatCurrency(v, {compact:true})}
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          tickLine={false} axisLine={false} width={60}
        />
        <Tooltip
          formatter={(v) => [formatCurrency(v), 'Portfolio Value']}
          labelFormatter={(l) => new Date(l).toLocaleDateString()}
          contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6 }}
        />
        <Area isAnimationActive={false} type="monotone" dataKey="total_value" stroke={color}
          strokeWidth={2} fill="url(#areaGrad)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export default function Dashboard() {
  const { user } = useAuth()
  const { formatCurrency, formatPrice, region } = useRegion()
  const navigate = useNavigate()

  const [portfolio, setPortfolio]   = useState(null)
  const [snapshots, setSnapshots]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [snapLoading, setSnapLoading] = useState(true)
  const [error, setError]           = useState(null)
  const [historyError, setHistoryError] = useState(null)

  const fetchPortfolio = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await portfolioAPI.get()
      setPortfolio(data)
      setError(null)
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load portfolio')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSnapshots = useCallback(async () => {
    setSnapLoading(true)
    try {
      const { data } = await portfolioAPI.snapshots(730)
      setSnapshots(data.snapshots || [])
      setHistoryError(null)
    } catch (e) {
      setHistoryError(e.response?.data?.error || 'Failed to load portfolio history')
    } finally { setSnapLoading(false) }
  }, [])

  useEffect(() => {
    fetchPortfolio()
    fetchSnapshots()
  }, [fetchPortfolio, fetchSnapshots])

  const fmt  = (n) => formatCurrency(n)              // account values (balance, totals)
  const fmtp = (n, ticker) => formatPrice(n, { from: tickerCurrency(ticker) })

  return (
    <div className="page-layout">
      <Header title="Dashboard" />

      <main className="page-content">
        {/* Summary stats */}
        <section className="stats-grid">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="stat-card"><SkeletonCard rows={2} /></div>
            ))
          ) : error ? (
            <div className="error-banner">{error}</div>
          ) : portfolio && (
            <>
              <StatCard
                label="Total Portfolio Value"
                value={fmt(portfolio.total_value)}
              />
              <StatCard
                label="Cash Available"
                value={fmt(portfolio.cash_balance)}
              />
              <StatCard
                label="Holdings Value"
                value={fmt(portfolio.holdings_value)}
                sub={`${portfolio.total_pl_pct >= 0 ? '+' : ''}${portfolio.total_pl_pct?.toFixed(2)}%`}
                positive={portfolio.total_pl_pct >= 0}
              />
              <StatCard
                label="Unrealized P/L"
                value={fmt(portfolio.total_pl)}
                positive={portfolio.total_pl >= 0}
              />
            </>
          )}
        </section>

        <p className="text-muted valuation-note">Valuation: {portfolio?.quality || "loading"}. P/L is in INR and includes FX changes. Missing observations remain unavailable.</p>

        {/* Portfolio growth chart */}
        <section className="card chart-section">
          <div className="card-header">
            <h2 className="card-title">Portfolio Growth</h2>
            <button className="icon-btn" onClick={fetchSnapshots} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>
          {historyError && <div className="error-banner" role="alert">{historyError}</div>}
          <PortfolioChart snapshots={snapshots} loading={snapLoading} formatCurrency={formatCurrency} region={region} />
        </section>

        {/* Holdings table */}
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Holdings</h2>
            <button className="icon-btn" onClick={fetchPortfolio} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>

          {loading ? (
            <SkeletonTable rows={5} cols={6} />
          ) : !portfolio?.holdings?.length ? (
            <div className="empty-state">
              <TrendingUp size={40} opacity={0.3} />
              <p>No holdings yet. Search for a stock and place your first trade!</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th className="numeric">Qty</th>
                    <th className="numeric">Avg Cost</th>
                    <th className="numeric">Current</th>
                    <th className="numeric">Value</th>
                    <th className="numeric">P/L</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.holdings.map((h) => (
                    <tr key={h.ticker}>
                      <td>
                        <div className="stock-cell">
                          <span className="ticker-badge">{h.ticker}</span>
                          <span className="company-name">{h.company_name}</span>
                        </div>
                      </td>
                      <td className="numeric">{h.quantity}</td>
                      <td className="numeric">{fmtp(h.avg_buy_price, h.ticker)}</td>
                      <td className="numeric">{fmtp(h.current_price, h.ticker)}</td>
                      <td className="numeric">{fmt(h.market_value)}</td>
                      <td className="numeric">
                        {h.pl != null ? (
                          <span className={h.pl >= 0 ? 'pos' : 'neg'}>
                            {h.pl >= 0 ? '+' : ''}{fmt(h.pl)}
                            <small> ({h.pl_pct >= 0 ? '+' : ''}{h.pl_pct?.toFixed(2)}%)</small>
                          </span>
                        ) : '—'}
                      </td>
                      <td>
                        <button
                          className="btn btn-sm btn-ghost"
                          aria-label={`View ${h.ticker}`}
                          onClick={() => navigate(`/stocks/${h.ticker}`)}
                        >
                          <ArrowUpRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
