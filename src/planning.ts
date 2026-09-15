import type { CallWindow, Doctor } from './types'
import { WEEKDAYS, parseDays, parseClock, validateAvailability } from '../shared/availability.js'

export type AvailabilityKind = 'now' | 'later' | 'ended' | 'off' | 'unknown'
export interface Availability {
  kind: AvailabilityKind
  label: string
  detail: string
  sortTime: number
  window?: CallWindow
}

export function timeLabel(time: string): string {
  if (!time || parseClock(time) !== time) return 'Time needs review'
  const [hour, minute] = time.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

export function availabilityFor(doctor: Doctor, now: Date): Availability {
  const unknown = (detail: string): Availability => ({ kind: 'unknown', label: 'Timing unknown', detail, sortTime: Infinity })
  let windows: CallWindow[] = doctor.availability || []
  let legacy = false
  if (windows.length) {
    try { windows = validateAvailability(windows) } catch { return unknown('Review the saved availability windows.') }
  } else {
    legacy = true
    const days = parseDays(doctor.callSchedule)
    if (!days.length) return unknown('Confirm weekdays and call times.')
    if (!days.includes(WEEKDAYS[now.getDay()])) return { kind: 'off', label: 'Not scheduled today', detail: doctor.callSchedule, sortTime: Infinity }
    const after = doctor.opTiming.match(/^after\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$/i)
    const range = doctor.opTiming.match(/^(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$/i)
    const from = parseClock(after?.[1] || range?.[1])
    const until = parseClock(range?.[2])
    if (!from || (range && (!until || until <= from))) return unknown(doctor.opTiming || 'Add call availability to this doctor.')
    windows = [{ days, from, until, notes: '' }]
  }
  const today = windows.filter(window => window.days.includes(WEEKDAYS[now.getDay()]))
  if (!today.length) return { kind: 'off', label: 'Not scheduled today', detail: 'No call window for this weekday.', sortTime: Infinity }
  const current = now.getHours() * 60 + now.getMinutes()
  const active = today.filter(window => minutes(window.from) <= current && (!window.until || current < minutes(window.until)))
    .sort((a, b) => (a.until ? minutes(a.until) : Infinity) - (b.until ? minutes(b.until) : Infinity))
  const next = today.filter(window => minutes(window.from) > current).sort((a, b) => a.from.localeCompare(b.from))
  const window = active[0] || next[0] || [...today].sort((a, b) => b.until.localeCompare(a.until))[0]
  const detail = `${timeLabel(window.from)}${window.until ? `–${timeLabel(window.until)}` : ' onwards · closing time unknown'}${legacy ? ' · from OP timing' : ''}`
  if (active.length) return { kind: 'now', label: window.until ? `Closes in ${minutes(window.until) - current} min` : 'Start time passed · confirm availability', detail,
    sortTime: window.until ? minutes(window.until) : Infinity, window }
  if (next.length) return { kind: 'later', label: `Starts in ${minutes(window.from) - current} min`, detail, sortTime: minutes(window.from), window }
  return { kind: 'ended', label: 'Window ended', detail, sortTime: window.until ? -minutes(window.until) : Infinity, window }
}

const rank: Record<AvailabilityKind, number> = { now: 0, later: 1, unknown: 2, ended: 3, off: 4 }
export function compareAvailability(a: Availability, b: Availability): number {
  return rank[a.kind] - rank[b.kind] || (a.sortTime === b.sortTime ? 0 : a.sortTime - b.sortTime)
}

// Swap visible neighbours in the complete camp order without losing filtered-out doctors.
export function moveInOrder(order: string[], id: string, neighbour: string): string[] {
  const next = [...order]
  const from = next.indexOf(id)
  const to = next.indexOf(neighbour)
  if (from >= 0 && to >= 0) [next[from], next[to]] = [next[to], next[from]]
  return next
}
