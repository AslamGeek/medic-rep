import { Check, CloudOff, Hourglass, RefreshCw, WifiOff } from 'lucide-react'
import type { SyncDetail } from '../sync'

export function SyncStatus({ detail, onRetry }: { detail: SyncDetail; onRetry: () => void }) {
  const content = detail.phase === 'offline'
    ? { icon: <WifiOff size={13} />, label: detail.pending ? 'Pending changes · Offline' : 'Offline', style: 'offline' }
    : detail.phase === 'syncing'
    ? { icon: <RefreshCw className="spin" size={13} />, label: detail.activity === 'saving' ? 'Pending changes' : 'Refreshing…', style: 'pending' }
    : detail.phase === 'error'
    ? { icon: <CloudOff size={13} />, label: 'Sync failed', style: 'error' }
    : detail.pending
    ? { icon: <Hourglass size={13} />, label: 'Pending changes', style: 'pending' }
    : detail.verified
    ? { icon: <Check size={13} />, label: 'Synced', style: 'idle' }
    : { icon: <RefreshCw size={13} />, label: 'Refresh to verify', style: 'pending' }
  return <button type="button" className={`sync-badge ${content.style}`}
    title={detail.message || 'Sync with Google Sheets'}
    aria-label={`${content.label}. Tap to sync with Google Sheets.`}
    disabled={detail.phase === 'syncing'} onClick={onRetry}>
    {content.icon}<span>{content.label}</span>
  </button>
}
