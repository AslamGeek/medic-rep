import {
  READ_TIMEOUT_MS,
  SYNC_API_URL,
  WRITE_TIMEOUT_MS,
} from './config'
import { db, setMeta } from './db'
import { productIdsFromCell, unresolvedProductReferences } from '../shared/products.js'
import type {
  BootstrapPayload,
  Doctor,
  MasterData,
  QueueAction,
  QueueItem,
  Visit,
} from './types'

export type SyncPhase = 'offline' | 'idle' | 'syncing' | 'error'

export interface SyncDetail {
  phase: SyncPhase
  activity?: 'saving' | 'refreshing'
  message?: string
  pending?: number
  requiresAttention?: boolean
}

const SYNC_EVENT = 'medrep:sync-status'
let activeSync: Promise<void> | null = null
let activeWrites: Promise<void> | null = null
let retryTimer: number | undefined
let retryDelay = 2_000
let writeRequested = false
let refreshing = false
let writeError = ''
let readError = ''
let revision = 0
const doctorChanges = new Map<string, number>()

class ValidationError extends Error {}

function hasRetryableChanges(items: QueueItem[]): boolean {
  const blocked = new Set(items.filter((item) => item.validationError).map((item) => item.entityId))
  return items.some((item) => !blocked.has(item.entityId)
    && !(item.action === 'saveVisit' && (item.payload as Visit).doctorIds.some((id) => blocked.has(id))))
}

async function report(): Promise<void> {
  const items = await db.queue.toArray()
  const pending = items.length
  const validationError = items.find((item) => item.validationError)?.validationError
  const message = validationError || writeError || readError
  emit({
    phase: !navigator.onLine ? 'offline' : activeWrites || refreshing ? 'syncing' : message ? 'error' : 'idle',
    activity: activeWrites ? 'saving' : refreshing ? 'refreshing' : undefined,
    message: message || (pending ? 'Waiting to save to Sheets' : 'Saved to Sheets'),
    pending,
    requiresAttention: Boolean(validationError),
  })
}

function changedDoctor(id: string): void {
  doctorChanges.set(id, ++revision)
}

function emit(detail: SyncDetail): void {
  window.dispatchEvent(new CustomEvent<SyncDetail>(SYNC_EVENT, { detail }))
}

export function onSyncStatus(
  callback: (detail: SyncDetail) => void,
): () => void {
  const handler = (event: Event) => {
    callback((event as CustomEvent<SyncDetail>).detail)
  }
  window.addEventListener(SYNC_EVENT, handler)
  return () => window.removeEventListener(SYNC_EVENT, handler)
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): {
  signal: AbortSignal
  cancel: () => void
} {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  return {
    signal: controller.signal,
    cancel: () => window.clearTimeout(timer),
  }
}

async function fetchJson<T>(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const timeout = withTimeout(timeoutMs, init.signal ?? undefined)
  try {
    const response = await fetch(input, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      signal: timeout.signal,
    })
    const text = await response.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('The sync service returned an invalid response')
    }
    if (!response.ok) {
      const message = (data as { message?: unknown }).message
      throw new Error(
        typeof message === 'string' ? message : `Sync service returned ${response.status}`,
      )
    }
    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Sync timed out. Tap the cloud icon to try again.')
    }
    throw error
  } finally {
    timeout.cancel()
  }
}

async function getBootstrap(): Promise<BootstrapPayload> {
  const url = new URL(SYNC_API_URL, window.location.origin)
  url.searchParams.set('action', 'bootstrap')
  url.searchParams.set('_', Date.now().toString())
  const data = await fetchJson<BootstrapPayload>(url, { method: 'GET' }, READ_TIMEOUT_MS)
  if (!data.success) throw new Error(data.message || 'Could not load sheet data')
  return data
}

async function postOperation(item: QueueItem): Promise<Record<string, unknown>> {
  let payload = item.payload
  if (item.action === 'upsertDoctor') {
    const doctor = payload as Doctor
    const master = (await db.meta.get('master'))?.value as MasterData | undefined
    if (master?.products) {
      const references = doctor.prescriber === 'NRx' ? [] : doctor.prescribingProductIds
      const unresolved = unresolvedProductReferences(references, master.products)
      if (unresolved.length) throw new ValidationError(`Review prescribing products: ${unresolved.join(', ')}. Remove or reselect these from the current list.`)
      payload = { ...doctor, prescribingProductIds: productIdsFromCell(references, master.products) }
    }
  }
  const data = await fetchJson<Record<string, unknown>>(SYNC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: item.action,
      opId: item.opId,
      payload,
    }),
    keepalive: true,
  }, WRITE_TIMEOUT_MS)
  if (data.success !== true) {
    const message = String(data.message || 'A queued change could not be saved')
    if (/must come from the spreadsheet master list/.test(message)) throw new ValidationError(message)
    throw new Error(message)
  }
  if (item.action === 'upsertDoctor' && typeof (data.doctor as Doctor | undefined)?.id !== 'string') {
    throw new Error('Sheets has not confirmed this doctor yet. The save will retry.')
  }
  return data
}

export async function queueChange(
  action: QueueAction,
  entityId: string,
  payload: QueueItem['payload'],
): Promise<string> {
  const opId = crypto.randomUUID()
  await db.transaction('rw', db.queue, db.doctors, db.visits, async () => {
    if (action === 'upsertDoctor') {
      const previous = (await db.queue.where('entityId').equals(entityId).toArray())
        .filter((item) => item.action === 'upsertDoctor')
      const rejected = previous.find((item) => item.validationError)
      if (rejected) {
        payload = { ...payload as Doctor,
          isNewRecord: (rejected.payload as Doctor).isNewRecord || (payload as Doctor).isNewRecord }
        // Only replace definite rejections and later edits that were never sent.
        // A timed-out request may already have reached Sheets and must keep its receipt.
        for (const item of previous) {
          if (item.validationError || (item.id! > rejected.id! && item.attempts === 0)) {
            await db.queue.delete(item.id!)
          }
        }
      }
    }
    if (action === 'upsertDoctor') await db.doctors.put({ ...payload as Doctor, syncState: 'pending' })
    if (action === 'saveVisit') await db.visits.put({ ...payload as Visit, syncState: 'pending' })
    if (action === 'undoVisit') await db.visits.delete(entityId)
    await db.queue.add({ opId, action, entityId, payload, createdAt: new Date().toISOString(), attempts: 0 })
  })
  if (action === 'upsertDoctor') changedDoctor(entityId)
  else revision += 1
  writeRequested = true
  void flushChanges()
  return opId
}

async function pushQueue(): Promise<void> {
  const items = await db.queue.orderBy('id').toArray()
  const failures: string[] = []
  const blockedEntities = new Set<string>()
  for (const queued of items) {
    const item = queued.id === undefined ? undefined : await db.queue.get(queued.id)
    if (!item || blockedEntities.has(item.entityId)) continue
    if (item.validationError) { blockedEntities.add(item.entityId); continue }
    try {
      if (item.action === 'saveVisit') {
        const visit = item.payload as Visit
        const pendingDoctors = await db.queue.where('action').equals('upsertDoctor').toArray()
        if (pendingDoctors.some((next) => visit.doctorIds.includes(next.entityId))) {
          throw new Error('Waiting for the selected doctors to finish saving before sending this visit.')
        }
      }
      const result = await postOperation(item)
      await db.transaction('rw', db.queue, db.doctors, db.visits, async () => {
        if (item.action === 'upsertDoctor') {
          const doctor = result.doctor as Doctor
          const successors = (await db.queue.where('entityId').equals(item.entityId).toArray())
            .filter((next) => next.id !== item.id && next.action === 'upsertDoctor')
          const latest = await db.doctors.get(item.entityId)
          await db.doctors.put({
            ...(successors.length && latest ? latest : doctor),
            id: doctor.id, isNewRecord: false,
            syncState: successors.length ? 'pending' : 'synced',
          })
          for (const next of successors) {
            await db.queue.update(next.id!, {
              entityId: doctor.id,
              payload: { ...next.payload as Doctor, id: doctor.id, isNewRecord: false },
            })
          }
          // A new doctor can be selected for a visit before Sheets assigns its ID.
          if (doctor.id !== item.entityId) {
            for (const next of await db.queue.where('action').equals('saveVisit').toArray()) {
              const visit = next.payload as Visit
              if (visit.doctorIds.includes(item.entityId)) {
                const doctorIds = visit.doctorIds.map((id) => id === item.entityId ? doctor.id : id)
                await db.queue.update(next.id!, { payload: { ...visit, doctorIds } })
                await db.visits.update(visit.localId, { doctorIds })
              }
            }
          }
          if (doctor.id !== item.entityId) await db.doctors.delete(item.entityId)
          changedDoctor(item.entityId)
          changedDoctor(doctor.id)
        }
        if (item.action === 'saveVisit') {
          const visit = item.payload as Visit
          const current = await db.visits.get(visit.localId)
          if (current) await db.visits.put({ ...current, ...(result.visit as Visit | undefined), localId: current.localId, syncState: 'synced' })
          // Undo must target the canonical row actually written by Sheets.
          if (result.visit) {
            for (const undo of await db.queue.where('entityId').equals(item.entityId).toArray()) {
              if (undo.action === 'undoVisit') await db.queue.update(undo.id!, { payload: { visit: result.visit as Visit } })
            }
          }
          revision += 1
        }
        if (item.action === 'undoVisit') revision += 1
        if (item.id !== undefined) await db.queue.delete(item.id)
      })
      await report()
    } catch (error) {
      blockedEntities.add(item.entityId)
      if (item.id !== undefined) {
        await db.queue.update(item.id, {
          attempts: item.attempts + 1,
          validationError: error instanceof ValidationError
            ? `${(item.payload as Doctor).name || 'Doctor'}: ${error.message}` : undefined,
        })
      }
      failures.push(error instanceof Error ? error.message : 'A queued change could not be saved')
    }
  }
  if (failures.length) {
    throw new Error(
      failures.length === 1
        ? failures[0]
        : `${failures.length} older changes still need attention`,
    )
  }
}

async function applyBootstrap(payload: BootstrapPayload, startedAt: number): Promise<void> {
  await db.transaction('rw', db.queue, db.doctors, db.visits, db.meta, async () => {
    const pendingDoctorIds = new Set(
      (await db.queue.where('action').equals('upsertDoctor').toArray()).map(
        (item) => item.entityId,
      ),
    )
    for (const [id, changedAt] of doctorChanges) {
      if (changedAt > startedAt) pendingDoctorIds.add(id)
    }
    const pendingVisitIds = new Set(
      (await db.queue.where('action').equals('saveVisit').toArray()).map(
        (item) => item.entityId,
      ),
    )

    await db.doctors
      .filter((doctor) => doctor.syncState === 'synced' && !pendingDoctorIds.has(doctor.id))
      .delete()
    if (revision === startedAt) await db.visits
      .filter((visit) => visit.syncState === 'synced' && !pendingVisitIds.has(visit.localId))
      .delete()

    if (payload.doctors.length) {
      await db.doctors.bulkPut(
        payload.doctors
          .filter((doctor) => !pendingDoctorIds.has(doctor.id))
          .map((doctor) => ({ ...doctor, syncState: 'synced' as const })),
      )
    }
    if (revision === startedAt && payload.visits.length) {
      await db.visits.bulkPut(
        payload.visits
          .filter((visit) => !pendingVisitIds.has(visit.localId))
          .map((visit) => ({ ...visit, syncState: 'synced' as const })),
      )
    }

    const master: MasterData = {
      settings: payload.settings,
      products: payload.products,
    }
    await db.meta.put({ key: 'master', value: master })
    await db.meta.put({ key: 'lastSync', value: payload.serverTime })
  })
}

async function performSync(): Promise<void> {
  // Flush existing changes first, but new saves run independently of this read.
  await flushChanges()
  if (!navigator.onLine) return
  refreshing = true
  readError = ''
  await report()
  try {
    const startedAt = revision
    const bootstrap = await getBootstrap()
    await applyBootstrap(bootstrap, startedAt)
    await setMeta('lastSuccessfulSync', new Date().toISOString())
    // A requested refresh may bring a corrected master list or backend deployment.
    // Retry rejected edits once against the newly loaded data, without a retry loop.
    const rejected = (await db.queue.toArray()).filter((item) => item.validationError)
    for (const item of rejected) await db.queue.update(item.id!, { validationError: undefined })
    if (rejected.length) await flushChanges()
  } catch (error) {
    readError = error instanceof Error ? error.message : 'Could not refresh from Sheets'
  } finally {
    refreshing = false
    await report()
  }
}

export function flushChanges(): Promise<void> {
  if (activeWrites) return activeWrites
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = undefined
  if (!navigator.onLine) return report()
  activeWrites = (async () => {
    writeError = ''
    await report()
    do {
      writeRequested = false
      await pushQueue()
    } while (writeRequested)
    retryDelay = 2_000
  })().catch((error: unknown) => {
    writeError = error instanceof Error ? error.message : 'Could not save to Sheets'
  }).finally(async () => {
    activeWrites = null
    await report()
    if (hasRetryableChanges(await db.queue.toArray()) && navigator.onLine) {
      retryTimer = window.setTimeout(() => { void flushChanges() }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
  })
  return activeWrites
}

export function syncNow(): Promise<void> {
  if (!activeSync) {
    activeSync = performSync().finally(() => {
      activeSync = null
    })
  }
  return activeSync
}
