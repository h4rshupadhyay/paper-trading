import { useState, useEffect, useCallback, useRef } from 'react'
import {
  FileText, Plus, Trash2, Save, Tag, X, Loader2,
} from 'lucide-react'
import Header from '../components/Header'
import TickerInput from '../components/TickerInput'
import { notesAPI } from '../services/api'

export default function Notes() {
  const [notes, setNotes]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [selected, setSelected]     = useState(null)   // note object in editor
  const [isNew, setIsNew]           = useState(false)
  const [saving, setSaving]         = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [toast, setToast]           = useState(null)
  const editorRequest = useRef(0)
  useEffect(() => () => { editorRequest.current += 1 }, [])

  // editor fields
  const [title, setTitle]           = useState('')
  const [body, setBody]             = useState('')
  const [ticker, setTicker]         = useState('')

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await notesAPI.list()
      setNotes(data)
    } catch (_) {}
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchList() }, [fetchList])

  const openNote = async (stub) => {
    const request = ++editorRequest.current
    setIsNew(false)
    try {
      const { data } = await notesAPI.get(stub.note_id)
      if (request !== editorRequest.current) return
      setSelected(data)
      setTitle(data.title)
      setBody(data.body || '')
      setTicker(data.ticker || '')
    } catch (_) {}
  }

  const startNew = () => {
    editorRequest.current += 1
    setSelected(null)
    setIsNew(true)
    setTitle('')
    setBody('')
    setTicker('')
  }

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      if (isNew) {
        const { data } = await notesAPI.create(
          title.trim(), body, ticker.trim().toUpperCase() || undefined,
        )
        setSelected(data)
        setIsNew(false)
        await fetchList()
        showToast('Note created')
      } else {
        const { data } = await notesAPI.update(selected.note_id, title.trim(), body)
        setSelected(data)
        setNotes((prev) =>
          prev.map((n) =>
            n.note_id === data.note_id
              ? { ...n, title: data.title, updated_at: data.updated_at }
              : n,
          ),
        )
        showToast('Note saved')
      }
    } catch (_) {}
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!selected) return
    if (!window.confirm('Delete this note?')) return
    setDeleting(true)
    try {
      await notesAPI.delete(selected.note_id)
      setNotes((prev) => prev.filter((n) => n.note_id !== selected.note_id))
      setSelected(null)
      setIsNew(false)
      showToast('Note deleted')
    } catch (_) {}
    finally { setDeleting(false) }
  }

  const closeEditor = () => {
    editorRequest.current += 1
    setSelected(null)
    setIsNew(false)
  }

  const hasEditor = isNew || selected

  return (
    <div className="page-layout">
      <Header title="Notes" />
      <main className="page-content">
        <div className="notes-layout">

          {/* ── List panel ── */}
          <div className="notes-list-panel">
            <div className="notes-list-header">
              <span className="card-title">
                <FileText size={15} style={{ marginRight: 6 }} />
                My Notes
              </span>
              <button className="btn btn-primary btn-sm" onClick={startNew}>
                <Plus size={14} /> New
              </button>
            </div>

            {loading ? (
              <div className="notes-loading">
                <Loader2 size={20} className="spin" />
              </div>
            ) : notes.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 16px' }}>
                <FileText size={32} opacity={0.3} />
                <p>No notes yet. Click New to create one.</p>
              </div>
            ) : (
              <ul className="notes-list">
                {notes.map((n) => (
                  <li
                    key={n.note_id}
                    className={`note-item ${selected?.note_id === n.note_id ? 'active' : ''}`}
                    onClick={() => openNote(n)}
                  >
                    <div className="note-item-title">{n.title}</div>
                    <div className="note-item-meta">
                      {n.ticker && (
                        <span className="ticker-badge" style={{ fontSize: '0.7rem' }}>
                          {n.ticker}
                        </span>
                      )}
                      <span className="text-muted" style={{ fontSize: '0.72rem' }}>
                        {n.updated_at
                          ? new Date(n.updated_at).toLocaleDateString()
                          : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Editor panel ── */}
          {hasEditor ? (
            <div className="notes-editor-panel card">
              <div className="notes-editor-header">
                <input
                  className="note-title-input"
                  placeholder="Note title…"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                />
                <div className="notes-editor-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleSave}
                    disabled={saving || !title.trim()}
                  >
                    {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                    Save
                  </button>
                  {selected && (
                    <button
                      className="btn btn-sm btn-ghost btn-danger"
                      onClick={handleDelete}
                      disabled={deleting}
                      title="Delete note"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={closeEditor}
                    title="Close"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>

              {/* Optional ticker tag */}
              <div className="note-ticker-row">
                <Tag size={13} style={{ color: 'var(--text-muted)' }} />
                {isNew ? (
                  <TickerInput
                    value={ticker}
                    onChange={setTicker}
                    onSelect={setTicker}
                    placeholder="Link to ticker (optional)"
                    className="note-ticker-input-wrap"
                  />
                ) : (
                  <input
                    className="note-ticker-input"
                    value={ticker}
                    disabled
                  />
                )}
              </div>

              <textarea
                className="note-body"
                placeholder="Write your note here…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          ) : (
            <div className="notes-editor-panel card notes-empty-editor">
              <FileText size={36} opacity={0.15} />
              <p>Select a note or create a new one</p>
            </div>
          )}
        </div>
      </main>

      {toast && <div className="toast success">{toast}</div>}
    </div>
  )
}
