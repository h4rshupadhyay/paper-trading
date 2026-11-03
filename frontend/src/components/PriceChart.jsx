import { useState, useEffect } from 'react'
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
  up:     '#00b386',
  down:   '#e84040',
  line:   '#387ed1',
  volume: '#6c757d',
  grid:   'rgba(255,255,255,0.06)',
}

function CandlestickBar(props) {
  const { x, y, width, height, low, high, open, close } = props
  const isUp    = close >= open
  const color   = isUp ? COLORS.up : COLORS.down
  const barX    = x + width * 0.1
  const barW    = width * 0.8

  return (
    <g>
      {/* Wick */}
      <line x1={x + width / 2} y1={y} x2={x + width / 2} y2={y + height}
        stroke={color} strokeWidth={1} />
      {/* Body */}
      <rect x={barX} y={Math.min(open, close)} width={barW}
        height={Math.max(Math.abs(close - open), 1)}
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

export default function PriceChart({ ticker }) {
  const { formatPrice } = useRegion()
  const priceCurr = tickerCurrency(ticker)
  const fp = (n) => n != null ? formatPrice(n, { from: priceCurr }) : '—'

  const [data, setData]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [period, setPeriod]   = useState(PERIODS[2])   // default 1M
  const [chartType, setChartType] = useState('line')   // line | candlestick

  useEffect(() => {
    if (!ticker) return
    setLoading(true)
    setError(null)
    stocksAPI.history(ticker, period.value, period.interval)
      .then(({ data: res }) => {
        const formatted = (res.data || []).map((d) => ({
          ...d,
          label: period.value === '1d' || period.value === '5d'
            ? new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : new Date(d.time).toLocaleDateString([], { month: 'short', day: 'numeric' }),
        }))
        setData(formatted)
      })
      .catch((e) => setError(e.response?.data?.error || 'Failed to load chart data'))
      .finally(() => setLoading(false))
  }, [ticker, period])

  if (loading) return <SkeletonChart />
  if (error)   return <div className="chart-error">{error}</div>
  if (!data.length) return <div className="chart-empty">No chart data available</div>

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

      {/* Chart */}
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} />
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
          <Bar
            yAxisId="volume"
            dataKey="volume"
            fill={COLORS.volume}
            opacity={0.35}
            radius={[2, 2, 0, 0]}
          />

          {/* Price */}
          {chartType === 'line' ? (
            <Line
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
              dataKey="close"
              shape={(props) => {
                const { x, y, width, height, payload } = props
                const scale = (v) =>
                  y + height - ((v - minPrice) / (maxPrice - minPrice)) * (300 * 0.7)
                return (
                  <CandlestickBar
                    x={x} y={scale(payload.high)}
                    width={width}
                    height={Math.abs(scale(payload.low) - scale(payload.high))}
                    open={scale(payload.open)}
                    close={scale(payload.close)}
                    low={scale(payload.low)}
                    high={scale(payload.high)}
                  />
                )
              }}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
