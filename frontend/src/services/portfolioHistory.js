import { displayNumber } from './contracts.js'

export const PORTFOLIO_PERIODS = [
  { label: '1D', value: '1d' }, { label: '5D', value: '5d' },
  { label: '1M', value: '1mo' }, { label: '3M', value: '3mo' },
  { label: '6M', value: '6mo' }, { label: '1Y', value: '1y' },
  { label: '5Y', value: '5y' },
]

export function adaptPortfolioHistory(data) {
  return { ...data, firstValue: displayNumber(data.firstValue), lastValue: displayNumber(data.lastValue),
    snapshots: (data.items || []).map(item => ({ ...item,
      snapshot_at: item.sampledAt, date: item.sampledAt, time: Date.parse(item.sampledAt),
      total_value: displayNumber(item.totalValue), cash_balance: displayNumber(item.cashBalance),
      holdings_value: displayNumber(item.holdingsValue),
    })),
  }
}

export function portfolioTick(value, period) {
  const date = new Date(value)
  const options = period === '1d' || period === '5d'
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : period === '5y' ? { month: 'short', year: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return date.toLocaleString(undefined, options)
}

export function portfolioTooltipDate(value) {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
