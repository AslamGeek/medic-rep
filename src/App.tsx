import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarDays,
  Check,
  CloudOff,
  Download,
  MapPin,
  Moon,
  Plus,
  RefreshCw,
  Stethoscope,
  Sun,
  Users,
  WifiOff,
  X,
} from 'lucide-react'
import './App.css'
import {
  APP_NAME,
  UNDO_WINDOW_MS,
} from './config'
import { db, DEFAULT_MASTER, loadSnapshot } from './db'
import { Directory } from './components/Directory'
import { DoctorDetail } from './components/DoctorDetail'
import { DoctorForm } from './components/DoctorForm'
import { Visits } from './components/Visits'
import { onSyncStatus, queueChange, syncNow, type SyncDetail } from './sync'
import { formatDate, localDateString, normalize } from './utils'
import {
  EMPTY_FILTERS,
  type AppSnapshot,
  type Doctor,
  type FilterPreset,
  type FilterState,
  type Visit,
} from './types'

type Section = 'directory' | 'visits'
type Theme = 'light' | 'dark'
const DAILY_CAMP_STORAGE_KEY = 'medrep-daily-camp'
const DEFAULT_CALL_SCHEDULE = 'Everyday'

function readDailyCamp(): string {
  try {
    const stored = JSON.parse(localStorage.getItem(DAILY_CAMP_STORAGE_KEY) || '{}') as {
      date?: string
      camp?: string
    }
    const date = localDateString()
    if (stored.date === date && stored.camp) return stored.camp
    localStorage.removeItem(DAILY_CAMP_STORAGE_KEY)
  } catch {
    localStorage.removeItem(DAILY_CAMP_STORAGE_KEY)
  }
  return ''
}

function saveDailyCamp(camp: string) {
  if (!camp) {
    localStorage.removeItem(DAILY_CAMP_STORAGE_KEY)
    return
  }
  const date = localDateString()
  localStorage.setItem(DAILY_CAMP_STORAGE_KEY, JSON.stringify({ date, camp }))
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface ToastState {
  id: string
  message: string
  durationMs?: number
  actionLabel?: string
  action?: () => void
}

const EMPTY_SNAPSHOT: AppSnapshot = {
  doctors: [],
  visits: [],
  master: DEFAULT_MASTER,
  presets: [],
  pendingCount: 0,
}

function SyncBadge({
  detail,
  onRetry,
}: {
  detail: SyncDetail
  onRetry: () => void
}) {
  const content = (() => {
    if (detail.phase === 'offline') return { icon: <WifiOff size={13} />, label: detail.pending ? `${detail.pending} offline` : 'Offline' }
    if (detail.phase === 'syncing') return { icon: <RefreshCw className="spin" size={13} />, label: detail.activity === 'saving' ? 'Saving to Sheets' : 'Refreshing' }
    if (detail.phase === 'error') return { icon: <CloudOff size={13} />, label: detail.pending ? `${detail.pending} pending` : 'Refresh failed' }
    if (detail.pending) return { icon: <RefreshCw size={13} />, label: `${detail.pending} queued` }
    return { icon: <Check size={13} />, label: 'Saved to Sheets' }
  })()
  return (
    <button
      type="button"
      className={`sync-badge ${detail.phase}`}
      title={detail.message || 'Sync with Google Sheets'}
      aria-label={`${content.label}. Tap to sync with Google Sheets.`}
      disabled={detail.phase === 'syncing'}
      onClick={onRetry}
    >
      {content.icon}<span>{content.label}</span>
    </button>
  )
}

function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, toast.durationMs ?? UNDO_WINDOW_MS)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.durationMs, onClose])
  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.action && <button onClick={() => { toast.action?.(); onClose() }}>{toast.actionLabel}</button>}
      <button className="toast-close" onClick={onClose} aria-label="Dismiss"><X size={15} /></button>
    </div>
  )
}

function App() {
  const [section, setSection] = useState<Section>('directory')
  const [barsHidden, setBarsHidden] = useState(false)
  const lastScrollY = useRef(0)
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [syncDetail, setSyncDetail] = useState<SyncDetail>({
    phase: navigator.onLine ? 'syncing' : 'offline',
    activity: 'refreshing',
    pending: 0,
  })
  const [dailyCamp, setDailyCamp] = useState(readDailyCamp)
  const dailyCampInitialized = useRef(Boolean(dailyCamp))
  const [visitsContextVersion, setVisitsContextVersion] = useState(0)
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...structuredClone(EMPTY_FILTERS),
    camp: dailyCamp ? [dailyCamp] : [],
    callSchedule: [DEFAULT_CALL_SCHEDULE],
  }))
  const [editingDoctor, setEditingDoctor] = useState<Doctor | null | undefined>(undefined)
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null)
  const [focusDoctorId, setFocusDoctorId] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('medrep-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  const acceptSnapshot = useCallback((data: AppSnapshot) => {
    setSnapshot(data)
    const firstCamp = data.master.settings.camps[0]
    if (!dailyCampInitialized.current && firstCamp) {
      dailyCampInitialized.current = true
      setDailyCamp(firstCamp)
      saveDailyCamp(firstCamp)
      setFilters((current) => current.camp.length ? current : { ...current, camp: [firstCamp] })
      setVisitsContextVersion((current) => current + 1)
    }
  }, [])

  const reload = useCallback(async () => {
    acceptSnapshot(await loadSnapshot())
  }, [acceptSnapshot])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('medrep-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!dailyCamp) return
    const clearExpiredDailyCamp = () => {
      if (readDailyCamp()) return
      dailyCampInitialized.current = false
      setDailyCamp('')
      setFilters((current) => {
        const stillUsingDailyDefault = current.camp.length === 1
          && current.camp[0].toLocaleLowerCase() === dailyCamp.toLocaleLowerCase()
        return stillUsingDailyDefault ? { ...current, camp: [] } : current
      })
      setFocusDoctorId(null)
      setVisitsContextVersion((current) => current + 1)
    }
    const timer = window.setInterval(clearExpiredDailyCamp, 60_000)
    window.addEventListener('focus', clearExpiredDailyCamp)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', clearExpiredDailyCamp)
    }
  }, [dailyCamp])

  useEffect(() => {
    let frame = 0
    const updateBars = () => {
      const currentScrollY = Math.max(0, window.scrollY)
      const movement = currentScrollY - lastScrollY.current

      if (currentScrollY <= 16) {
        setBarsHidden(false)
        lastScrollY.current = currentScrollY
      } else if (movement > 8) {
        setBarsHidden(true)
        lastScrollY.current = currentScrollY
      } else if (movement < -8) {
        setBarsHidden(false)
        lastScrollY.current = currentScrollY
      }
      frame = 0
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateBars)
    }

    lastScrollY.current = Math.max(0, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    let active = true
    void loadSnapshot().then((data) => {
      if (!active) return
      acceptSnapshot(data)
      setLoading(false)
      setSyncDetail((current) => ({ ...current, pending: data.pendingCount }))
    })

    const removeSyncListener = onSyncStatus((detail) => {
      if (!active) return
      setSyncDetail(detail)
      void reload()
    })
    const online = () => void syncNow().then(reload)
    const offline = () => setSyncDetail((current) => ({ ...current, phase: 'offline' }))
    const visible = () => {
      if (document.visibilityState === 'visible') void syncNow().then(reload)
    }
    const beforeInstall = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('online', online)
    window.addEventListener('focus', online)
    window.addEventListener('offline', offline)
    window.addEventListener('beforeinstallprompt', beforeInstall)
    document.addEventListener('visibilitychange', visible)
    void syncNow().then(reload)

    return () => {
      active = false
      removeSyncListener()
      window.removeEventListener('online', online)
      window.removeEventListener('focus', online)
      window.removeEventListener('offline', offline)
      window.removeEventListener('beforeinstallprompt', beforeInstall)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [acceptSnapshot, reload])

  const showToast = useCallback((next: Omit<ToastState, 'id'>) => {
    setToast({ ...next, id: crypto.randomUUID() })
  }, [])

  const saveDoctor = async (doctor: Doctor) => {
    await queueChange('upsertDoctor', doctor.id, doctor)
    await reload()
    setEditingDoctor(undefined)
    setSelectedDoctor(doctor)
    showToast({ message: navigator.onLine ? 'Doctor updated. Saving to Sheets…' : 'Doctor saved on this device. Will send when online.', durationMs: 3_000 })
  }

  const undoVisit = async (visit: Visit) => {
    const savedVisit = await db.visits.get(visit.localId)
    // Keep save and undo ordered, including when the save request is in flight.
    await queueChange('undoVisit', visit.localId, { visit: savedVisit ?? visit })
    await reload()
    showToast({ message: 'Visit removed' })
  }

  const saveVisit = async (visit: Visit) => {
    await queueChange('saveVisit', visit.localId, visit)
    await reload()
    showToast({
      message: `${visit.kind === 'Visit' ? 'Visit bundle' : visit.kind} saved locally`,
      actionLabel: 'Undo',
      action: () => void undoVisit(visit),
    })
  }

  const savePreset = async (name: string, nextFilters: FilterState) => {
    const existing = snapshot.presets.find(
      (preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
    const preset: FilterPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      filters: structuredClone(nextFilters),
      updatedAt: new Date().toISOString(),
    }
    await db.presets.put(preset)
    await reload()
    showToast({ message: `Saved “${name}”` })
  }

  const deletePreset = async (id: string) => {
    await db.presets.delete(id)
    await reload()
  }

  const install = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') setInstallPrompt(null)
  }

  const logFromDoctor = (doctor: Doctor) => {
    setSelectedDoctor(null)
    setFocusDoctorId(doctor.id)
    setSection('visits')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const selectSection = (next: Section) => {
    setFocusDoctorId(null)
    setSection(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const chooseDailyCamp = (camp: string) => {
    dailyCampInitialized.current = true
    setDailyCamp(camp)
    saveDailyCamp(camp)
    setFilters((current) => ({ ...current, camp: camp ? [camp] : [] }))
    setFocusDoctorId(null)
    setVisitsContextVersion((current) => current + 1)
  }

  const activeDailyCamp = snapshot.master.settings.camps.find(
    (camp) => camp.toLocaleLowerCase() === dailyCamp.toLocaleLowerCase(),
  ) ?? ''

  const callSchedules = [...new Map([
    DEFAULT_CALL_SCHEDULE,
    ...snapshot.master.settings.callSchedules,
    ...snapshot.doctors.map((doctor) => doctor.callSchedule),
  ].map((value) => value.trim()).filter(Boolean).map((value) => [normalize(value), value])).values()]
  const activeCallSchedule = filters.callSchedule.length > 1
    ? '__multiple__'
    : callSchedules.find((value) => normalize(value) === normalize(filters.callSchedule[0])) ?? ''

  const needsApiSetup =
    syncDetail.phase === 'error' &&
    snapshot.master.settings.areas.length === 0 &&
    snapshot.doctors.length === 0

  return (
    <div className={`app-shell${barsHidden ? ' bars-hidden' : ''}`}>
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark"><Stethoscope size={21} /></div>
          <div><p className="eyebrow">Field companion</p><h1>{APP_NAME}</h1></div>
        </div>
        <div className="header-actions">
          {installPrompt && <button className="icon-button" onClick={install} aria-label="Install app"><Download size={19} /></button>}
          <SyncBadge
            detail={syncDetail}
            onRetry={() => void syncNow().then(reload)}
          />
          <button className="icon-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}>
            {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
          {section === 'directory' && (
            <button
              className="icon-button"
              onClick={() => setEditingDoctor(null)}
              aria-label="Add doctor"
              title="Add doctor"
            >
              <Plus size={21} />
            </button>
          )}
        </div>
      </header>

      {syncDetail.phase === 'error' && !needsApiSetup && (
        <div className="setup-banner" role="status">
          {syncDetail.message}
          {syncDetail.requiresAttention
            ? ' Your changes are kept on this device. Edit the named doctor to correct the selection, or refresh after updating the master list.'
            : syncDetail.pending ? ' Your changes are kept on this device and will retry automatically.' : ' Tap refresh to try again.'}
        </div>
      )}

      {needsApiSetup && (
        <div className="setup-banner">
          <CloudOff size={18} />
          <div><strong>Sheet sync unavailable</strong><p>Check your connection, then tap the cloud icon to try again. Your offline data remains available.</p></div>
        </div>
      )}

      <main className="main-content">
        {!loading && section === 'directory' && snapshot.master.settings.camps.length > 0 && (
          <div className="daily-filters">
          <label className="daily-camp-picker">
            <span className="daily-camp-icon"><MapPin size={17} /></span>
            <span className="daily-camp-copy">
              <strong>Today’s camp</strong>
              <small>{formatDate(localDateString())}</small>
            </span>
            <select
              aria-label="Set today's default camp"
              value={activeDailyCamp}
              onChange={(event) => chooseDailyCamp(event.target.value)}
            >
              {snapshot.master.settings.camps.map((camp) => (
                <option key={camp}>{camp}</option>
              ))}
            </select>
          </label>
          <label className="daily-camp-picker">
            <span className="daily-camp-icon"><CalendarDays size={17} /></span>
            <span className="daily-camp-copy">
              <strong>Call schedule</strong>
              <small>Filter doctors</small>
            </span>
            <select
              aria-label="Filter doctors by call schedule"
              value={activeCallSchedule}
              onChange={(event) => {
                const schedule = event.target.value
                setFilters((current) => ({ ...current, callSchedule: schedule ? [schedule] : [] }))
              }}
            >
              <option value="">All schedules</option>
              {filters.callSchedule.length > 1 && <option value="__multiple__" disabled>Multiple schedules</option>}
              {callSchedules.map((schedule) => <option key={schedule}>{schedule}</option>)}
            </select>
          </label>
          </div>
        )}
        {loading ? (
          <div className="app-loading"><div className="loading-mark"><Stethoscope size={25} /></div><strong>Opening your field desk…</strong></div>
        ) : section === 'directory' ? (
          <Directory
            doctors={snapshot.doctors}
            products={snapshot.master.products}
            settings={snapshot.master.settings}
            presets={snapshot.presets}
            filters={filters}
            onFiltersChange={setFilters}
            onAdd={() => setEditingDoctor(null)}
            onOpen={setSelectedDoctor}
            onSavePreset={(name, nextFilters) => void savePreset(name, nextFilters)}
            onDeletePreset={(id) => void deletePreset(id)}
          />
        ) : (
          <Visits
            key={visitsContextVersion}
            doctors={snapshot.doctors}
            visits={snapshot.visits}
            settings={snapshot.master.settings}
            defaultCamp={activeDailyCamp}
            focusDoctorId={focusDoctorId}
            onSave={saveVisit}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="Main navigation">
        <button className={section === 'directory' ? 'active' : ''} onClick={() => selectSection('directory')}><Users size={20} /><span>Directory</span></button>
        <button className={section === 'visits' ? 'active' : ''} onClick={() => selectSection('visits')}><CalendarDays size={20} /><span>Visits</span></button>
      </nav>

      {editingDoctor !== undefined && (
        <DoctorForm
          doctor={editingDoctor}
          doctors={snapshot.doctors}
          master={snapshot.master}
          onClose={() => setEditingDoctor(undefined)}
          onSave={saveDoctor}
        />
      )}
      {selectedDoctor && (
        <DoctorDetail
          doctor={snapshot.doctors.find((doctor) => doctor.id === selectedDoctor.id) ?? selectedDoctor}
          products={snapshot.master.products}
          visits={snapshot.visits}
          onClose={() => setSelectedDoctor(null)}
          onEdit={() => { setEditingDoctor(snapshot.doctors.find((doctor) => doctor.id === selectedDoctor.id) ?? selectedDoctor); setSelectedDoctor(null) }}
          onLogVisit={logFromDoctor}
        />
      )}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

export default App
