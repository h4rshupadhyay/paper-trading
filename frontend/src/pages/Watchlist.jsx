import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Star, Trash2, TrendingUp, TrendingDown,
  RefreshCw, ShoppingCart, Plus, X, Loader2,
} from 'lucide-react'
import Header from '../components/Header'
import ResourceError from '../components/ResourceError'
import OrderForm from '../components/OrderForm'
import { SkeletonTable } from '../components/LoadingSkeleton'
import TickerInput from '../components/TickerInput'
import { watchlistAPI, stocksAPI } from '../services/api'
import { useRegion, tickerCurrency } from '../context/RegionContext'

export default function Watchlist() {
  const navigate = useNavigate()

  const [items, setItems]             = useState([])
  const [folders, setFolders]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)
  const [actionError, setActionError] = useState(null)
  const [removing, setRemoving]       = useState(null)
  const [orderTarget, setOrderTarget] = useState(null)
  const [addTicker, setAddTicker]     = useState('')
  const [addError, setAddError]       = useState(null)
  const [adding, setAdding]           = useState(false)
  const [toast, setToast]             = useState(null)

  // Tab state — null = "Watchlist" (uncategorised)
  const [activeTab, setActiveTab]         = useState(null)
  const [renamingTab, setRenamingTab]     = useState(null)
  const [renamingFolder, setRenamingFolder] = useState(false)
  const [renameVal, setRenameVal]         = useState('')
  const [showNewTab, setShowNewTab]       = useState(false)
  const [newTabName, setNewTabName]       = useState('')
  const [folderError, setFolderError] = useState(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [addToFolderId, setAddToFolderId]   = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500) }

  const fetchWatchlist = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await watchlistAPI.get()
      setItems(data.watchlist || [])
      const newFolders = data.folders || []
      setFolders(newFolders)
      // If active tab was deleted, fall back to uncategorised
      setActiveTab((prev) => {
        if (prev === null) return null
        return newFolders.find((f) => f.folder_id === prev) ? prev : null
      })
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load watchlist')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchWatchlist() }, [fetchWatchlist])

  useEffect(() => { setAddToFolderId(activeTab) }, [activeTab])

  const handleRemove = async (watchlist_id) => {
    setActionError(null)
    setRemoving(watchlist_id)
    try {
      await watchlistAPI.removeItem(watchlist_id)
      setItems((prev) => prev.filter((i) => i.watchlist_id !== watchlist_id))
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to remove entry. Try again.')
    } finally { setRemoving(null) }
  }

  const handleAdd = async (e) => {
    e.preventDefault()
    const t = addTicker.trim().toUpperCase()
    if (!t) return
    setAdding(true)
    setAddError(null)
    try {
      await watchlistAPI.add(t, addToFolderId)
      setAddTicker('')
      await fetchWatchlist()
    } catch (err) {
      setAddError(err.response?.data?.error || `Failed to add ${t}`)
    } finally {
      setAdding(false)
    }
  }

  const handleOrderSuccess = () => { setOrderTarget(null); fetchWatchlist() }

  const openOrder = async (ticker) => {
    try {
      const { data } = await stocksAPI.quote(ticker)
      setOrderTarget({ ticker, price: data.price })
    } catch (_) {
      setOrderTarget({ ticker, price: null })
    }
  }

  // ── Folder CRUD ───────────────────────────────────────────────────────────

  const handleCreateFolder = async () => {
    const name = newTabName.trim()
    if (!name || creatingFolder) return
    setFolderError(null)
    setCreatingFolder(true)
    try {
      const { data } = await watchlistAPI.createFolder(name)
      setShowNewTab(false)
      setNewTabName('')
      await fetchWatchlist()
      setActiveTab(data.folder_id)   // jump to the new tab
      showToast(`List "${name}" created`)
    } catch (err) {
      setFolderError(err.response?.data?.error || 'Failed to create list. Try again.')
    } finally {
      setCreatingFolder(false)
    }
  }

  const handleRenameTab = async (folder_id) => {
    const name = renameVal.trim()
    if (!name || renamingFolder) return
    setActionError(null)
    setRenamingFolder(true)
    try {
      await watchlistAPI.renameFolder(folder_id, name)
      setRenamingTab(null)
      await fetchWatchlist()
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to rename list. Try again.')
    } finally { setRenamingFolder(false) }
  }

  const handleDeleteTab = async (folder_id, name, e) => {
    e.stopPropagation()
    if (!window.confirm(`Delete list "${name}"? Items will become Uncategorised.`)) return
    try {
      await watchlistAPI.deleteFolder(folder_id)
      if (activeTab === folder_id) setActiveTab(null)
      showToast('List deleted')
      await fetchWatchlist()
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to delete list')
    }
  }

  const { formatPrice } = useRegion()
  const fmtPrice = (n, ticker) => formatPrice(n, { from: tickerCurrency(ticker) })

  const tabs = [{ folder_id: null, name: 'All' }, ...folders]

  const activeItems = activeTab === null
    ? items
    : items.filter((i) => i.folder_id === activeTab)

  return (
    <div className="page-layout">
      <Header title="Watchlist" />

      <main className="page-content">
        {/* Add ticker */}
        <section className="card">
          <h2 className="card-title">Add to Watchlist</h2>
          <form className="add-ticker-form" onSubmit={handleAdd}>
            <TickerInput
              value={addTicker}
              onChange={setAddTicker}
              onSelect={(t) => setAddTicker(t)}
              placeholder="Search ticker (e.g. RELIANCE.NS)"
              disabled={adding}
            />
            {folders.length > 0 && (
              <select
                className="folder-select"
                value={addToFolderId ?? ''}
                onChange={(e) => setAddToFolderId(e.target.value === '' ? null : e.target.value)}
                disabled={adding}
              >
                <option value="">Uncategorised</option>
                {folders.map((f) => (
                  <option key={f.folder_id} value={f.folder_id}>{f.name}</option>
                ))}
              </select>
            )}
            <button type="submit" className="btn btn-primary" disabled={adding}>
              <Plus size={15} /> Add
            </button>
          </form>
          {addError && <p className="form-error" style={{ marginTop: '0.5rem' }}>{addError}</p>}
        </section>

        {/* Watchlist with Kite-style tabs */}
        <section className="card wl-card">
          {/* Tab bar */}
          <div className="wl-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.folder_id ?? 'none'}
                className={`wl-tab ${activeTab === tab.folder_id ? 'active' : ''}`}
                onClick={() => { if (renamingTab === null || renamingTab !== tab.folder_id) setActiveTab(tab.folder_id) }}
                onDoubleClick={() => {
                  if (tab.folder_id === null) return
                  setRenamingTab(tab.folder_id)
                  setRenameVal(tab.name)
                }}
              >
                {renamingTab !== null && renamingTab === tab.folder_id ? (
                  <input
                    className="wl-tab-rename"
                    disabled={renamingFolder}
                    value={renameVal}
                    autoFocus
                    style={{ width: Math.max(60, renameVal.length * 8) + 'px' }}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onBlur={() => handleRenameTab(tab.folder_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameTab(tab.folder_id)
                      if (e.key === 'Escape') setRenamingTab(null)
                      e.stopPropagation()
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="wl-tab-name">{tab.name}</span>
                    <span className="wl-tab-count">
                      {tab.folder_id === null
                        ? items.length
                        : items.filter((i) => i.folder_id === tab.folder_id).length}
                    </span>
                    {tab.folder_id !== null && (
                      <span
                        className="wl-tab-x"
                        title="Delete list"
                        onClick={(e) => handleDeleteTab(tab.folder_id, tab.name, e)}
                      >
                        <X size={10} />
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}

            <button
              className="wl-tab-add"
              onClick={() => { setFolderError(null); setShowNewTab(true) }}
              title="New list"
            >
              <Plus size={14} />
            </button>

            <div className="wl-tabs-spacer" />
            <button className="icon-btn wl-refresh" onClick={fetchWatchlist} title="Refresh">
              <RefreshCw size={13} />
            </button>
          </div>

          {/* Tab content */}
          <div className="wl-content">
            <ResourceError message={error} onRetry={fetchWatchlist} retryLabel="Retry watchlist" />
            <ResourceError message={actionError} />

            {loading ? (
              <div style={{ padding: '16px' }}><SkeletonTable rows={6} cols={5} /></div>
            ) : activeItems.length === 0 && !error ? (
              <div className="empty-state">
                <Star size={36} opacity={0.25} />
                <p>This list is empty. Add tickers above.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Stock</th>
                      <th>Price</th>
                      <th>Added</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeItems.map((item) => (
                      <tr key={item.watchlist_id}>
                        <td>
                          <div
                            className="stock-cell clickable"
                            onClick={() => navigate(`/stocks/${item.ticker}`)}
                          >
                            <span className="ticker-badge">{item.ticker}</span>
                            <span className="company-name">{item.company_name}</span>
                          </div>
                        </td>
                        <td className="fw-medium">{fmtPrice(item.price, item.ticker)}</td>
                        <td className="text-muted">
                          {item.added_at ? new Date(item.added_at).toLocaleDateString() : '—'}
                        </td>
                        <td>
                          <div className="action-btns">
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => openOrder(item.ticker)}
                              title="Trade"
                            >
                              <ShoppingCart size={13} />
                            </button>
                            <button
                              className="btn btn-sm btn-ghost btn-danger"
                              onClick={() => handleRemove(item.watchlist_id)}
                              disabled={removing === item.watchlist_id}
                              title="Remove from this list"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {orderTarget && (
          <OrderForm
            ticker={orderTarget.ticker}
            price={orderTarget.price}
            onClose={() => setOrderTarget(null)}
            onSuccess={handleOrderSuccess}
          />
        )}

        {showNewTab && (
          <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && (setShowNewTab(false), setNewTabName(''))}>
            <div className="modal-card" style={{ maxWidth: 320 }}>
              <div className="modal-header">
                <span className="modal-ticker">New List</span>
                <button className="modal-close" onClick={() => { setShowNewTab(false); setNewTabName('') }}>
                  <X size={18} />
                </button>
              </div>
              <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <ResourceError message={folderError} />
                <label className="form-label">
                  List name
                  <input
                    className="form-input"
                    placeholder="e.g. Tech Stocks"
                    value={newTabName}
                    onChange={(e) => setNewTabName(e.target.value)}
                    autoFocus
                    disabled={creatingFolder}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateFolder()
                      if (e.key === 'Escape') { setShowNewTab(false); setNewTabName('') }
                    }}
                  />
                </label>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" type="button" onClick={() => { setShowNewTab(false); setNewTabName('') }}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={handleCreateFolder}
                    disabled={creatingFolder || !newTabName.trim()}
                  >
                    {creatingFolder ? <Loader2 size={14} className="spin" /> : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {toast && <div className="toast success">{toast}</div>}
    </div>
  )
}
