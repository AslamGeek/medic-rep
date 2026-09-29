import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as productReferences from '../shared/products.js'

const clone = (value) => value === undefined ? undefined : structuredClone(value)
function table(key) {
  const rows = new Map()
  let sequence = 0
  function collection(select) {
    return {
      toArray: async () => clone(select()),
      first: async () => clone(select()[0]),
      count: async () => select().length,
      filter: (predicate) => collection(() => select().filter(predicate)),
      delete: async () => select().forEach((row) => rows.delete(row[key])),
    }
  }
  const all = () => [...rows.values()]
  return {
    ...collection(all),
    async put(value) { const row = clone(value); row[key] ??= ++sequence; rows.set(row[key], row); return row[key] },
    async add(value) { return this.put(value) },
    async bulkPut(values) { for (const value of values) await this.put(value) },
    async get(id) { return clone(rows.get(id)) },
    async delete(id) { rows.delete(id) },
    async update(id, changes) { if (rows.has(id)) rows.set(id, { ...rows.get(id), ...clone(changes) }) },
    orderBy: (field) => collection(() => all().sort((a, b) => String(a[field]).localeCompare(String(b[field])))),
    where: (field) => ({ equals: (value) => collection(() => all().filter((row) => row[field] === value)) }),
  }
}

const doctor = { updatedAt: '2026-09-02T00:00:00.000Z', _synced: true, id: 'PDTR-001', name: 'Updated name', syncState: 'pending', prescribingProductIds: [] }
const bootstrap = { schemaVersion: 2, success: true, doctors: [], visits: [], settings: {}, products: [], serverTime: '2026-09-03T00:00:00.000Z' }
const response = (data) => ({ ok: true, text: async () => JSON.stringify(data) })
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

function setup(fetch, options = {}) {
  const db = options.db || { doctors: table('id'), visits: table('localId'), queue: table('id'), meta: table('key'),
    transaction: async (...args) => args.at(-1)() }
  const events = []
  const timers = new Map()
  let nextTimer = 0
  const window = {
    location: { origin: 'https://test.example' },
    dispatchEvent: (event) => events.push(event.detail),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  const exports = {}
  const navigator = { onLine: true, locks: options.locks }
  const context = vm.createContext({
    Error, TypeError, exports, window, navigator, crypto, URL, AbortController, DOMException,
    CustomEvent, console, setTimeout, clearTimeout,
    require: (name) => {
      if (name === './db') return { db, setMeta: (key, value) => db.meta.put({ key, value }) }
      if (name === './config') return { SYNC_API_URL: '/api/sync', READ_TIMEOUT_MS: 12000, WRITE_TIMEOUT_MS: 55000 }
      if (name === '../shared/products.js') return productReferences
      throw new Error(`Unexpected import: ${name}`)
    },
    fetch,
  })
  const source = readFileSync(new URL('../src/sync.ts', import.meta.url), 'utf8')
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { db, sync: exports, events, timers, navigator }
}

test('a failed refresh does not prevent an already queued doctor save', async () => {
  const calls = []
  const { db, sync } = setup(async (_url, init) => {
    calls.push(init.method)
    if (init.method === 'GET') throw new Error('Sheets read unavailable')
    return response({ success: true, doctor })
  })
  await db.doctors.put(doctor)
  await db.queue.add({ opId: 'op-1', action: 'upsertDoctor', entityId: doctor.id, payload: doctor, attempts: 0, createdAt: '1' })
  await sync.syncNow()
  assert.ok(calls.includes('POST'), 'A failing Sheets read blocked the save request')
  assert.equal(await db.queue.count(), 0)
})

test('an older Apps Script response cannot silently acknowledge unsaved call windows', async () => {
  const pendingDoctor = { ...doctor, availability: [{ days: ['Tue'], from: '10:00', until: '11:00', notes: '' }] }
  const { db, sync } = setup(async () => response({ success: true, doctor }))
  await db.doctors.put(pendingDoctor)
  await db.queue.add({ opId: 'windows-old-deployment', action: 'upsertDoctor', entityId: doctor.id,
    payload: pendingDoctor, attempts: 0, createdAt: '1' })
  await sync.flushChanges()
  assert.equal(await db.queue.count(), 1)
  assert.match((await db.queue.toArray())[0].validationError, /update Apps Script/)
  assert.deepEqual((await db.doctors.get(doctor.id)).availability, pendingDoctor.availability)
})

test('an edit waits until the active refresh finishes before pushing', async () => {
  const read = deferred()
  const calls = []
  const { db, sync } = setup(async (_url, init) => {
    calls.push(init.method)
    if (init.method === 'GET') return read.promise
    return response({ success: true, doctor })
  })
  const refresh = sync.syncNow()
  await tick()
  await db.doctors.put(doctor)
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  const save = sync.syncNow()
  await tick()
  try {
    assert.equal(calls.includes('POST'), false, 'Push overlapped an active pull')
  } finally {
    read.resolve(response(bootstrap))
    await Promise.all([refresh, save])
  }
})

test('pull preserves a newer confirmed local record', async () => {
  const { db, sync } = setup(async () => response({ ...bootstrap,
    doctors: [{ ...doctor, name: 'Stale sheet', updatedAt: '2026-09-01T00:00:00.000Z' }],
  }))
  await db.doctors.put({ ...doctor, _synced: true, syncState: 'synced', updatedAt: '2026-09-02T00:00:00.000Z' })
  await sync.syncNow()
  assert.equal((await db.doctors.get(doctor.id)).name, doctor.name)
})

test('pull preserves and reports an unsynced record even without a queue entry', async () => {
  const { db, sync, events } = setup(async () => response({ ...bootstrap,
    doctors: [{ ...doctor, name: 'Sheet edit', updatedAt: '2026-09-03T00:00:00.000Z' }],
  }))
  await db.doctors.put({ ...doctor, _synced: false, updatedAt: '2026-09-02T00:00:00.000Z' })
  await sync.syncNow()
  assert.equal((await db.doctors.get(doctor.id)).name, doctor.name)
  assert.ok(events.at(-1).conflicts?.some(item => item.id === doctor.id))
})

test('an older save acknowledgement cannot overwrite a newer local edit', async () => {
  const firstWrite = deferred()
  const secondWrite = deferred()
  let writes = 0
  const { db, sync } = setup(async (_url, init) => {
    if (init.method === 'GET') return response(bootstrap)
    writes += 1
    return writes === 1 ? firstWrite.promise : secondWrite.promise
  })
  await db.doctors.put(doctor)
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  const saving = sync.syncNow()
  await tick()
  const newer = { ...doctor, name: 'Newest name' }
  await db.doctors.put(newer)
  await sync.queueChange('upsertDoctor', doctor.id, newer)
  firstWrite.resolve(response({ success: true, doctor }))
  await tick()
  try {
    assert.equal((await db.doctors.get(doctor.id)).name, 'Newest name')
    assert.equal((await db.doctors.get(doctor.id)).syncState, 'pending')
  } finally {
    secondWrite.resolve(response({ success: true, doctor: newer }))
    await saving
  }
})

test('a failed write automatically retries after two seconds without fetching Sheets first', async () => {
  let attempts = 0
  const { db, sync, timers } = setup(async (_url, init) => {
    assert.equal(init.method, 'POST')
    attempts += 1
    if (attempts === 1) throw new TypeError('Temporary network failure')
    return response({ success: true, doctor })
  })
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  await sync.flushChanges()
  assert.equal(await db.queue.count(), 1)
  const retry = [...timers.values()].find((timer) => timer.delay === 2000)
  assert.ok(retry, 'No prompt retry was scheduled')
  retry.callback()
  await sync.flushChanges()
  assert.equal(attempts, 2)
  assert.equal(await db.queue.count(), 0)
})

test('a refresh that started before an edit cannot revert its successful save', async () => {
  const read = deferred()
  const { db, sync } = setup(async (_url, init) => init.method === 'GET'
    ? read.promise : response({ success: true, doctor }))
  const refresh = sync.syncNow()
  await tick()
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  await sync.flushChanges()
  read.resolve(response({ ...bootstrap, doctors: [{ ...doctor, name: 'Old sheet name' }] }))
  await refresh
  assert.equal((await db.doctors.get(doctor.id)).name, doctor.name)
})

test('edits queued during creation use the doctor ID assigned by Sheets', async () => {
  const first = deferred()
  const posted = []
  const { db, sync } = setup(async (_url, init) => {
    const payload = JSON.parse(init.body).payload
    posted.push(payload)
    if (posted.length === 1) return first.promise
    return response({ success: true, doctor: payload })
  })
  const draft = { ...doctor, id: 'temporary-id', isNewRecord: true }
  await sync.queueChange('upsertDoctor', draft.id, draft)
  await tick()
  await sync.queueChange('upsertDoctor', draft.id, { ...draft, name: 'Newest draft' })
  first.resolve(response({ success: true, doctor }))
  await sync.flushChanges()
  assert.equal(posted.length, 2)
  assert.equal(posted[1].id, doctor.id)
  assert.equal(posted[1].isNewRecord, false)
  assert.equal(posted[1].name, 'Newest draft')
  assert.equal(await db.doctors.get(draft.id), undefined)
  assert.equal((await db.doctors.get(doctor.id)).name, 'Newest draft')
})

test('failed earlier edits cannot be overtaken by newer edits for the same doctor', async () => {
  const posted = []
  const { db, sync } = setup(async (_url, init) => {
    posted.push(JSON.parse(init.body).payload.name)
    throw new Error('Temporarily unavailable')
  })
  for (const [id, name] of [[1, 'First edit'], [2, 'Second edit']]) {
    await db.queue.add({ id, opId: `op-${id}`, action: 'upsertDoctor', entityId: doctor.id,
      payload: { ...doctor, name }, attempts: 0, createdAt: String(id) })
  }
  await sync.flushChanges()
  assert.deepEqual(posted, ['First edit'])
  assert.equal(await db.queue.count(), 2)
})

test('undo during an in-flight visit save uses the canonical row and does not resurrect the visit', async () => {
  const save = deferred()
  const visit = { localId: 'visit-1', doctorIds: [], doctorLines: ['Client name'], syncState: 'pending' }
  const canonical = { ...visit, updatedAt: '2026-09-03T00:00:00.000Z', localId: 'server-visit-1', doctorLines: ['Canonical name'] }
  const posted = []
  const { db, sync } = setup(async (_url, init) => {
    const operation = JSON.parse(init.body)
    posted.push(operation)
    return operation.action === 'saveVisit' ? save.promise : response({ success: true })
  })
  await sync.queueChange('saveVisit', visit.localId, visit)
  await tick()
  await sync.queueChange('undoVisit', visit.localId, { visit })
  save.resolve(response({ success: true, visit: canonical }))
  await sync.flushChanges()
  assert.equal(posted[1].action, 'undoVisit')
  assert.deepEqual(posted[1].payload.visit.doctorLines, canonical.doctorLines)
  assert.equal(await db.visits.count(), 0)
  assert.equal(await db.queue.count(), 0)
})

test('on-demand refresh imports direct Sheet edits when no local change is pending', async () => {
  const { db, sync } = setup(async () => response({
    ...bootstrap, doctors: [{ ...doctor, name: 'Name edited in Sheets', updatedAt: '2026-09-03T00:00:00.000Z' }],
  }))
  await db.doctors.put({ ...doctor, syncState: 'synced' })
  await sync.syncNow()
  assert.equal((await db.doctors.get(doctor.id)).name, 'Name edited in Sheets')
})

test('an already queued specialty edit repairs legacy product labels before sending', async () => {
  let sent
  const { db, sync } = setup(async (_url, init) => {
    sent = JSON.parse(init.body).payload
    return response({ success: true, doctor: sent })
  })
  await db.meta.put({ key: 'master', value: { products: [{ prodId: 'PROD-006', name: 'API-TOP', dosageForm: 'Syr' }] } })
  const queued = { ...doctor, prescriber: 'Rx', specialties: ['General'], prescribingProductIds: ['API-TOP  (Syrup)'] }
  await db.queue.add({ id: 1, opId: 'old-op', action: 'upsertDoctor', entityId: doctor.id, payload: queued, attempts: 8 })
  await sync.flushChanges()
  assert.deepEqual(sent.prescribingProductIds, ['PROD-006'])
  assert.deepEqual(sent.specialties, ['General'])
  assert.equal(await db.queue.count(), 0)
})

test('a validation rejection pauses automatic retry and a corrected edit replaces it', async () => {
  const sent = []
  const { db, sync, timers } = setup(async (_url, init) => {
    const operation = JSON.parse(init.body)
    sent.push(operation)
    return operation.payload.name === 'Invalid edit'
      ? response({ success: false, message: 'Product must come from the spreadsheet master list.' })
      : response({ success: true, doctor: operation.payload })
  })
  await sync.queueChange('upsertDoctor', doctor.id, { ...doctor, name: 'Invalid edit' })
  await sync.flushChanges()
  assert.ok((await db.queue.toArray())[0].validationError)
  assert.equal([...timers.values()].some((timer) => timer.delay <= 30000), false)
  await sync.queueChange('upsertDoctor', doctor.id, { ...doctor, name: 'Corrected edit' })
  await sync.flushChanges()
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0].opId, sent[1].opId)
  assert.equal(sent[1].payload.name, 'Corrected edit')
  assert.equal(await db.queue.count(), 0)
})

test('offline edits persist and become confirmed on reconnection', async () => {
  const { db, sync, navigator } = setup(async () => response({ success: true, doctor }))
  navigator.onLine = false
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  assert.equal((await db.doctors.get(doctor.id))._synced, false)
  assert.equal(await db.queue.count(), 1)
  navigator.onLine = true
  await sync.flushChanges()
  assert.equal((await db.doctors.get(doctor.id))._synced, true)
  assert.equal((await db.doctors.get(doctor.id)).updatedAt, doctor.updatedAt)
  assert.equal(await db.queue.count(), 0)
})

test('refresh defers while a failed write remains queued', async () => {
  const methods = []
  const { db, sync, events } = setup(async (_url, init) => {
    methods.push(init.method)
    throw new TypeError('fetch failed')
  })
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  await sync.syncNow()
  assert.deepEqual(methods, ['POST'])
  assert.equal(await db.queue.count(), 1)
  assert.ok(events.at(-1).conflicts.some(item => item.id === doctor.id))
})

test('refresh never retries master-list validation failures', async () => {
  let calls = 0
  const { db, sync, timers } = setup(async () => {
    calls++
    return response({ success: false, message: 'Area must come from the spreadsheet master list.' })
  })
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  await sync.flushChanges()
  await sync.syncNow()
  await sync.retrySync()
  assert.equal(calls, 1)
  assert.ok((await db.queue.toArray())[0].validationError)
  assert.equal(timers.size, 0)
})

test('transient retries stop after eight attempts and manual retry preserves the operation ID', async () => {
  const posted = []
  const { db, sync, timers } = setup(async (_url, init) => {
    if (init.method === 'GET') return response(bootstrap)
    posted.push(JSON.parse(init.body).opId)
    if (posted.length <= 8) throw new TypeError('fetch failed')
    return response({ success: true, doctor })
  })
  const opId = await sync.queueChange('upsertDoctor', doctor.id, doctor)
  await sync.flushChanges()
  for (let i = 1; i < 8; i++) await sync.flushChanges()
  assert.equal((await db.queue.toArray())[0].retryStopped, true)
  assert.equal(timers.size, 0)
  await sync.flushChanges()
  assert.equal(posted.length, 8)
  await sync.retrySync()
  assert.equal(posted.length, 9)
  assert.ok(posted.every(id => id === opId))
  assert.equal(await db.queue.count(), 0)
})

test('non-transient API failures do not retry automatically', async () => {
  const { db, sync, timers } = setup(async () => ({ ok: false, status: 502,
    text: async () => JSON.stringify({ success: false, retryable: false, message: 'Deploy Apps Script' }) }))
  await sync.queueChange('upsertDoctor', doctor.id, doctor)
  await sync.flushChanges()
  assert.equal((await db.queue.toArray())[0].retryStopped, true)
  assert.equal(timers.size, 0)
})

test('a second browser tab cannot push while the first tab is pulling', async () => {
  let tail = Promise.resolve()
  const locks = { request(_name, work) { const next = tail.then(work); tail = next.catch(() => {}); return next } }
  const read = deferred()
  let posts = 0
  const fetch = async (_url, init) => {
    if (init.method === 'GET') return read.promise
    posts++
    return response({ success: true, doctor })
  }
  const first = setup(fetch, { locks })
  const second = setup(fetch, { locks, db: first.db })
  const refresh = first.sync.syncNow()
  await tick()
  await second.sync.queueChange('upsertDoctor', doctor.id, doctor)
  await tick()
  assert.equal(posts, 0)
  read.resolve(response({ ...bootstrap, doctors: [{ ...doctor, name: 'Stale' }] }))
  await refresh
  await second.sync.flushChanges()
  assert.equal(posts, 1)
  assert.equal((await first.db.doctors.get(doctor.id)).name, doctor.name)
})

test('legacy confirmed visit IDs reconcile without duplicating rows or touching pending work', async () => {
  const visit = { localId: 'new-stable-id', date: '2026-09-20', camp: 'Camp', kind: 'Leave',
    doctorLines: ['NO_VISIT:Leave'], pharmacyLines: [], updatedAt: '2026-09-20T00:00:00.000Z', _synced: true }
  const { db, sync } = setup(async () => response({ ...bootstrap, visits: [visit] }))
  await db.visits.put({ ...visit, localId: 'server-old-hash', _legacyId: true, updatedAt: '1970-01-01T00:00:00.000Z' })
  await db.visits.put({ ...visit, localId: 'pending-id', _legacyId: true, _synced: false })
  await sync.syncNow()
  assert.equal(await db.visits.count(), 2)
  assert.equal(await db.visits.get('server-old-hash'), undefined)
  assert.equal((await db.visits.get('pending-id'))._synced, false)
  assert.equal((await db.visits.get(visit.localId))._synced, true)
})
