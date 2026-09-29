import Dexie, { type Table } from 'dexie'
import {
  EMPTY_SETTINGS,
  type AppSnapshot,
  type Doctor,
  type FilterPreset,
  type MasterData,
  type MetaRecord,
  type QueueItem,
  type Visit,
} from './types'

class MedRepDatabase extends Dexie {
  doctors!: Table<Doctor, string>
  visits!: Table<Visit, string>
  queue!: Table<QueueItem, number>
  presets!: Table<FilterPreset, string>
  meta!: Table<MetaRecord, string>

  constructor() {
    super('medrep-local-v1')
    this.version(1).stores({
      doctors:
        'id, name, area, camp, prescriber, callSchedule, updatedAt, syncState, *specialties, *prescribingProductIds',
      visits: 'localId, date, camp, kind, createdAt, syncState, *doctorIds',
      queue: '++id, &opId, action, entityId, createdAt',
      presets: 'id, name, updatedAt',
      meta: 'key',
    })
    this.version(2).stores({
      doctors: 'id, name, area, camp, prescriber, callSchedule, updatedAt, syncState, *specialties, *prescribingProductIds',
      visits: 'localId, date, camp, kind, createdAt, updatedAt, syncState, *doctorIds',
      queue: '++id, &opId, action, entityId, createdAt',
      presets: 'id, name, updatedAt',
      meta: 'key',
    }).upgrade(async tx => {
      const pending = await tx.table('queue').toArray() as QueueItem[]
      const epoch = '1970-01-01T00:00:00.000Z'
      for (const name of ['doctors', 'visits', 'queue', 'presets', 'meta']) {
        await tx.table(name).toCollection().modify(record => {
          record.updatedAt = Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : epoch
          const id = name === 'doctors' ? record.id : record.localId
          record._synced = ['doctors', 'visits'].includes(name) && record.syncState === 'synced'
            && !pending.some(item => item.entityId === id)
          if (name === 'visits') record._legacyId = true
        })
      }
    })
  }
}

export const db = new MedRepDatabase()

export const DEFAULT_MASTER: MasterData = {
  settings: EMPTY_SETTINGS,
  products: [],
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  const [doctors, visits, masterRecord, presets, pendingCount] =
    await Promise.all([
      db.doctors.orderBy('name').toArray(),
      db.visits.orderBy('date').reverse().toArray(),
      db.meta.get('master'),
      db.presets.orderBy('updatedAt').reverse().toArray(),
      db.queue.count(),
    ])

  return {
    doctors,
    visits,
    master: (masterRecord?.value as MasterData | undefined) ?? DEFAULT_MASTER,
    presets,
    pendingCount,
  }
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await db.meta.put({ key, value, updatedAt: new Date().toISOString(), _synced: false })
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const record = await db.meta.get(key)
  return record?.value as T | undefined
}
