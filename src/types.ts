export type Prescriber = 'Rx' | 'NRx'

export type SyncState = 'pending' | 'synced' | 'error'

export interface CallWindow {
  days: string[]
  from: string
  until: string
  notes: string
}

export interface Doctor {
  id: string
  isNewRecord?: boolean
  name: string
  specialties: string[]
  hospital: string
  pharmacy: string
  area: string
  camp: string
  potential: string
  stockist: string
  prescriber: Prescriber
  opTiming: string
  availability?: CallWindow[]
  callSchedule: string
  prescribingProductIds: string[]
  notes: string
  updatedAt: string
  syncState: SyncState
}

export interface Product {
  prodId: string
  name: string
  dosageForm: string
}

export interface MasterSettings {
  areas: string[]
  specialties: string[]
  camps: string[]
  potentials: string[]
  stockists: string[]
  opTimings: string[]
  callSchedules: string[]
}

export interface MasterData {
  settings: MasterSettings
  products: Product[]
}

export type VisitKind = 'Visit' | 'Sunday' | 'Holiday' | 'Leave'

export interface Visit {
  localId: string
  date: string
  day: string
  camp: string
  kind: VisitKind
  doctorIds: string[]
  doctorCount: number
  pharmacyCount: number
  doctorLines: string[]
  pharmacyLines: string[]
  createdAt: string
  syncState: SyncState
}

export type QueueAction = 'upsertDoctor' | 'saveVisit' | 'undoVisit'

export interface QueueItem {
  id?: number
  opId: string
  action: QueueAction
  entityId: string
  payload: Doctor | Visit | { visit: Visit }
  createdAt: string
  attempts: number
  validationError?: string
}

export interface FilterState {
  area: string[]
  camp: string[]
  specialty: string[]
  callSchedule: string[]
  product: string[]
  potential: string[]
  prescriber: Prescriber[]
}

export interface FilterPreset {
  id: string
  name: string
  filters: FilterState
  updatedAt: string
}

export interface MetaRecord<T = unknown> {
  key: string
  value: T
}

export interface BootstrapPayload {
  success: boolean
  doctors: Doctor[]
  visits: Visit[]
  settings: MasterSettings
  products: Product[]
  serverTime: string
  message?: string
}

export interface AppSnapshot {
  doctors: Doctor[]
  visits: Visit[]
  master: MasterData
  presets: FilterPreset[]
  pendingCount: number
}

export const EMPTY_SETTINGS: MasterSettings = {
  areas: [],
  specialties: [],
  camps: [],
  potentials: [],
  stockists: [],
  opTimings: [],
  callSchedules: [],
}

export const EMPTY_FILTERS: FilterState = {
  area: [],
  camp: [],
  specialty: [],
  callSchedule: [],
  product: [],
  potential: [],
  prescriber: [],
}
