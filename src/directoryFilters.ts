import type { Doctor, FilterState, MasterSettings, Product } from './types'
import { doctorProductNames, normalize, productLabel } from './utils'

export interface FilterOption {
  id: string
  label: string
  count: number
}

export interface FilterGroup {
  key: keyof FilterState
  label: string
  items: FilterOption[]
}

const GROUPS: { key: keyof FilterState; label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'specialty', label: 'Specialty' },
  { key: 'product', label: 'Product' },
  { key: 'camp', label: 'Camp' },
  { key: 'prescriber', label: 'Prescriber' },
  { key: 'callSchedule', label: 'Call schedule' },
  { key: 'potential', label: 'Potential' },
]

type Values = Record<keyof FilterState, string[]>

// Built once per data/catalog change, not on every keystroke or chip click.
export function indexDirectory(doctors: Doctor[], products: Product[], settings: MasterSettings) {
  const normalizedValues = new Map<string, string>()
  const normalized = (value: string) => {
    let cached = normalizedValues.get(value)
    if (cached === undefined) { cached = normalize(value); normalizedValues.set(value, cached) }
    return cached
  }
  const catalog: Values = {
    area: [...settings.areas], specialty: [...settings.specialties],
    camp: [...settings.camps], callSchedule: [...settings.callSchedules],
    potential: [...settings.potentials], prescriber: ['Rx', 'NRx'],
    product: products.map(product => product.prodId),
  }
  const productIndex = products.map(product => ({
    id: normalized(product.prodId), name: normalized(product.name),
  }))
  const productCache = new Map<string, { ids: string[]; names: string[] }>()
  const productNames = new Map<string, string[]>()
  const rows = doctors.map(doctor => {
    const cacheKey = JSON.stringify(doctor.prescribingProductIds)
    let resolved = productCache.get(cacheKey)
    if (!resolved) {
      const references = doctor.prescribingProductIds.map(normalized)
      resolved = {
        // Preserve the Directory's existing ID/legacy product-name matching.
        ids: productIndex.filter(product => references.some(value => value === product.id
          || Boolean(product.name && value.includes(product.name)))).map(product => product.id),
        names: doctorProductNames(doctor, products),
      }
      productCache.set(cacheKey, resolved)
    }
    productNames.set(doctor.id, resolved.names)
    const raw: Values = {
      area: [doctor.area], camp: [doctor.camp], specialty: doctor.specialties,
      callSchedule: [doctor.callSchedule], potential: [doctor.potential],
      prescriber: [doctor.prescriber],
      product: resolved.ids,
    }
    const values = {} as Values
    for (const { key } of GROUPS) {
      values[key] = [...new Set(raw[key].map(normalized).filter(Boolean))]
      if (key !== 'product') catalog[key].push(...raw[key])
    }
    return {
      doctor, values,
      search: [doctor.name, doctor.hospital, doctor.pharmacy, doctor.area, doctor.camp,
        doctor.specialties.join(' '), doctor.prescribingProductIds.join(' '),
        resolved.names.join(' ')].map(normalized),
    }
  }).sort((a, b) => a.doctor.prescriber !== b.doctor.prescriber
    ? a.doctor.prescriber === 'Rx' ? -1 : 1
    : a.doctor.name.localeCompare(b.doctor.name))

  const labels = new Map(products.map(product => [normalized(product.prodId), productLabel(product)]))
  const groups = GROUPS.map(group => {
    const seen = new Set<string>()
    return { ...group, items: catalog[group.key].filter(id => {
      const value = normalized(id)
      if (!value || seen.has(value)) return false
      seen.add(value)
      return true
    }).map(id => ({ id, label: group.key === 'product' ? labels.get(normalized(id)) || id : id, count: 0 })) }
  })
  return { rows, groups, productNames }
}

export function filterDirectory(index: ReturnType<typeof indexDirectory>, query: string, filters: FilterState) {
  const search = normalize(query)
  let matching = index.rows.filter(row => !search || row.search.some(value => value.includes(search)))
  const valid = {} as Values
  // Resolve downstream selections against the upstream subset before applying
  // them. A stale preset or changed search cannot trap the user in zero results.
  for (const { key } of GROUPS) {
    const available = new Set(matching.flatMap(row => row.values[key]))
    valid[key] = filters[key].filter(value => available.has(normalize(value)))
    if (valid[key].length) {
      const selected = new Set(valid[key].map(normalize))
      matching = matching.filter(row => row.values[key].some(value => selected.has(value)))
    }
  }

  // Every count and the visible results derive from this one final subset.
  const groups = index.groups.map(group => {
    const counts = new Map<string, number>()
    for (const row of matching) {
      for (const value of row.values[group.key]) counts.set(value, (counts.get(value) || 0) + 1)
    }
    valid[group.key] = valid[group.key].filter(value => counts.has(normalize(value)))
    return { ...group, items: group.items.map(item => ({ ...item, count: counts.get(normalize(item.id)) || 0 }))
      .filter(item => item.count > 0) }
  })
  const changed = GROUPS.some(({ key }) => valid[key].length !== filters[key].length)
  return { doctors: matching.map(row => row.doctor), groups, filters: changed ? valid as FilterState : filters }
}
