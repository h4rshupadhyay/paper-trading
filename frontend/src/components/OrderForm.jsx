import { useState, useRef, useId } from 'react'
import { tradingAPI, pendingOrdersAPI } from '../services/api'
import { useSymbolQuote } from '../hooks/useMarketStream'
import { mergeQuote } from '../services/quoteStream'
import { useAuth } from '../context/AuthContext'
import { useRegion, tickerCurrency } from '../context/RegionContext'

/**
 * OrderForm — Zerodha-style buy/sell console.
 * Props:
 *   ticker       string
 *   price        number  (current market price)
 *   initialSide  'buy' | 'sell'  (default 'buy')
 *   onClose      fn()
 *   onSuccess    fn(result)
 */

const PRODUCT_TYPES = [
  { id: 'CNC', label: 'CNC' },
]

const ORDER_TYPES = [
  { id: 'MARKET',     label: 'MARKET' },
  { id: 'LIMIT',      label: 'LIMIT'  },
  { id: 'STOP_LIMIT', label: 'SL'     },
  { id: 'STOP',       label: 'SL-M'   },
]

export default function OrderForm({ ticker, price: initialPrice, initialSide = 'buy', onClose, onSuccess }) {
  const [streamQuote, setStreamQuote] = useState(null)
  useSymbolQuote(ticker, packet => setStreamQuote(current => mergeQuote(current, packet)))
  const price = streamQuote?.price ?? initialPrice
  const formId = useId()
  const { refreshUser }          = useAuth()
  const { formatPrice }          = useRegion()
  const priceCurr                = tickerCurrency(ticker)
  const fp = (n) => n != null ? formatPrice(n, { from: priceCurr }) : '—'

  const [side, setSide]             = useState(initialSide)
  const [productType, setProduct]   = useState('CNC')
  const [orderType, setOrderType]   = useState('MARKET')
  const [quantity, setQty]          = useState('')
  const [limitPrice, setLimit]      = useState('')
  const [stopPrice, setStop]        = useState('')
  const [disclosedQty, setDisclosed]= useState('0')
  const [showMore, setShowMore]     = useState(false)
  const [expiresAt, setExpiry]      = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)

  const attempt = useRef(null)
  const qty       = Number(quantity) || 0
  const isBuy     = side === 'buy'
  const isMarket  = orderType === 'MARKET'
  const isStop    = orderType === 'STOP'       // SL-M: trigger only
  const isSL      = orderType === 'STOP_LIMIT' // SL:   trigger + limit
  const priceDisabled  = isMarket || isStop
  const triggerEnabled = isStop || isSL

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!/^\d+(\.\d{1,4})?$/.test(quantity) || qty <= 0) { setError('Quantity must be positive'); return }

    setLoading(true)
    setError(null)
    try {
      const fingerprint=JSON.stringify({ticker,side,orderType,quantity,limitPrice,stopPrice,expiresAt})
      if(attempt.current?.fingerprint!==fingerprint)attempt.current={fingerprint,key:crypto.randomUUID()}
      const key=attempt.current.key
      if (isMarket) {
        if (!price) { setError('Price unavailable — try again'); setLoading(false); return }
        const fn       = isBuy ? tradingAPI.buy : tradingAPI.sell
        const { data } = await fn(ticker, quantity, key)
        onSuccess?.({ ...data, message: data.order?.status === 'FILLED' ? 'Order filled' : 'Order placed' })
        onClose?.()
        // Execution is already durable. A display refresh cannot change its outcome.
        void refreshUser().catch(() => {})
      } else {
        // Validate required prices per order type
        if ((orderType === 'LIMIT' || isSL) && !limitPrice) {
          setError('Limit price is required'); setLoading(false); return
        }
        if (triggerEnabled && !stopPrice) {
          setError('Trigger price is required'); setLoading(false); return
        }
        const payload = {
          ticker:     ticker.toUpperCase(),
          side:       side.toUpperCase(),
          order_type: orderType,
          quantity,
          idempotencyKey:key,
        }
        if ((isSL || orderType === 'LIMIT') && limitPrice) payload.limit_price = limitPrice
        if (triggerEnabled && stopPrice)                    payload.stop_price  = stopPrice
        if (expiresAt)                                      payload.expires_at  = new Date(expiresAt).toISOString()
        await pendingOrdersAPI.place(payload)
        onSuccess?.({ message: `${ORDER_TYPES.find(t => t.id === orderType)?.label} order placed` })
        onClose?.()
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Order failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const toggleSide = () => { setSide(s => s === 'buy' ? 'sell' : 'buy'); setError(null) }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <form className="zk-card" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className={`zk-header ${side}`}>
          <div className="zk-header-left">
            <span className="zk-side-label">{isBuy ? 'Buy' : 'Sell'}</span>
            <span className="zk-ticker-name">{ticker}</span>
            <span className="zk-header-price">{fp(price)}</span>
          </div>
          <label className="zk-toggle-wrap" title="Switch Buy / Sell">
            <input type="checkbox" aria-label="Buy order" checked={isBuy} onChange={toggleSide} />
            <span className="zk-toggle-track">
              <span className="zk-toggle-thumb" />
            </span>
          </label>
        </div>

        {/* ── Controls: product type + order type ── */}
        <div className="zk-controls">
          <div className="zk-radios">
            {PRODUCT_TYPES.map(p => (
              <label key={p.id} className={`zk-radio${productType === p.id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="productType"
                  checked={productType === p.id}
                  onChange={() => setProduct(p.id)}
                />
                {p.label}
              </label>
            ))}
          </div>
          <div className="zk-radios zk-radios-right">
            {ORDER_TYPES.map(t => (
              <label key={t.id} className={`zk-radio${orderType === t.id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="orderType"
                  checked={orderType === t.id}
                  onChange={() => { setOrderType(t.id); setError(null) }}
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>

        {/* ── Input grid ── */}
        <div className="zk-inputs">
          <div className="zk-field">
            <label htmlFor={`${formId}-quantity`}>Qty.</label>
            <input
              id={`${formId}-quantity`}
              type="number"
              min="0.0001"
              step="0.0001"
              value={quantity}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              autoFocus
            />
          </div>
          <div className="zk-field">
            <label htmlFor={`${formId}-price`}>Price</label>
            <input
              id={`${formId}-price`}
              type="number"
              min="0"
              step="any"
              value={priceDisabled ? '0' : limitPrice}
              onChange={(e) => setLimit(e.target.value)}
              disabled={priceDisabled}
              placeholder="0"
            />
          </div>
          <div className="zk-field">
            <label htmlFor={`${formId}-trigger`}>Trigger price</label>
            <input
              id={`${formId}-trigger`}
              type="number"
              min="0"
              step="any"
              value={triggerEnabled ? stopPrice : '0'}
              onChange={(e) => setStop(e.target.value)}
              disabled={!triggerEnabled}
              placeholder="0"
            />
          </div>

        </div>

        {/* ── More options (expander) ── */}
        {showMore && (
          <div className="zk-more-body">
            <div className="zk-field zk-field-wide">
              <label htmlFor={`${formId}-expiry`}>Expires At <span className="zk-optional">(optional)</span></label>
              <input
                id={`${formId}-expiry`}
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </div>
          </div>
        )}

        {showMore && <p className="text-muted order-rules">Limit and stop prices use {priceCurr || 'the stock currency'}. Pending orders reserve no cash or shares.</p>}
        {error && <p className="zk-error">{error}</p>}

        {/* ── Footer ── */}
        <div className="zk-footer">
          <button
            type="button"
            className="zk-more-btn"
            onClick={() => setShowMore(v => !v)}
          >
            {showMore ? 'Hide options' : 'More options'}
          </button>
          <div className="zk-footer-actions">
            <button
              type="submit"
              className={`zk-btn-submit ${side}`}
              disabled={loading || qty <= 0}
            >
              {loading ? '...' : isBuy ? 'Buy' : 'Sell'}
            </button>
            <button type="button" className="zk-btn-cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>

      </form>
    </div>
  )
}
