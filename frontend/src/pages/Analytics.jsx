import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
  BarChart, Bar,
} from 'recharts'
import {
  TrendingUp, TrendingDown, DollarSign,
  PieChart as PieIcon, BarChart2, RefreshCw,
} from 'lucide-react'
import Header from '../components/Header'
import { useRegion, tickerCurrency } from '../context/RegionContext'
import { portfolioAPI } from '../services/api'
import { PORTFOLIO_PERIODS, portfolioTick, portfolioTooltipDate } from '../services/portfolioHistory'

// ── Palette for pie slices ──────────────────────────────────────
const COLORS = [
  '#387ed1', '#00b386', '#e8a020', '#e84040',
  '#a855f7', '#06b6d4', '#f97316', '#84cc16',
  '#ec4899', '#64748b',
]

// ── Helpers ─────────────────────────────────────────────────────


function pct(n) {
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`
}

/* ── Stat card ─────────────────────────────────────────────────── */
function StatCard({ label, value, sub, positive }) {
  return (
    <div className="stat-card">
      <div className="stat-header">
        <span className="stat-label">{label}</span>
      </div>
      <div className={`stat-value ${positive === true ? 'pos' : positive === false ? 'neg' : ''}`}>
        {value}
      </div>
      {sub != null && (
        <div className={`stat-sub ${positive === true ? 'pos' : positive === false ? 'neg' : ''}`}>
          {sub}
        </div>
      )}
    </div>
  )
}

/* ── Custom tooltip for area chart ─────────────────────────────── */
function AreaTooltip({ active, payload, label, formatCurrency }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{portfolioTooltipDate(d.time ?? label)}</div>
      <p>Total: <b>{formatCurrency(d.total_value)}</b></p>
      <p>Holdings: <b>{formatCurrency(d.holdings_value)}</b></p>
      <p>Cash: <b>{formatCurrency(d.cash_balance)}</b></p>
    </div>
  )
}

export default function Analytics() {
  const { formatCurrency, region } = useRegion()

  const [portfolio,     setPortfolio]     = useState(null)
  const [snapshots,     setSnapshots]     = useState([])
  const [loading,       setLoading]       = useState(true)
  const [snapLoading,   setSnapLoading]   = useState(true)
  const [period,        setPeriod]        = useState('5y')
  const [boundaries,    setBoundaries] = useState({ firstValue: null, lastValue: null })
  const [snapError,     setSnapError] = useState(null)
  const [error,         setError]         = useState(null)

  const fetchPortfolio = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await portfolioAPI.get()
      setPortfolio(data)
      setError(null)
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load portfolio')
    } finally { setLoading(false) }
  }, [])

  const snapshotVersion = useRef(0)
  const fetchSnapshots = useCallback(async (selectedPeriod = period) => {
    const version = ++snapshotVersion.current
    setSnapLoading(true)
    setSnapError(null)
    try {
      const { data } = await portfolioAPI.history(selectedPeriod)
      if (version === snapshotVersion.current) { setSnapshots(data.snapshots || []); setBoundaries(data) }
    } catch (err) {
      if (version === snapshotVersion.current) setSnapError(err?.response?.data?.error || 'Failed to load portfolio history. Try Refresh.')
    } finally { if (version === snapshotVersion.current) setSnapLoading(false) }
  }, [period])

  useEffect(() => { fetchPortfolio() }, [fetchPortfolio])
  useEffect(() => { fetchSnapshots(period); return () => { snapshotVersion.current++ } }, [period])

  // ── Derived data ─────────────────────────────────────────────

  const holdings = portfolio?.holdings || []
  const valuationAvailable = !!portfolio && portfolio.quality !== 'incomplete'
  const valuedHoldings = valuationAvailable ? holdings : []

  // Helper: format a value tied to a specific ticker's native currency
  const fmtH = (n) => formatCurrency(n)

  // Sector allocation — aggregate INR values, then format for display
  const sectorMap = {}
  for (const h of valuedHoldings) {
    const s = h.sector || 'Other'
    const baseValue = (h.market_value ?? 0)
    sectorMap[s] = (sectorMap[s] || 0) + baseValue
  }
  // Store chart values in the account currency (INR)
  const sectorData = Object.entries(sectorMap)
    .map(([name, value]) => ({ name, value: +value.toFixed(2), currency: 'INR' }))
    .sort((a, b) => b.value - a.value)

  // Cash vs holdings allocation in INR
  const holdingsINR = holdings.reduce((s, h) =>
    s + (h.market_value ?? 0), 0)
  const cashINR = (portfolio?.cash_balance ?? 0)
  const allocationData = portfolio ? [
    { name: 'Holdings', value: +holdingsINR.toFixed(2) },
    { name: 'Cash',     value: +cashINR.toFixed(2) },
  ] : []

  // Win / loss breakdown
  const winners = valuedHoldings.filter((h) => h.pl > 0)
  const losers  = valuedHoldings.filter((h) => h.pl < 0)
  const flat    = valuedHoldings.filter((h) => h.pl === 0)

  const totalPL    = holdings.reduce((s, h) => s + (h.pl || 0), 0)
  const bestHolder = holdings.slice().sort((a, b) => (b.pl_pct || 0) - (a.pl_pct || 0))[0]
  const worstHolder = holdings.slice().sort((a, b) => (a.pl_pct || 0) - (b.pl_pct || 0))[0]

  // P/L per holding for bar chart (sorted by pl_pct)
  const plBarData = valuedHoldings
    .slice()
    .sort((a, b) => (b.pl_pct || 0) - (a.pl_pct || 0))
    .map((h) => ({
      ticker: h.ticker,
      pl_pct: +(h.pl_pct || 0).toFixed(2),
      pl:     +(h.pl     || 0).toFixed(2),
    }))

  // Portfolio growth chart color
  const firstSnap = boundaries.firstValue
  const lastSnap  = boundaries.lastValue
  const chartUp   = (lastSnap ?? 0) >= (firstSnap ?? 0)
  const chartColor = chartUp ? 'var(--green)' : 'var(--red)'

  const winRate = holdings.length
    ? Math.round((winners.length / holdings.length) * 100)
    : 0

  return (
    <div className="page-layout">
      <Header title="Analytics" />

      <main className="page-content">

        {error && (
          <div className="error-banner" role="alert">{error}</div>
        )}

        {portfolio?.quality==='stale' && <p className="text-muted data-note">Some prices are out of date.</p>}
        {portfolio?.quality==='review' && <p className="text-muted data-note">Some holdings are under review.</p>}
        {portfolio?.quality === 'incomplete' && <p role="status">Some prices are unavailable. Showing {holdings.length} holding(s). <button className="btn btn-sm btn-outline" onClick={fetchPortfolio}>Refresh</button></p>}

        {/* ── Summary stats ── */}
        <section className="stats-grid">
          <StatCard
            label="Total Portfolio"
            value={formatCurrency(portfolio?.total_value)}
          />
          <StatCard
            label="Unrealized P/L"
            value={formatCurrency(portfolio?.total_pl)}
            sub={valuationAvailable && portfolio?.total_pl_pct != null ? pct(portfolio.total_pl_pct) : undefined}
            positive={portfolio?.total_pl >= 0}
          />
          <StatCard
            label="Profitable holdings"
            value={valuationAvailable && holdings.length ? `${winRate}%` : '—'}
            sub={valuationAvailable ? `${winners.length} positive · ${losers.length} negative · ${flat.length} flat` : 'Valuation unavailable'}
            positive={winRate >= 50 ? true : winRate < 40 ? false : undefined}
          />
          <StatCard
            label="Holdings"
            value={holdings.length}
            sub={`${formatCurrency(portfolio?.holdings_value, { compact: true })} invested`}
          />
        </section>

        {/* ── Portfolio growth chart ── */}
        <section className="card chart-section">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 className="card-title">Portfolio Value Over Time</h2>
              {!snapLoading && !snapError && snapshots.length > 0 && firstSnap > 0 && lastSnap != null && (
                <p className={`card-sub ${chartUp ? 'pos' : 'neg'}`}>
                  {chartUp ? '▲' : '▼'} {pct(((lastSnap - firstSnap) / firstSnap) * 100)} over period
                </p>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: '100%' }}>
              <div className="period-tabs" role="group" aria-label="Portfolio history range" style={{ flexWrap: 'wrap' }}>
                {PORTFOLIO_PERIODS.map((p) => (
                  <button
                    key={p.value}
                    className={`period-btn ${period === p.value ? 'active' : ''}`}
                    aria-pressed={period === p.value}
                    onClick={() => setPeriod(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <button className="icon-btn" onClick={() => fetchSnapshots(period)} title="Refresh" aria-label="Refresh portfolio history">
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          {snapLoading ? (
            <div className="chart-empty" role="status" style={{ height: 220 }}>
              Loading chart…
            </div>
          ) : snapError ? (
            <div className="chart-empty" role="alert" style={{ height: 220 }}>{snapError}</div>
          ) : snapshots.length < 2 ? (
            <div className="chart-empty" style={{ height: 220 }}>
              Not enough samples in this range. Choose a longer range or check back later.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={snapshots} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={chartColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0}   />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => portfolioTick(v, period)}
                  minTickGap={35}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickLine={false} axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={(v) => formatCurrency(v, {compact:true})}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickLine={false} axisLine={false} width={55}
                />
                <Tooltip content={<AreaTooltip formatCurrency={formatCurrency} />} />
                <Area isAnimationActive={false}
                  type="monotone" dataKey="total_value"
                  stroke={chartColor} strokeWidth={2}
                  fill="url(#grad)" dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* ── Allocation charts row ── */}
        {valuationAvailable && holdings.length > 0 && (
          <div className="analytics-charts-row">

            {/* Sector breakdown */}
            <section className="card">
              <h2 className="card-title" style={{ marginBottom: 16 }}>
                <PieIcon size={15} style={{ marginRight: 6 }} />
                Sector Data
              </h2>
              {sectorData.every(item => item.name === 'Unclassified') ? (
                <p className="text-muted">Sector data unavailable for these holdings.</p>
              ) : sectorData.length === 0 ? (
                <div className="empty-state" style={{ padding: '32px 0' }}>No holdings</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie isAnimationActive={false}
                        data={sectorData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%" cy="50%"
                        innerRadius={50} outerRadius={85}
                        paddingAngle={2}
                      >
                        {sectorData.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v) => [formatCurrency(v), 'Value']}
                        contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6 }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <ul className="sector-legend">
                    {sectorData.map((s, i) => {
                      const total = sectorData.reduce((a, b) => a + b.value, 0)
                      const share = total ? ((s.value / total) * 100).toFixed(1) : 0
                      return (
                        <li key={s.name} className="sector-legend-item">
                          <span className="sector-dot" style={{ background: COLORS[i % COLORS.length] }} />
                          <span className="sector-name">{s.name}</span>
                          <span className="sector-share text-muted">{share}%</span>
                          <span className="sector-value fw-medium">{formatCurrency(s.value, {compact:true})}</span>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </section>

            {/* Cash vs holdings */}
            <section className="card">
              <h2 className="card-title" style={{ marginBottom: 16 }}>
                <DollarSign size={15} style={{ marginRight: 6 }} />
                Portfolio Composition
              </h2>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie isAnimationActive={false}
                    data={allocationData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%" cy="50%"
                    innerRadius={50} outerRadius={85}
                    paddingAngle={2}
                  >
                    <Cell fill="var(--brand)" />
                    <Cell fill="var(--green)" />
                  </Pie>
                  <Tooltip
                    formatter={(v) => [formatCurrency(v), '']}
                    contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6 }}
                  />
                  <Legend
                    formatter={(v) => <span style={{ color: 'var(--text-sub)', fontSize: '0.82rem' }}>{v}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="composition-stats">
                {allocationData.map((a) => (
                  <div key={a.name} className="composition-stat">
                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>{a.name}</span>
                    <span className="fw-medium">{formatCurrency(a.value)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* ── P/L per holding bar chart ── */}
        {plBarData.length > 0 && (
          <section className="card">
            <h2 className="card-title" style={{ marginBottom: 16 }}>
              <BarChart2 size={15} style={{ marginRight: 6 }} />
              P/L by Holding
            </h2>
            <ResponsiveContainer width="100%" height={Math.max(180, plBarData.length * 38)}>
              <BarChart
                data={plBarData}
                layout="vertical"
                margin={{ top: 0, right: 40, left: 10, bottom: 0 }}
              >
                <CartesianGrid stroke="var(--border)" horizontal={false} />
                <XAxis
                  type="number"
                  tickFormatter={(v) => `${v >= 0 ? '+' : ''}${v}%`}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickLine={false} axisLine={false}
                />
                <YAxis
                  type="category" dataKey="ticker"
                  tick={{ fontSize: 12, fill: 'var(--text-sub)', fontWeight: 600 }}
                  tickLine={false} axisLine={false} width={55}
                />
                <Tooltip
                  formatter={(v, name, props) => [
                    `${v >= 0 ? '+' : ''}${v}% (${fmtH(props.payload.pl, props.payload.ticker)})`,
                    'P/L',
                  ]}
                  contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6 }}
                />
                <Bar isAnimationActive={false} dataKey="pl_pct" radius={[0, 3, 3, 0]}>
                  {plBarData.map((d, i) => (
                    <Cell key={i} fill={d.pl_pct >= 0 ? 'var(--green)' : 'var(--red)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </section>
        )}

        {/* ── Top/Bottom performers ── */}
        {valuationAvailable && holdings.length >= 2 && (
          <div className="analytics-charts-row">
            <section className="card">
              <h2 className="card-title" style={{ marginBottom: 12 }}>
                <TrendingUp size={15} style={{ marginRight: 6, color: 'var(--green)' }} />
                Top Performer
              </h2>
              {bestHolder && (
                <div className="performer-card">
                  <span className="ticker-badge" style={{ fontSize: '1rem' }}>{bestHolder.ticker}</span>
                  <div className="performer-info">
                    <span className="performer-name">{bestHolder.company_name}</span>
                    <span className="pos fw-medium" style={{ fontSize: '1.1rem' }}>
                      {pct(bestHolder.pl_pct)}
                    </span>
                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                      {fmtH(bestHolder.pl, bestHolder.ticker)} gain
                    </span>
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <h2 className="card-title" style={{ marginBottom: 12 }}>
                <TrendingDown size={15} style={{ marginRight: 6, color: 'var(--red)' }} />
                Worst Performer
              </h2>
              {worstHolder && (
                <div className="performer-card">
                  <span className="ticker-badge" style={{ fontSize: '1rem' }}>{worstHolder.ticker}</span>
                  <div className="performer-info">
                    <span className="performer-name">{worstHolder.company_name}</span>
                    <span className="neg fw-medium" style={{ fontSize: '1.1rem' }}>
                      {pct(worstHolder.pl_pct)}
                    </span>
                    <span className="text-muted" style={{ fontSize: '0.78rem' }}>
                      {fmtH(Math.abs(worstHolder.pl), worstHolder.ticker)} loss
                    </span>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── Empty state ── */}
        {!loading && holdings.length === 0 && (
          <section className="card">
            <div className="empty-state">
              <BarChart2 size={40} opacity={0.3} />
              <p>No holdings to analyze yet.<br />Place your first trade to see insights.</p>
            </div>
          </section>
        )}

      </main>
    </div>
  )
}
