import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import handler from '../api/sync.js'

const products = [
  ['PROD-001', 'Alpha', 'Tablet'],
  ['PROD-002', 'Alpha', 'Syrup'],
  ['PROD-003', 'Beta', ''],
  ['PROD-004', 'Gamma, Plus', 'Oral drops'],
]

function sheet(rows) {
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    appendRow: (row) => rows.push(row),
    getDataRange() { return this.getRange(1, 1, rows.length, rows[0].length) },
    getRange: (row, column, height = 1, width = 1) => ({
      getValues: () => rows.slice(row - 1, row - 1 + height)
        .map((cells) => cells.slice(column - 1, column - 1 + width)),
      getDisplayValues() { return this.getValues() },
      setValues: (values) => values.forEach((cells, index) => {
        rows[row - 1 + index].splice(column - 1, width, ...cells)
      }),
    }),
  }
}

function fixture() {
  const properties = new Map()
  const context = vm.createContext({
    console,
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
  vm.runInContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), context)
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
  t.mock.method(globalThis, 'fetch', async (url) => ({
    ok: true,
    text: async () => sheets[new URL(url).searchParams.get('sheet')].rows
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
      .join('\n'),
  }))
  for (const [stored, expected] of [
    ['PROD-001, PROD-002', ['PROD-001', 'PROD-002']],
    ['Alpha (Tablet)\nAlpha (Syrup)', ['PROD-001', 'PROD-002']],
    ['Alpha (Syrup), Beta', ['PROD-002', 'PROD-003']],
    ['Gamma, Plus (Oral drops)', ['PROD-004']],
    ['Gamma, Plus (Oral drops)\nBeta', ['PROD-004', 'PROD-003']],
    ['Gamma, Plus (Oral drops), Alpha (Syrup), Beta', ['PROD-004', 'PROD-002', 'PROD-003']],
    ['["PROD-001","Alpha (Syrup)"]', ['PROD-001', 'PROD-002']],
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
