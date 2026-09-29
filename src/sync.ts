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

export interface SyncConflict { entity: 'doctor' | 'visit'; id: string; label: string; reason: string; removedFromSheets?: boolean }

export interface SyncDetail {
  phase: SyncPhase
  activity?: 'saving' | 'refreshing'
  message?: string
  pending?: number
  requiresAttention?: boolean
  retryPaused?: boolean
  conflicts?: SyncConflict[]
  verified?: boolean
}

const SYNC_EVENT = 'medrep:sync-status'
let activeSync: Promise<void> | null = null
let activeWrites: Promise<void> | null = null
let retryTimer: number | undefined
let retryDelay = 2_000
let writeRequested = false
let refreshing = false
let resetting = false
let writeError = ''
let readError = ''
let conflicts: SyncConflict[] = []
const MAX_ATTEMPTS = 8
class TransientError extends Error {}
class ProtocolError extends Error {}

async function coordinated<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request('medrep-sync', work) : work()
}

class ValidationError extends Error {}

function removedConflict(doctor: Doctor): SyncConflict {
  return { entity: 'doctor', id: doctor.id, label: doctor.name,
    reason: 'Removed from Sheets — you have unsynced changes', removedFromSheets: true }
}

function hasRetryableChanges(items: QueueItem[]): boolean {
  const blocked = new Set(items.filter((item) => item.validationError || item.retryStopped).map((item) => item.entityId))
  return items.some((item) => !blocked.has(item.entityId)
    && !(item.action === 'saveVisit' && (item.payload as Visit).doctorIds.some((id) => blocked.has(id))))
}

async function report(): Promise<void> {
  const items = await db.queue.toArray()
  const doctors = await db.doctors.toArray()
  const visits = await db.visits.toArray()
  const remoteIds = (await db.meta.get('remoteDoctorIds'))?.value as string[] | undefined
  const remoteSet = remoteIds ? new Set(remoteIds) : undefined
  const unsynced = doctors.filter(item => !item._synced).length + visits.filter(item => !item._synced).length
  const pending = Math.max(items.length, unsynced)
  const removed = doctors.filter(item => item._removedFromSheets).map(removedConflict)
  const visibleConflicts = [...conflicts.filter(item => !removed.some(next => next.id === item.id)), ...removed]
  const verified = Boolean(remoteSet && remoteSet.size === doctors.length && doctors.every(item => remoteSet.has(item.id))
    && !pending && !visibleConflicts.length)
  const validationError = items.find((item) => item.validationError)?.validationError
  const stopped = items.find(item => item.retryStopped)?.failureMessage
  const message = validationError || stopped || writeError || readError
  emit({
    phase: !navigator.onLine ? 'offline' : activeWrites || refreshing || resetting ? 'syncing' : message ? 'error' : 'idle',
    activity: activeWrites ? 'saving' : refreshing || resetting ? 'refreshing' : undefined,
    message: message || (pending ? 'Pending changes' : verified ? 'Synced with the last complete Sheets refresh' : 'Refresh to verify Sheets data'),
    pending,
    requiresAttention: Boolean(validationError || stopped),
    retryPaused: Boolean(stopped),
    conflicts: visibleConflicts,
    verified: verified && !message && !activeWrites && !refreshing && !resetting && navigator.onLine,
  })
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
      throw new ProtocolError('The sync service returned an invalid response. Check the Apps Script deployment.')
    }
    if (!response.ok) {
      const message = (data as { message?: unknown }).message
      const ErrorType = (data as { retryable?: boolean }).retryable === false ? ProtocolError
        : [408, 429, 500, 502, 503, 504].includes(response.status) ? TransientError : ValidationError
      throw new ErrorType(typeof message === 'string' ? message : `Sync service returned ${response.status}`)
    }
    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TransientError('Sync timed out. Tap the cloud icon to try again.')
    }
    if (error instanceof TypeError) throw new TransientError(error.message)
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
  if (data.schemaVersion !== 2) throw new Error('Deploy the generated Apps Script bundle and run setupSpreadsheet before refreshing.')
  // Missing/malformed data must never be interpreted as an empty sheet.
  if (!Array.isArray(data.doctors) || !Array.isArray(data.visits) || !Array.isArray(data.products)
    || !data.settings || typeof data.settings !== 'object' || !Number.isFinite(Date.parse(data.serverTime))) {
    throw new ProtocolError('Incomplete Sheets response. Local data was preserved.')
  }
  for (const [records, key] of [[data.doctors, 'id'], [data.visits, 'localId']] as const) {
    const ids = new Set<string>()
    for (const record of records) {
      const id = key === 'id' ? (record as Doctor).id : (record as Visit).localId
      if (typeof id !== 'string' || !id.trim() || ids.has(id) || !Number.isFinite(Date.parse(record.updatedAt))) {
        throw new ProtocolError('Invalid or duplicate record in Sheets response. Local data was preserved.')
      }
      ids.add(id)
    }
  }
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
    if (data.retryable === true) throw new TransientError(message)
    throw new ValidationError(message)
  }
  if (item.action === 'upsertDoctor' && typeof (data.doctor as Doctor | undefined)?.id !== 'string') {
    throw new ProtocolError('Sheets has not confirmed this doctor. Deploy the updated Apps Script.')
  }
  if (item.action !== 'undoVisit') {
    const record = (item.action === 'upsertDoctor' ? data.doctor : data.visit) as Doctor | Visit | undefined
    if (!record || !Number.isFinite(Date.parse(record.updatedAt))) throw new ProtocolError('Missing server timestamp. Deploy the updated Apps Script and correct/save this record again.')
  }
  return data
}

export async function queueChange(
  action: QueueAction,
  entityId: string,
  payload: QueueItem['payload'],
): Promise<string> {
  if (resetting) throw new Error('Cache refresh is in progress. Save again when it finishes.')
  const opId = crypto.randomUUID()
  await db.transaction('rw', db.queue, db.doctors, db.visits, async () => {
    if (action === 'upsertDoctor') {
      const existing = await db.doctors.get(entityId)
      if (existing?._removedFromSheets) payload = { ...payload as Doctor, _removedFromSheets: true }
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
    if (action !== 'undoVisit') payload = { ...payload as Doctor | Visit, updatedAt: new Date().toISOString(), _synced: false, syncState: 'pending' }
    if (action === 'upsertDoctor') await db.doctors.put(payload as Doctor)
    if (action === 'saveVisit') await db.visits.put(payload as Visit)
    if (action === 'undoVisit') await db.visits.delete(entityId)
    await db.queue.add({ opId, action, entityId, payload, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), _synced: false, attempts: 0 })
  })
  conflicts = conflicts.filter((item) => item.id !== entityId)
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
    if (item.action === 'upsertDoctor' && (await db.doctors.get(item.entityId))?._removedFromSheets) {
      blockedEntities.add(item.entityId)
      continue
    }
    if (item.validationError || item.retryStopped) { blockedEntities.add(item.entityId); continue }
    try {
      if (item.action === 'saveVisit') {
        const visit = item.payload as Visit
        const pendingDoctors = await db.queue.where('action').equals('upsertDoctor').toArray()
        if (pendingDoctors.some((next) => visit.doctorIds.includes(next.entityId))) {
          continue
        }
        if ((await db.doctors.toArray()).some(doctor => doctor._removedFromSheets && visit.doctorIds.includes(doctor.id))) continue
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
            _synced: !successors.length,
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
        }
        if (item.action === 'saveVisit') {
          const visit = item.payload as Visit
          const current = await db.visits.get(visit.localId)
          const successors = (await db.queue.where('entityId').equals(item.entityId).toArray()).filter(next => next.id !== item.id)
          if (current && !successors.length) await db.visits.put({ ...current, ...(result.visit as Visit), localId: current.localId, syncState: 'synced', _synced: true })
          // Undo must target the canonical row actually written by Sheets.
          if (result.visit) {
            for (const undo of await db.queue.where('entityId').equals(item.entityId).toArray()) {
              if (undo.action === 'undoVisit') await db.queue.update(undo.id!, { payload: { visit: result.visit as Visit } })
            }
          }
        }
        if (item.id !== undefined) await db.queue.delete(item.id)
      })
      conflicts = conflicts.filter(conflict => conflict.id !== item.entityId)
      await report()
    } catch (error) {
      blockedEntities.add(item.entityId)
      if (item.id !== undefined) {
        await db.queue.update(item.id, {
          attempts: item.attempts + 1,
          validationError: error instanceof ValidationError ? ((item.payload as Doctor).name || item.entityId) + ': ' + error.message : undefined,
          retryStopped: !(error instanceof ValidationError) && (!(error instanceof TransientError) || item.attempts + 1 >= MAX_ATTEMPTS),
          failureMessage: error instanceof Error ? error.message + ' Automatic retries paused. Tap the cloud icon to retry.' : 'Save failed',
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

async function applyBootstrap(payload: BootstrapPayload): Promise<void> {
  const skipped: SyncConflict[] = []
  await db.transaction('rw', db.queue, db.doctors, db.visits, db.meta, async () => {
    const queued = await db.queue.toArray()
    const remoteDoctorIds = new Set(payload.doctors.map(doctor => doctor.id))
    for (const local of await db.doctors.toArray()) {
      if (remoteDoctorIds.has(local.id)) {
        if (local._removedFromSheets) await db.doctors.update(local.id, { _removedFromSheets: false })
        continue
      }
      if (local._synced !== true || queued.some(item => item.action === 'upsertDoctor' && item.entityId === local.id)) {
        // Newly created offline doctors have never been in Sheets.
        if (!local.isNewRecord) {
          await db.doctors.update(local.id, { _removedFromSheets: true, _synced: false })
          skipped.push(removedConflict(local))
        }
      } else {
        await db.doctors.delete(local.id)
      }
    }
    // Earlier releases used row-position hashes as IDs. Reconcile only exact,
    // confirmed legacy matches; never delete a pending or unmatched visit.
    const legacyVisits = (await db.visits.toArray()).filter(visit => visit._legacyId && visit._synced
      && !queued.some(item => item.entityId === visit.localId))
    const visitContent = (visit: Visit) => JSON.stringify([visit.date, visit.camp, visit.kind, visit.doctorLines, visit.pharmacyLines])
    for (const remote of payload.visits) {
      if (await db.visits.get(remote.localId)) continue
      const index = legacyVisits.findIndex(local => visitContent(local) === visitContent(remote))
      if (index !== -1 && Number.isFinite(Date.parse(remote.updatedAt))) {
        const [legacy] = legacyVisits.splice(index, 1)
        await db.visits.delete(legacy.localId)
        await db.visits.put({ ...legacy, localId: remote.localId, _legacyId: false })
      }
    }
    // Doctors mirror the complete snapshot; pending edits stay local.
    for (const entity of ['doctor', 'visit'] as const) {
      const records = entity === 'doctor' ? payload.doctors : payload.visits
      for (const remote of records) {
        const id = entity === 'doctor' ? (remote as Doctor).id : (remote as Visit).localId
        const local = entity === 'doctor' ? await db.doctors.get(id) : await db.visits.get(id)
        const pending = queued.some(item => item.entityId === id)
        const label = entity === 'doctor' ? (local as Doctor | undefined)?.name || (remote as Doctor).name : (remote as Visit).date
        if (pending || (local && local._synced !== true)) {
          skipped.push({ entity, id, label, reason: 'Unsynced local changes kept' })
          continue
        }
        if (!Number.isFinite(Date.parse(remote.updatedAt))) throw new Error('Missing server timestamp. Deploy the updated Apps Script.')
        if (entity === 'visit' && local && Date.parse(remote.updatedAt) <= Date.parse(local.updatedAt)) {
          if (Date.parse(remote.updatedAt) < Date.parse(local.updatedAt)) skipped.push({ entity, id, label, reason: 'Older Sheets version skipped' })
          continue
        }
        if (entity === 'doctor') await db.doctors.put({ ...remote as Doctor, _synced: true, syncState: 'synced' })
        else await db.visits.put({ ...remote as Visit, _legacyId: false, _synced: true, syncState: 'synced' })
      }
      const locals = entity === 'doctor' ? await db.doctors.toArray() : await db.visits.toArray()
      for (const local of locals) {
        const id = entity === 'doctor' ? (local as Doctor).id : (local as Visit).localId
        if (!local._synced && !skipped.some(item => item.entity === entity && item.id === id)) {
          skipped.push({ entity, id, label: entity === 'doctor' ? (local as Doctor).name : (local as Visit).date,
            reason: 'Unsynced local changes kept' })
        }
      }
    }
    const master: MasterData = { settings: payload.settings, products: payload.products }
    const updatedAt = payload.serverTime
    await db.meta.put({ key: 'master', value: master, updatedAt, _synced: true })
    await db.meta.put({ key: 'lastSync', value: updatedAt, updatedAt, _synced: false })
    await db.meta.put({ key: 'remoteDoctorIds', value: [...remoteDoctorIds], updatedAt, _synced: true })
  })
  conflicts = skipped
}

async function performSync(): Promise<void> {
  if (resetting || !navigator.onLine) return report()
  // Take the read gate before checking the queue; edits after this point may be
  // stored locally, but cannot start a network write until the read finishes.
  refreshing = true
  readError = ''
  let pulled = false
  try {
    // Finish an already in-flight write, but do not start queued writes before
    // checking whether Sheets deleted their doctors.
    if (activeWrites) await activeWrites
    await coordinated(async () => {
      await report()
      const bootstrap = await getBootstrap()
      await applyBootstrap(bootstrap)
      await setMeta('lastSuccessfulSync', new Date().toISOString())
      pulled = true
    })
  } catch (error) {
    readError = error instanceof Error ? error.message : 'Could not refresh from Sheets'
  } finally {
    refreshing = false
    await report()
    if (pulled && !resetting) await flushChanges()
  }
}

export function flushChanges(): Promise<void> {
  if (resetting) return Promise.resolve()
  if (refreshing) { writeRequested = true; return Promise.resolve() }
  if (activeWrites) return activeWrites
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = undefined
  if (!navigator.onLine) return report()
  activeWrites = (async () => {
    writeError = ''
    await report()
    do {
      writeRequested = false
      await coordinated(pushQueue)
    } while (writeRequested)
    retryDelay = 2_000
  })().catch((error: unknown) => {
    writeError = error instanceof Error ? error.message : 'Could not save to Sheets'
  }).finally(async () => {
    activeWrites = null
    await report()
    const removed = new Set((await db.doctors.toArray()).filter(doctor => doctor._removedFromSheets).map(doctor => doctor.id))
    const retryable = (await db.queue.toArray()).filter(item => !removed.has(item.entityId)
      && !(item.action === 'saveVisit' && (item.payload as Visit).doctorIds.some(id => removed.has(id))))
    if (!refreshing && !resetting && hasRetryableChanges(retryable) && navigator.onLine) {
      retryTimer = window.setTimeout(() => { void flushChanges() }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
  })
  return activeWrites
}

export async function retrySync(): Promise<void> {
  // An uncertain write retains its operation ID, even after retry exhaustion.
  for (const item of await db.queue.toArray()) {
    if (item.retryStopped) await db.queue.update(item.id!, { retryStopped: false, attempts: 0, failureMessage: undefined })
  }
  return syncNow()
}

export async function resolveRemovedDoctor(id: string, choice: 'keep' | 'discard'): Promise<void> {
  if (resetting) throw new Error('Wait for the cache refresh to finish.')
  await coordinated(async () => {
    await db.transaction('rw', db.doctors, db.queue, async () => {
      const doctor = await db.doctors.get(id)
      if (!doctor?._removedFromSheets) return
      for (const item of await db.queue.where('entityId').equals(id).toArray()) {
        if (item.action === 'upsertDoctor') await db.queue.delete(item.id!)
      }
      if (choice === 'discard') {
        await db.doctors.delete(id)
      } else {
        const updatedAt = new Date().toISOString()
        const payload: Doctor = { ...doctor, _removedFromSheets: false, isNewRecord: false,
          _synced: false, syncState: 'pending', updatedAt }
        await db.doctors.put(payload)
        await db.queue.add({ opId: crypto.randomUUID(), action: 'upsertDoctor', entityId: id,
          payload, attempts: 0, createdAt: updatedAt, updatedAt, _synced: false })
      }
    })
    conflicts = conflicts.filter(item => item.id !== id)
    writeError = ''
  })
  await report()
  if (choice === 'keep') await flushChanges()
}

export async function clearLocalCacheAndRefresh(): Promise<void> {
  if (resetting) return
  if (!navigator.onLine) throw new Error('Connect to the internet before clearing the cache.')
  resetting = true
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = undefined
  try {
    // No old response may repopulate the cache after the reset.
    if (activeSync) await activeSync
    if (activeWrites) await activeWrites
    await report()
    await coordinated(async () => {
      // Validate the replacement first so a network error cannot destroy data.
      const payload = await getBootstrap()
      await db.transaction('rw', db.doctors, db.visits, db.queue, db.presets, db.meta, async () => {
        for (const table of [db.doctors, db.visits, db.queue, db.presets, db.meta]) await table.clear()
        await applyBootstrap(payload)
      })
      conflicts = []
      readError = ''
      writeError = ''
      writeRequested = false
      retryDelay = 2_000
    })
  } catch (error) {
    readError = error instanceof Error ? error.message : 'Could not refresh the cache'
    throw error
  } finally {
    resetting = false
    await report()
  }
}

export function syncNow(): Promise<void> {
  if (!activeSync) {
    activeSync = performSync().finally(() => {
      activeSync = null
    })
  }
  return activeSync
}
