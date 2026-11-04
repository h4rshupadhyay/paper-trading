import { useState, useEffect, useCallback, useRef } from 'react'
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
import { useActivityRefresh } from '../hooks/useMarketStream'
import useBackgroundRefresh from '../hooks/useBackgroundRefresh'
import { portfolioAPI } from '../services/api'
import { PORTFOLIO_PERIODS, portfolioTick, portfolioTooltipDate } from '../services/portfolioHistory'
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

function PortfolioChart({ snapshots, loading, formatCurrency, period, boundaries }) {
  if (loading) return <div role="status" aria-label="Loading chart">Loading chart…<SkeletonChart /></div>
  if (snapshots.length < 2) return (
    <div className="chart-empty" style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      Not enough samples in this range. Choose a longer range or check back later.
    </div>
  )

  const first = boundaries.firstValue
  const last  = boundaries.lastValue
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
          dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']}
          tickFormatter={(v) => portfolioTick(v, period)} minTickGap={35}
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
          labelFormatter={portfolioTooltipDate}
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
  const [period, setPeriod] = useState('5y')
  const [boundaries, setBoundaries] = useState({ firstValue: null, lastValue: null })
  const [loading, setLoading]       = useState(true)
  const [snapLoading, setSnapLoading] = useState(true)
  const [error, setError]           = useState(null)
  const [historyError, setHistoryError] = useState(null)

  const portfolioVersion = useRef(0)
  const fetchPortfolio = useCallback(async ({ background = false } = {}) => {
    const version = ++portfolioVersion.current
    if (!background) setLoading(true)
    try {
      const { data } = await portfolioAPI.get()
      if (version !== portfolioVersion.current) return
      setPortfolio(data)
      setError(null)
    } catch (e) {
      if (version === portfolioVersion.current) setError(e.response?.data?.error || 'Failed to load portfolio')
    } finally {
      if (version === portfolioVersion.current) setLoading(false)
    }
  }, [])

  useActivityRefresh(() => fetchPortfolio({ background: true }), portfolio?.holdings?.map(item => item.instrumentId) ?? [], true)
  useBackgroundRefresh(() => fetchPortfolio({ background: true }))

  const snapshotVersion = useRef(0)
  const fetchSnapshots = useCallback(async (selectedPeriod = period) => {
    const version = ++snapshotVersion.current
    setSnapLoading(true)
    setHistoryError(null)
    try {
      const { data } = await portfolioAPI.history(selectedPeriod)
      if (version !== snapshotVersion.current) return
      setSnapshots(data.snapshots || [])
      setBoundaries(data)
    } catch (e) {
      if (version === snapshotVersion.current) setHistoryError(e.response?.data?.error || 'Failed to load portfolio history. Try Refresh.')
    } finally { if (version === snapshotVersion.current) setSnapLoading(false) }
  }, [period])

  useEffect(() => { fetchPortfolio() }, [fetchPortfolio])
  useEffect(() => {
    fetchSnapshots(period)
    return () => { snapshotVersion.current++ }
  }, [fetchSnapshots, period])

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

        {portfolio?.quality==='stale' && <p className="text-muted valuation-note">Some prices are out of date.</p>}
        {portfolio?.quality==='review' && <p className="text-muted valuation-note">Some holdings are under review.</p>}
        {portfolio?.quality==='incomplete' && <p className="text-muted valuation-note">Some holdings can't be valued right now.</p>}

        {/* Portfolio growth chart */}
        <section className="card chart-section">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
            <h2 className="card-title">Portfolio Growth</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: '100%' }}>
              <div className="period-tabs" role="group" aria-label="Portfolio history range" style={{ flexWrap: 'wrap' }}>
                {PORTFOLIO_PERIODS.map(p => (
                  <button key={p.value} className={`period-btn ${period === p.value ? 'active' : ''}`}
                    aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>{p.label}</button>
                ))}
              </div>
              <button className="icon-btn" onClick={() => fetchSnapshots(period)} title="Refresh" aria-label="Refresh portfolio history">
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          {historyError ? <div className="error-banner" role="alert">{historyError}</div> :
            <PortfolioChart snapshots={snapshots} loading={snapLoading} formatCurrency={formatCurrency} period={period} boundaries={boundaries} />}
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
