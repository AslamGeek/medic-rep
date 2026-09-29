import { useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'

export function AboutPage({ onClose, onReset }: { onClose: () => void; onReset: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const reset = async () => {
    setBusy(true)
    setMessage('')
    try {
      await onReset()
      setMessage('Local cache refreshed from Sheets.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cache refresh failed.')
    } finally { setBusy(false) }
  }
  return <div className="full-screen-layer" role="dialog" aria-modal="true" aria-label="Settings">
    <header className="modal-appbar">
      <button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close settings"><ArrowLeft size={21} /></button>
      <h2>Settings</h2>
    </header>
    <main className="detail-content">
      <section className="detail-card">
        <h3>Local data</h3>
        <p>Clear all locally stored records, pending edits, saved presets and preferences, then load fresh data from Sheets. Pending edits will be discarded.</p>
        <p>Requires internet. If fresh data cannot be loaded, your current cache is kept.</p>
        <button className="primary-button" disabled={busy} onClick={() => void reset()}>
          <RefreshCw size={18} className={busy ? 'spin' : ''} />{busy ? 'Refreshing…' : 'Clear Local Cache & Refresh'}
        </button>
        {message && <p role="status">{message}</p>}
      </section>
    </main>
  </div>
}
