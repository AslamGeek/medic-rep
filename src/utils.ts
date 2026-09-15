import type { Doctor, Product, Visit } from './types'
import { productIdsFromCell } from '../shared/products.js'

export function localDateString(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addDays(dateString: string, amount: number): string {
  const [year, month, day] = dateString.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + amount)
  return localDateString(date)
}

export function dayName(dateString: string): string {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(
    new Date(year, month - 1, day),
  )
}

export function formatDate(dateString: string): string {
  const [year, month, day] = dateString.split('-').map(Number)
  if (!year || !month || !day) return dateString
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day))
}

export function normalize(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase()
}

export function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

const CAMP_CODE_MAP: Record<string, string> = {
  proddatur: 'PDTR',
  'mydukuru/gv satram': 'MYGV',
  'yerraguntla/kamalapuram': 'YEKA',
  jammalamadugu: 'JAMD',
  'porumamilla/kalasapadu': 'POKA',
}

function campCode(camp: string): string {
  return CAMP_CODE_MAP[normalize(camp)]
    ?? camp.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
    ?? 'DOC'
}

export function generateDoctorId(camp: string, doctors: Doctor[]): string {
  const code = campCode(camp) || 'DOC'
  const maxSequence = doctors.reduce((maximum, doctor) => {
    if (normalize(doctor.camp) !== normalize(camp)) return maximum
    const match = doctor.id.match(/^(.+)-(\d+)$/)
    if (!match || normalize(match[1]) !== normalize(code)) return maximum
    const sequence = Number(match[2])
    return Number.isFinite(sequence) ? Math.max(maximum, sequence) : maximum
  }, 0)
  return `${code}-${String(maxSequence + 1).padStart(3, '0')}`
}

export function productLabel(product: Product): string {
  return product.dosageForm
    ? `${product.name} (${product.dosageForm})`
    : product.name
}

export function doctorProductNames(
  doctor: Doctor,
  products: Product[],
): string[] {
  return productIdsFromCell(doctor.prescribingProductIds, products).map((id) => {
    const product = products.find(
      (item) => normalize(item.prodId) === normalize(id),
    )
    if (product) return productLabel(product)
    return id
  })
}

export function stripVisitListNumber(line: string): string {
  return line.replace(/^\s*\d+\.\s*/, '').trim()
}

export function visitDoctorDisplayLine(line: string): string {
  const unnumbered = stripVisitListNumber(line)
  const separator = unnumbered.indexOf(' — ')
  return separator > 0 ? unnumbered.slice(separator + 3).trim() : unnumbered
}

export function visitLineForDoctor(doctor: Doctor, index: number): string {
  const specialty = doctor.specialties.join(', ') || 'General'
  return `${index + 1}. ${doctor.name} (${specialty})`
}

export function doctorIdFromVisitLine(line: string): string | null {
  const unnumbered = stripVisitListNumber(line)
  const separator = unnumbered.indexOf(' — ')
  return separator > 0 ? unnumbered.slice(0, separator).trim() : null
}

export function visitDoctorName(line: string): string {
  const displayLine = visitDoctorDisplayLine(line)
  const specialtyStart = displayLine.lastIndexOf(' (')
  return (specialtyStart > 0 ? displayLine.slice(0, specialtyStart) : displayLine).trim()
}

export function buildLastVisitMap(visits: Visit[]): Map<string, string> {
  const map = new Map<string, string>()
  visits
    .filter((visit) => visit.kind === 'Visit')
    .forEach((visit) => {
      visit.doctorLines.forEach((line) => {
        const id = doctorIdFromVisitLine(line)
        const keys = [id, normalize(visitDoctorName(line))].filter(Boolean) as string[]
        keys.forEach((key) => {
          const current = map.get(key)
          if (!current || visit.date > current) map.set(key, visit.date)
        })
      })
    })
  return map
}

export function relativeVisitLabel(dateString?: string): string {
  if (!dateString) return 'Never visited'
  const [year, month, day] = dateString.split('-').map(Number)
  const then = new Date(year, month - 1, day).getTime()
  const [todayYear, todayMonth, todayDay] = localDateString().split('-').map(Number)
  const today = new Date(todayYear, todayMonth - 1, todayDay).getTime()
  const days = Math.max(0, Math.round((today - then) / 86_400_000))
  if (days === 0) return 'Visited today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

export function isVisitStale(dateString?: string): boolean {
  if (!dateString) return true
  const [year, month, day] = dateString.split('-').map(Number)
  const days = Math.round(
    (Date.now() - new Date(year, month - 1, day).getTime()) / 86_400_000,
  )
  return days >= 14
}
