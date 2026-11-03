import { stocksAPI } from './api'

// Successful results live until page reload; concurrent consumers share one request.
let catalogue = null
let pending = null

export function loadTickerCatalogue() {
  if (catalogue !== null) return Promise.resolve(catalogue)
  if (!pending) {
    pending = stocksAPI.catalogue()
      .then(({ data }) => { catalogue = data; return data })
      .finally(() => { pending = null })
  }
  return pending
}

export function filterTickers(tickers, query, regionId, limit) {
  const upper = query.toUpperCase()
  const lower = query.toLowerCase()
  const exact = [], prefix = [], contains = []

  for (const ticker of tickers) {
    if (ticker.r && ticker.r !== regionId) continue
    const symbol = ticker.s.toUpperCase()
    const name = ticker.n.toLowerCase()
    if (symbol === upper) exact.push(ticker)
    else if (symbol.startsWith(upper) || name.startsWith(lower)) prefix.push(ticker)
    else if (symbol.includes(upper) || name.includes(lower)) contains.push(ticker)
    if (exact.length + prefix.length + contains.length >= limit) break
  }
  return [...exact, ...prefix, ...contains].slice(0, limit)
}
