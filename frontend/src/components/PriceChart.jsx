import { useState, useEffect, useRef } from 'react'
import {
  ResponsiveContainer, ComposedChart, Line, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { stocksAPI } from '../services/api'
import { SkeletonChart } from './LoadingSkeleton'
import { useRegion, tickerCurrency } from '../context/RegionContext'

const PERIODS = [
  { label: '1D',  value: '1d',  interval: '5m'  },
  { label: '5D',  value: '5d',  interval: '15m' },
  { label: '1M',  value: '1mo', interval: '1d'  },
  { label: '3M',  value: '3mo', interval: '1d'  },
  { label: '6M',  value: '6mo', interval: '1d'  },
  { label: '1Y',  value: '1y',  interval: '1wk' },
  { label: '5Y',  value: '5y',  interval: '1mo' },
]

const COLORS = {
  up:     'var(--green)',
  down:   'var(--red)',
  line:   'var(--brand)',
  volume: 'var(--text-muted)',
  grid:   'var(--border)',
}

function CandlestickBar(props) {
  const { x, y, width, height, payload: { low, high, open, close } } = props
  const isUp    = close >= open
  const color   = isUp ? COLORS.up : COLORS.down
  const barX    = x + width * 0.1
  const barW    = width * 0.8
  // Recharts scales the low/high range; interpolate the body within that range.
  const priceY = price => high === low ? y : y + (high - price) / (high - low) * height

  return (
    <g>
      {/* Wick */}
      <line x1={x + width / 2} y1={priceY(high)} x2={x + width / 2} y2={priceY(low)}
        stroke={color} strokeWidth={1} />
      {/* Body */}
      <rect x={barX} y={Math.min(priceY(open), priceY(close))} width={barW}
        height={Math.max(Math.abs(priceY(close) - priceY(open)), 1)}
        fill={color} stroke={color} />
    </g>
  )
}

function CustomTooltip({ active, payload, label, chartType, fp }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div className="chart-tooltip">
      <p className="tooltip-label">{label}</p>
      {chartType === 'candlestick' ? (
        <>
          <p>O: <b>{fp(d?.open)}</b></p>
          <p>H: <b>{fp(d?.high)}</b></p>
          <p>L: <b>{fp(d?.low)}</b></p>
          <p>C: <b>{fp(d?.close)}</b></p>
        </>
      ) : (
        <p>Price: <b>{fp(d?.close)}</b></p>
      )}
      {d?.volume != null && (
        <p>Vol: <b>{(d.volume / 1e6).toFixed(2)}M</b></p>
      )}
    </div>
  )
}

export default function PriceChart({ ticker, quoteSnapshot }) {
  const { formatPrice } = useRegion()
  const priceCurr = tickerCurrency(ticker)
  const fp = (n) => n != null ? formatPrice(n, { from: priceCurr }) : '—'

  const [snapshot, setSnapshot] = useState(null)
  const lastSnapshot = useRef(null)
  const [retry, setRetry] = useState(0)
  const data = snapshot?.data || []
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [period, setPeriod]   = useState(PERIODS[2])   // default 1M
  const [chartType, setChartType] = useState('line')   // line | candlestick

  useEffect(() => {
    if (!ticker) return
    let active = true
    const storageKey = `paper:chart:${ticker}`
    let saved = {}
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}') || {} } catch { /* Storage may be disabled. */ }
    const valid = value => value?.ticker === ticker && Array.isArray(value.data) && value.data.length > 0
      && value.data.length <= 2000 && value.data.every(bar => Number.isFinite(bar.close) && bar.close > 0)
      && PERIODS.some(p => p.value === value.period) && Number.isFinite(Date.parse(value.savedAt))
    const previous = valid(lastSnapshot.current) ? lastSnapshot.current : Object.values(saved).filter(valid).sort((a,b) => Date.parse(b.savedAt)-Date.parse(a.savedAt))[0]
    const fallback = valid(saved[period.value]) ? saved[period.value] : previous
    setSnapshot(fallback || null)
    setLoading(true)
    setError(null)
    stocksAPI.history(ticker, period.value, period.interval)
      .then(({ data: res }) => {
        if (!active) return
        if (!res.data?.length) throw new Error('No chart data available for this range.')
        const formatted = res.data.map((d) => ({
          ...d,
          label: period.value === '1d' || period.value === '5d'
            ? new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : new Date(d.time).toLocaleDateString([], { month: 'short', day: 'numeric' }),
        }))
        const next = { ticker, period: period.value, data: formatted, savedAt: new Date().toISOString() }
        setSnapshot(next)
        lastSnapshot.current = next
        try { sessionStorage.setItem(storageKey, JSON.stringify({ ...saved, [period.value]: next })) } catch { /* In-memory fallback remains available. */ }
      })
      .catch((e) => {
        if (active) setError(e.response?.data?.error || e.message || 'Failed to load chart data')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [ticker, period, retry])

  const minPrice = Math.min(...data.map((d) => d.low  || d.close)) * 0.998
  const maxPrice = Math.max(...data.map((d) => d.high || d.close)) * 1.002
  const firstClose = data[0]?.close
  const lastClose  = data[data.length - 1]?.close
  const lineColor  = lastClose >= firstClose ? COLORS.up : COLORS.down

  return (
    <div className="price-chart">
      {/* Controls */}
      <div className="chart-controls">
        <div className="period-tabs">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              className={`period-btn${period.value === p.value ? ' active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="chart-type-tabs">
          {['line', 'candlestick'].map((t) => (
            <button
              key={t}
              className={`period-btn${chartType === t ? ' active' : ''}`}
              onClick={() => setChartType(t)}
            >
              {t === 'line' ? 'Line' : 'Candle'}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="status" className="chart-error">
          {error} {snapshot ? `Showing saved ${PERIODS.find(p => p.value === snapshot.period)?.label} history, fetched ${new Date(snapshot.savedAt).toLocaleString()}. This is not live data.` : 'Try another range or retry.'}
          {' '}<button className="period-btn" onClick={() => setRetry(value => value + 1)}>Retry</button>
        </div>
      )}
      {error && !snapshot && quoteSnapshot?.price != null && (
        <p className="text-muted">Latest saved price: {fp(quoteSnapshot.price)}
          {quoteSnapshot.observedAt ? ` as of ${new Date(quoteSnapshot.observedAt).toLocaleString()}` : ''}.
          {' '}A single quote does not contain price history.
        </p>
      )}
      {loading && <SkeletonChart />}
      {!loading && data.length > 0 && <>
      {/* Chart */}
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={COLORS.grid} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="price"
            domain={[minPrice, maxPrice]}
            tickFormatter={(v) => formatPrice(v, { from: priceCurr, decimals: 0 })}
            tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickLine={false}
            axisLine={false}
            width={90}
          />
          <YAxis
            yAxisId="volume"
            orientation="right"
            tickFormatter={(v) => `${(v / 1e6).toFixed(0)}M`}
            tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
            tickLine={false}
            axisLine={false}
            width={50}
          />
          <Tooltip content={<CustomTooltip chartType={chartType} fp={fp} />} />

          {/* Volume bars */}
          <Bar isAnimationActive={false}
            yAxisId="volume"
            dataKey="volume"
            fill={COLORS.volume}
            opacity={0.35}
            radius={[2, 2, 0, 0]}
          />

          {/* Price */}
          {chartType === 'line' ? (
            <Line isAnimationActive={false}
              yAxisId="price"
              type="monotone"
              dataKey="close"
              stroke={lineColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: lineColor, fill: lineColor }}
            />
          ) : (
            /* Candlestick via custom shape */
            <Bar
              yAxisId="price"
              dataKey={bar => [bar.low, bar.high]}
              shape={props => <CandlestickBar {...props} />}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      </>}
    </div>
  )
}
