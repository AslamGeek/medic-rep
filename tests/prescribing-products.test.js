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
  ['PROD-005', 'API-TOP', 'Syr'],
  ['PROD-006', 'REGAB-75', 'Tabs'],
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
