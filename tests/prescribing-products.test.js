import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import vm from 'node:vm'
import test from 'node:test'
import handler from '../api/sync.js'
import { bundleGas } from '../scripts/build-gas.js'

const products = [
  ['PROD-001', 'Alpha', 'Tablet'],
  ['PROD-002', 'Alpha', 'Syrup'],
  ['PROD-003', 'Beta', ''],
  ['PROD-004', 'Gamma, Plus', 'Oral drops'],
  ['PROD-005', 'API-TOP', 'Syr'],
  ['PROD-006', 'REGAB-75', 'Tabs'],
]

function sheet(rows) {
  const notes = new WeakMap()
  const rowNotes = cells => {
    if (!notes.has(cells)) notes.set(cells, [])
    return notes.get(cells)
  }
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    appendRow: (row) => rows.push(row),
    insertRowBefore: row => rows.splice(row - 1, 0, []),
    deleteRow: (row) => rows.splice(row - 1, 1),
    deleteColumn: column => rows.forEach(cells => {
      cells.splice(column - 1, 1)
      rowNotes(cells).splice(column - 1, 1)
    }),
    setFrozenRows() {},
    getDataRange() { return this.getRange(1, 1, rows.length, rows[0].length) },
    getRange: (row, column, height = 1, width = 1) => ({
      getValues: () => rows.slice(row - 1, row - 1 + height)
        .map((cells) => cells.slice(column - 1, column - 1 + width)),
      getDisplayValues() { return this.getValues() },
      getValue() { return this.getValues()[0]?.[0] || '' },
      getNotes: () => rows.slice(row - 1, row - 1 + height)
        .map(cells => Array.from({ length: width }, (_, index) => rowNotes(cells)[column - 1 + index] || '')),
      getNote() { return this.getNotes()[0][0] },
      setNote: note => { rowNotes(rows[row - 1])[column - 1] = note },
      setWrap() { return this },
      setFontWeight() { return this },
      setBackground() { return this },
      setFontColor() { return this },
      setValues: (values) => values.forEach((cells, index) => {
        rows[row - 1 + index] ||= []
        rows[row - 1 + index].splice(column - 1, width, ...cells)
      }),
      sort: (specs) => {
        const sorted = rows.slice(row - 1, row - 1 + height).sort((a, b) => {
          for (const spec of specs) {
            const order = String(a[spec.column - 1]).localeCompare(String(b[spec.column - 1]))
            if (order) return spec.ascending ? order : -order
          }
          return 0
        })
        rows.splice(row - 1, height, ...sorted)
      },
    }),
  }
}

function fixture() {
  const properties = new Map()
  const context = vm.createContext({
    console,
    Utilities: { getUuid: randomUUID, DigestAlgorithm: { SHA_256: "sha256" }, computeDigest: (algorithm, value) => createHash(algorithm).update(value).digest(), base64EncodeWebSafe: value => Buffer.from(value).toString("base64url") },
    SpreadsheetApp: { flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key),
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: (key) => properties.delete(key),
    }) },
    ContentService: { MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }) },
  })
  vm.runInContext(bundleGas(), context)
  const sheets = {
    Doctors: sheet([Array.from(context.SHEET_HEADERS.Doctors)]),
    Products: sheet([['ProdID', 'Name', 'DosageForm'], ...products.map((row) => [...row])]),
    Settings: sheet([Array.from(context.SHEET_HEADERS.Settings),
      ['Town', 'General', 'Proddatur', '', '', '', '']]),
    Visits: sheet([Array.from(context.SHEET_HEADERS.Visits)]),
  }
  context.ACTIVE_SPREADSHEET_ = { getSheetByName: (name) => sheets[name] }
  const input = {
    id: 'local-1', isNewRecord: true, name: 'Test Doctor', area: 'Town',
    camp: 'Proddatur', specialties: ['General'], prescriber: 'Rx',
    prescribingProductIds: ['PROD-001', 'PROD-002'],
  }
  return { context, sheets, input }
}

test('creating and editing a doctor writes product names and dosage forms to Sheets', () => {
  const { context, sheets, input } = fixture()
  const result = context.upsertDoctor_(input)
  const column = sheets.Doctors.rows[0].indexOf('Prescribing Products')
  assert.equal(sheets.Doctors.rows[1][column], 'Alpha (Tablet), Alpha (Syrup)')
  assert.deepEqual(Array.from(result.doctor.prescribingProductIds), input.prescribingProductIds)
  const loaded = context.getDoctors_()[0]
  assert.deepEqual(Array.from(loaded.prescribingProductIds), input.prescribingProductIds)
  context.upsertDoctor_({ ...loaded, prescribingProductIds: ['PROD-003'] })
  assert.equal(sheets.Doctors.rows.length, 2)
  assert.equal(sheets.Doctors.rows[1][column], 'Beta')
  context.upsertDoctor_({ ...loaded, prescribingProductIds: ['PROD-004', 'PROD-002'] })
  assert.equal(sheets.Doctors.rows[1][column], 'Gamma, Plus (Oral drops), Alpha (Syrup)')
  assert.deepEqual(Array.from(context.getDoctors_()[0].prescribingProductIds), ['PROD-004', 'PROD-002'])
  context.upsertDoctor_({ ...loaded, prescriber: 'NRx' })
  assert.equal(sheets.Doctors.rows[1][column], '')
})

test('both read paths resolve labels and legacy IDs to selectable product IDs', async (t) => {
  const { context, sheets, input } = fixture()
  context.upsertDoctor_(input)
  const column = sheets.Doctors.rows[0].indexOf('Prescribing Products')
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(context.bootstrap_())))
  for (const [stored, expected] of [
    ['PROD-001, PROD-002', ['PROD-001', 'PROD-002']],
    ['Alpha (Tablet)\nAlpha (Syrup)', ['PROD-001', 'PROD-002']],
    ['Alpha (Syrup), Beta', ['PROD-002', 'PROD-003']],
    ['Gamma, Plus (Oral drops)', ['PROD-004']],
    ['Gamma, Plus (Oral drops)\nBeta', ['PROD-004', 'PROD-003']],
    ['Gamma, Plus (Oral drops), Alpha (Syrup), Beta', ['PROD-004', 'PROD-002', 'PROD-003']],
    ['["PROD-001","Alpha (Syrup)"]', ['PROD-001', 'PROD-002']],
    ['API-TOP  (Syrup), REGAB-75  (Tablets)', ['PROD-005', 'PROD-006']],
    ['  api-top\t (syr) , Gamma, Plus  (Oral drops)', ['PROD-005', 'PROD-004']],
    ['Alpha', ['Alpha']],
    ['Alpha (Drops)', ['Alpha (Drops)']],
    ['[Ljava.lang.Object;@5d23044d', ['[Ljava.lang.Object;@5d23044d']],
    ['Unknown product', ['Unknown product']],
    ['', []],
  ]) {
    sheets.Doctors.rows[1][column] = stored
    assert.deepEqual(Array.from(context.getDoctors_()[0].prescribingProductIds), expected)
    let payload
    const response = {
      setHeader() {}, status(code) { assert.equal(code, 200); return this },
      json(value) { payload = value },
    }
    await handler({ method: 'GET' }, response)
    assert.deepEqual(payload.doctors[0].prescribingProductIds, expected)
  }
})

test('invalid product IDs are rejected before writing a doctor', () => {
  const { context, sheets, input } = fixture()
  assert.throws(() => context.upsertDoctor_({ ...input, prescribingProductIds: ['missing'] }), /Product must come from/)
  assert.equal(sheets.Doctors.rows.length, 1)
})

test('new doctors stay in camp and ID order, and edits still target the correct doctor after sorting', () => {
  const { context, sheets, input } = fixture()
  for (let number = 1; number <= 15; number++) {
    context.upsertDoctor_({ ...input, name: `Proddatur Doctor ${number}` })
  }
  for (const camp of ['Zeta Camp', 'Alpha Camp']) {
    sheets.Settings.rows.push(['', '', camp, '', '', '', ''])
    context.upsertDoctor_({ ...input, name: `${camp} Doctor`, camp })
  }
  const saved = context.upsertDoctor_({ ...input, name: 'New Proddatur Doctor' }).doctor
  assert.equal(saved.id, 'PDTR-016')
  const header = sheets.Doctors.rows[0]
  const idColumn = header.indexOf('ID')
  const nameColumn = header.indexOf('Name')
  const ids = sheets.Doctors.rows.slice(1).map(row => row[idColumn])
  assert.deepEqual(ids, ['ALPH-001', ...Array.from({ length: 16 }, (_, index) => `PDTR-${String(index + 1).padStart(3, '0')}`), 'ZETA-001'])
  context.upsertDoctor_({ ...saved, name: 'Renamed Doctor', notes: 'Keep with PDTR-016' })
  const edited = sheets.Doctors.rows.find(row => row[idColumn] === 'PDTR-016')
  assert.equal(edited[nameColumn], 'Renamed Doctor')
  assert.equal(edited[header.indexOf('Notes')], 'Keep with PDTR-016')
  assert.equal(sheets.Doctors.rows.length, 19)
  assert.deepEqual(header, Array.from(context.SHEET_HEADERS.Doctors))
})

test('manual doctor sorting handles reordered columns and keeps extra cells with their record', () => {
  const { context, sheets } = fixture()
  sheets.Doctors.rows.splice(0, sheets.Doctors.rows.length,
    ['Remarks', 'Camp', 'DocID', 'Name', 'Extra'],
    ['third', 'Zeta', 'ZETA-001', 'Third', '=1+3'],
    ['second', 'Alpha', 'ALPH-010', 'Second', '=1+2'],
    ['first', 'Alpha', 'ALPH-009', 'First', '=1+1'])
  context.sortDoctors()
  assert.deepEqual(sheets.Doctors.rows, [
    ['Remarks', 'Camp', 'DocID', 'Name', 'Extra'],
    ['first', 'Alpha', 'ALPH-009', 'First', '=1+1'],
    ['second', 'Alpha', 'ALPH-010', 'Second', '=1+2'],
    ['third', 'Zeta', 'ZETA-001', 'Third', '=1+3'],
  ])
})

test('editing a legacy doctor and adding a product accepts existing spacing and dosage abbreviations', () => {
  const { context, sheets, input } = fixture()
  const created = context.upsertDoctor_(input).doctor
  const column = sheets.Doctors.rows[0].indexOf('Prescribing Products')
  sheets.Doctors.rows[1][column] = 'API-TOP  (Syrup), REGAB-75  (Tablets)'
  const existing = context.getDoctors_()[0]
  const result = context.upsertDoctor_({ ...existing,
    prescribingProductIds: [...existing.prescribingProductIds, 'PROD-004'] })
  assert.equal(result.doctor.id, created.id)
  assert.deepEqual(Array.from(result.doctor.prescribingProductIds), ['PROD-005', 'PROD-006', 'PROD-004'])
  assert.equal(sheets.Doctors.rows[1][column], 'API-TOP (Syr), REGAB-75 (Tabs), Gamma, Plus (Oral drops)')
})

test('normalizing product IDs preserves readable doctor cells', () => {
  const { context, sheets, input } = fixture()
  context.upsertDoctor_({ ...input, prescribingProductIds: ['PROD-004', 'PROD-002'] })
  const column = sheets.Doctors.rows[0].indexOf('Prescribing Products')
  sheets.Products.rows[1][0] = 'legacy-alpha'
  context.normalizeProductIds_(context.ACTIVE_SPREADSHEET_)
  assert.equal(sheets.Doctors.rows[1][column], 'Gamma, Plus (Oral drops), Alpha (Syrup)')
  sheets.Products.rows[1][0] = 'legacy-alpha'
  sheets.Doctors.rows[1][column] = 'legacy-alpha, Gamma, Plus (Oral drops)'
  context.normalizeProductIds_(context.ACTIVE_SPREADSHEET_)
  assert.equal(sheets.Doctors.rows[1][column], 'PROD-001, Gamma, Plus (Oral drops)')
})

test('retrying a new-doctor save returns the assigned doctor ID without adding another row', () => {
  const { context, sheets, input } = fixture()
  const request = { postData: { contents: JSON.stringify({ opId: 'stable-op', action: 'upsertDoctor', payload: input }) } }
  const first = context.doPost(request)
  const retry = context.doPost(request)
  assert.equal(first.success, true)
  assert.equal(retry.success, true)
  assert.equal(retry.doctor?.id, first.doctor.id)
  assert.equal(sheets.Doctors.rows.length, 2)
})

test('equivalent forms with more than one matching master row are not guessed', () => {
  const { context, sheets } = fixture()
  sheets.Products.rows.push(['PROD-007', 'API-TOP', 'Syrup'])
  const products = context.getProducts_()
  assert.deepEqual(Array.from(context.productIdsFromCell_('API-TOP (Syrup)', products)), ['API-TOP (Syrup)'])
  assert.deepEqual(Array.from(context.productIdsFromCell_('PROD-007', products)), ['PROD-007'])
})

test('setup creates only the four supported tabs and preserves existing records on repeat runs', () => {
  const { context, sheets, input } = fixture()
  context.upsertDoctor_(input)
  delete sheets.Visits
  const before = Object.fromEntries(Object.entries(sheets).map(([name, value]) => [name, JSON.stringify(value.rows)]))
  context.ACTIVE_SPREADSHEET_.insertSheet = name => sheets[name] = sheet([['']])
  context.setupSpreadsheet()
  context.setupSpreadsheet()
  assert.deepEqual(sheets.Visits.rows[0], Array.from(context.SHEET_HEADERS.Visits))
  assert.deepEqual(Object.keys(sheets).sort(), ['Doctors', 'Products', 'Settings', 'Visits'])
  for (const [name, rows] of Object.entries(before)) assert.equal(JSON.stringify(sheets[name].rows), rows)
})

test('GAS versions remain stable on reads and advance for direct Sheet edits', () => {
  const { context, sheets, input } = fixture()
  const saved = context.upsertDoctor_(input).doctor
  assert.equal(context.getDoctors_()[0].updatedAt, saved.updatedAt)
  sheets.Doctors.rows[1][sheets.Doctors.rows[0].indexOf('Name')] = 'Edited in Sheets'
  const edited = context.getDoctors_()[0]
  assert.ok(edited.updatedAt > saved.updatedAt)
  assert.equal(context.getDoctors_()[0].updatedAt, edited.updatedAt)
})

test('visits retain IDs across row insertion, recover duplicate receipts, and accept offline dates', () => {
  const { context, sheets } = fixture()
  const visit = { localId: 'offline-visit', date: '2020-01-01', camp: 'Proddatur', kind: 'Leave' }
  const request = { postData: { contents: JSON.stringify({ action: 'saveVisit', opId: 'visit-op', payload: visit }) } }
  const saved = context.doPost(request)
  assert.equal(saved.success, true)
  assert.equal(saved.visit.localId, visit.localId)
  assert.equal(context.doPost(request).visit.updatedAt, saved.visit.updatedAt)
  context.saveVisit_({ ...visit, localId: 'second-visit' })
  const loaded = context.getVisits_().find(item => item.localId === visit.localId)
  assert.equal(loaded.updatedAt, saved.visit.updatedAt)
  assert.equal(sheets.Visits.rows.length, 3)
  context.undoVisit_(saved.visit)
  assert.equal(context.getVisits_().some(item => item.localId === visit.localId), false)
})

test('health verifies all four exact header sets and rejects missing required headers', () => {
  const { context, sheets } = fixture()
  assert.equal(context.health_().schemaVersion, 2)
  assert.deepEqual(Object.keys(context.health_().tabs).sort(), ['Doctors', 'Products', 'Settings', 'Visits'])
  sheets.Doctors.rows[0][0] = 'Missing ID'
  assert.throws(() => context.health_(), /missing exact headers ID/)
})

test('retired-tab cleanup deletes only DoctorAvailability and does not recreate it', () => {
  const { context, sheets, input } = fixture()
  const saved = context.upsertDoctor_({ ...input, availability: [{ days: ['Mon'], from: '09:00' }] }).doctor
  assert.equal('availability' in saved, false)
  sheets.DoctorAvailability = sheet([['Doctor ID', 'Days', 'From', 'Until', 'Notes'], [saved.id, 'Mon', '09:00', '', '']])
  sheets.Custom = sheet([['Keep'], ['custom data']])
  const kept = Object.fromEntries(Object.entries(sheets).filter(([name]) => name !== 'DoctorAvailability')
    .map(([name, value]) => [name, JSON.stringify(value.rows)]))
  const deleted = []
  context.ACTIVE_SPREADSHEET_.deleteSheet = target => {
    const name = Object.keys(sheets).find(name => sheets[name] === target)
    deleted.push(name)
    delete sheets[name]
  }
  context.removeDoctorAvailability()
  context.removeDoctorAvailability()
  context.setupSpreadsheet()
  assert.deepEqual(deleted, ['DoctorAvailability'])
  assert.equal(sheets.DoctorAvailability, undefined)
  for (const [name, rows] of Object.entries(kept)) assert.equal(JSON.stringify(sheets[name].rows), rows)
  assert.equal(context.getDoctors_()[0].updatedAt, saved.updatedAt)
  assert.equal(context.bootstrap_().success, true)
})

test('removing legacy sync columns preserves versions, records, custom cells and user notes', () => {
  const { context, sheets, input } = fixture()
  const doctor = context.upsertDoctor_(input).doctor
  const visit = context.saveVisit_({ localId: 'migrate-visit', date: '2020-01-01', camp: 'Proddatur', kind: 'Leave' }).visit
  for (const [name, idHeader] of [['Doctors', 'ID'], ['Visits', 'Visit ID']]) {
    const target = sheets[name]
    const cell = target.getRange(2, target.rows[0].indexOf(idHeader) + 1)
    const metadata = JSON.parse(cell.getNote().slice('MedRep sync: '.length))
    // Recreate legacy storage, with metadata columns in different positions.
    target.rows[0].unshift('SyncHash')
    target.rows[1].unshift(metadata.hash)
    target.rows[0].push('Custom', 'UpdatedAt')
    target.rows[1].push('keep me', metadata.updatedAt)
    target.getRange(2, target.rows[0].indexOf(idHeader) + 1).setNote('My own note')
  }
  const records = Object.fromEntries(['Doctors', 'Visits'].map(name => [name,
    Object.fromEntries(sheets[name].rows[0].map((header, i) => [header, sheets[name].rows[1][i]])
      .filter(([header]) => !['UpdatedAt', 'SyncHash'].includes(header)))]))
  context.removeSyncColumns()
  context.removeSyncColumns()
  context.setupSpreadsheet()
  for (const [name, idHeader] of [['Doctors', 'ID'], ['Visits', 'Visit ID']]) {
    const target = sheets[name]
    assert.equal(target.rows[0].includes('UpdatedAt'), false)
    assert.equal(target.rows[0].includes('SyncHash'), false)
    assert.deepEqual(Object.fromEntries(target.rows[0].map((header, i) => [header, target.rows[1][i]])), records[name])
    assert.match(target.getRange(2, target.rows[0].indexOf(idHeader) + 1).getNote(), /^My own note\nMedRep sync: /)
  }
  assert.equal(context.getDoctors_()[0].updatedAt, doctor.updatedAt)
  assert.equal(context.getVisits_()[0].updatedAt, visit.updatedAt)
  assert.equal(context.health_().success, true)
  const edited = context.upsertDoctor_({ ...doctor, notes: 'After migration' }).doctor
  assert.ok(edited.updatedAt > doctor.updatedAt)
  assert.equal(context.getDoctors_()[0].updatedAt, edited.updatedAt)
  sheets.Visits.rows[1][sheets.Visits.rows[0].indexOf('Camp')] = 'Edited in Sheets'
  assert.ok(context.getVisits_()[0].updatedAt > visit.updatedAt)
})

test('migration leaves columns intact if metadata cannot be saved', () => {
  const { context, sheets, input } = fixture()
  context.upsertDoctor_(input)
  sheets.Doctors.rows[0].push('UpdatedAt', 'SyncHash')
  sheets.Doctors.rows[1].push('2020-01-01T00:00:00.000Z', 'old hash')
  const cell = sheets.Doctors.getRange(2, 1)
  cell.setNote('')
  const getRange = sheets.Doctors.getRange
  sheets.Doctors.getRange = (...args) => ({ ...getRange(...args), setNote() { throw new Error('Cannot write metadata') } })
  assert.throws(() => context.removeSyncColumns(), /Cannot write metadata/)
  assert.ok(sheets.Doctors.rows[0].includes('UpdatedAt'))
  assert.ok(sheets.Doctors.rows[0].includes('SyncHash'))
})

test('ID-cell versions follow sorted records and identical saves advance the acknowledged version', () => {
  const { context, sheets, input } = fixture()
  const first = context.upsertDoctor_(input).doctor
  sheets.Settings.rows.push(['', '', 'Alpha', '', '', '', ''])
  context.upsertDoctor_({ ...input, name: 'Sorted first', camp: 'Alpha' })
  assert.equal(context.getDoctors_().find(record => record.id === first.id).updatedAt, first.updatedAt)
  const saved = context.upsertDoctor_(first).doctor
  assert.ok(saved.updatedAt > first.updatedAt)
  assert.equal(context.getDoctors_().find(record => record.id === first.id).updatedAt, saved.updatedAt)
})
