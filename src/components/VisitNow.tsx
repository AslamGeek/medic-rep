import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Clock3, MapPin } from 'lucide-react'
import type { Doctor, MasterSettings } from '../types'
import { normalize, unique } from '../utils'
import { availabilityFor, compareAvailability, moveInOrder, type AvailabilityKind } from '../planning'

interface VisitNowProps {
  doctors: Doctor[]
  settings: MasterSettings
  camp: string
  schedules: string[]
  onOpen: (doctor: Doctor) => void
  onEdit: (doctor: Doctor) => void
  onLogVisit: (doctor: Doctor) => void
}

interface CampOrder { ids: string[]; custom: boolean; query?: string; opTiming?: string; status?: AvailabilityKind | '' }
const STORAGE_KEY = 'medrep-visit-now-order-v1'

function readOrders(): Record<string, CampOrder> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return Object.fromEntries(Object.entries(data).filter(([, value]) => value && Array.isArray(value.ids)
      && value.ids.every((id: unknown) => typeof id === 'string') && typeof value.custom === 'boolean'))
  } catch { return {} }
}

export function VisitNow({ doctors, settings, camp, schedules, onOpen, onEdit, onLogVisit }: VisitNowProps) {
  const [now, setNow] = useState(() => new Date())
  const [orders, setOrders] = useState(readOrders)
  const [storageError, setStorageError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const update = () => setNow(new Date())
    const timer = window.setInterval(update, 60_000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [])

  const campKey = normalize(camp)
  const saved = orders[campKey]
  const custom = saved?.custom ?? false
  const query = typeof saved?.query === 'string' ? saved.query : ''
  const opTiming = typeof saved?.opTiming === 'string' ? saved.opTiming : ''
  const status = saved?.status || ''
  const candidates = doctors.filter(doctor => normalize(doctor.camp) === campKey)
    .map(doctor => ({ doctor, availability: availabilityFor(doctor, now) }))
    .sort((a, b) => compareAvailability(a.availability, b.availability) || a.doctor.name.localeCompare(b.doctor.name))
  const candidateIds = candidates.map(item => item.doctor.id)
  const savedIds = [...new Set(saved?.ids || [])].filter(id => candidateIds.includes(id))
  const order = custom ? [...savedIds, ...candidateIds.filter(id => !savedIds.includes(id))] : candidateIds
  const positions = new Map(order.map((id, index) => [id, index]))
  const visible = candidates.filter(({ doctor, availability }) =>
    (!schedules.length || schedules.some(schedule => normalize(schedule) === normalize(doctor.callSchedule)))
    && (!opTiming || normalize(doctor.opTiming) === normalize(opTiming))
    && (!status || availability.kind === status)
    && (!query || [doctor.name, doctor.area, doctor.hospital].some(value => normalize(value).includes(normalize(query)))))
    .sort((a, b) => positions.get(a.doctor.id)! - positions.get(b.doctor.id)!)

  const persist = (next: CampOrder) => {
    const updated = { ...orders, [campKey]: { ...saved, ...next } }
    setOrders(updated)
    setStorageError('')
  }
  // Freeze newly arrived doctors at the end of a custom plan. Later clock ticks
  // and filter changes must not reshuffle them before the user moves a card.
  // Adjust only when the roster changes, before rendering this camp's plan.
  if (custom && saved && candidateIds.length && (order.length !== saved.ids.length || order.some((id, index) => id !== saved.ids[index]))) {
    setOrders({ ...orders, [campKey]: { ...saved, ids: order } })
  }
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(orders)) }
    // Report a failure of the external storage write to the user.
    // oxlint-disable-next-line react/set-state-in-effect
    catch { setStorageError('This device could not store the order. It will last only until this screen closes.') }
  }, [orders])
  const move = (index: number, step: number) => {
    const target = visible[index + step]
    if (!target) return
    const doctor = visible[index].doctor
    persist({ ids: moveInOrder(order, doctor.id, target.doctor.id), custom: true })
    setAnnouncement(`${doctor.name} moved ${step < 0 ? 'up' : 'down'}. My order is active.`)
  }
  const timingOptions = unique([...settings.opTimings, ...candidates.map(item => item.doctor.opTiming)])

  return (
    <section className="visit-now" aria-label="Visit now planner">
      <div className="planner-heading"><div><p className="eyebrow">Your next calls</p><h2>Visit now</h2></div>
        <span className="planner-clock"><Clock3 size={15} />{now.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div className="segmented-control" aria-label="Doctor order">
        <button className={!custom ? 'active' : ''} aria-pressed={!custom} onClick={() => persist({ ids: saved?.ids || [], custom: false })}>By availability</button>
        <button className={custom ? 'active' : ''} aria-pressed={custom} onClick={() => persist({ ids: saved?.ids.length ? saved.ids : candidateIds, custom: true })}>My order</button>
      </div>
      <p className="planner-hint">{custom ? 'Your camp order is active. Time warnings still update.' : 'Open windows first, ordered by closing time; upcoming windows follow.'} Use ↑ ↓ to arrange your calls. Custom orders are saved per camp on this device.</p>
      {storageError && <p role="alert" className="inline-alert error">{storageError}</p>}
      <div className="planner-filters">
        <label className="field"><span>Availability</span><select value={status} onChange={event => persist({ ids: saved?.ids || [], custom, status: event.target.value as AvailabilityKind | '' })}>
          <option value="">All timings</option><option value="now">Started / available now</option><option value="later">Later today</option>
          <option value="ended">Window ended</option><option value="off">Not scheduled today</option><option value="unknown">Timing unknown</option>
        </select></label>
        <label className="field"><span>OP timing</span><select value={opTiming} onChange={event => persist({ ids: saved?.ids || [], custom, opTiming: event.target.value })}><option value="">All OP timings</option>{timingOptions.map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <label className="field"><span>Find a doctor</span><input type="search" value={query} placeholder="Name, area or hospital" onChange={event => persist({ ids: saved?.ids || [], custom, query: event.target.value })} /></label>
      <p className="planner-hint">{visible.length} doctors · {camp || 'Select today’s camp above'}</p>
      <p className="sr-only" role="status">{announcement}</p>
      <ol className="planner-list">
        {visible.map(({ doctor, availability }, index) => (
          <li className={`planner-card availability-${availability.kind}`} key={doctor.id}>
            <div className="planner-card-top"><span className="planner-number">{index + 1}</span>
              <button className="planner-doctor-name" onClick={() => onOpen(doctor)}>{doctor.name}</button>
              <div className="planner-arrows">
                <button className="icon-button" disabled={index === 0} aria-label={`Move ${doctor.name} up`} onClick={() => move(index, -1)}><ArrowUp size={18} /></button>
                <button className="icon-button" disabled={index === visible.length - 1} aria-label={`Move ${doctor.name} down`} onClick={() => move(index, 1)}><ArrowDown size={18} /></button>
              </div>
            </div>
            <p className="planner-location"><MapPin size={13} />{[doctor.area, doctor.hospital].filter(Boolean).join(' · ') || doctor.camp}</p>
            <span className="availability-label">{availability.label}</span>
            <p className="planner-window">{availability.detail}</p>
            {availability.window?.notes && <p className="planner-hint">{availability.window.notes}</p>}
            <div className="planner-card-actions"><button className="choice-chip" onClick={() => onEdit(doctor)}>Edit timings</button><button className="choice-chip" onClick={() => onLogVisit(doctor)}>Log visit</button></div>
          </li>
        ))}
      </ol>
      {!visible.length && <div className="picker-empty">No doctors match. Check the camp, call schedule and timing filters.</div>}
    </section>
  )
}
