import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as productReferences from '../shared/products.js'

const require = createRequire(import.meta.url)
const load = (file, imports) => {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, structuredClone, require: name => name in imports ? imports[name] : require(name) })
  return exports
}
const utils = load('../src/utils.ts', { '../shared/products.js': productReferences })
const logic = load('../src/directoryFilters.ts', { './utils': utils })
const { indexDirectory, filterDirectory } = logic
const empty = () => ({ area: [], camp: [], specialty: [], callSchedule: [], product: [], potential: [], prescriber: [] })
const { Directory, FilterSheet } = load('../src/components/Directory.tsx', {
  '../directoryFilters': logic, '../utils': utils, '../types': { EMPTY_FILTERS: empty() },
  '../config': { MAX_VISIBLE_DOCTORS: 100 }, './DirectoryFilters.css': {},
})
const products = [
  { prodId: 'P1', name: 'Cetrizine', dosageForm: 'Tablet' },
  { prodId: 'P2', name: 'Vitamin', dosageForm: '' },
  { prodId: 'P3', name: 'Unused', dosageForm: '' },
]
const settings = { areas: ['Gandhi Road', 'Market', 'Empty'], specialties: ['RMP', 'Cardiology', 'Unused'],
  camps: ['Morning Visit', 'Evening Visit'], callSchedules: ['Daily'], potentials: ['High'], stockists: [], opTimings: [] }
const doctor = (id, area, specialties, prescribingProductIds, camp = 'Morning Visit') => ({
  id, name: 'Doctor ' + id, area, specialties, prescribingProductIds, camp, prescriber: 'Rx',
  hospital: '', pharmacy: '', callSchedule: 'Daily', potential: 'High',
})
const doctors = [
  doctor('1', 'Gandhi Road', ['RMP', 'RMP'], ['P1', 'P1']),
  doctor('2', 'Gandhi Road', ['Cardiology'], ['P2'], 'Evening Visit'),
  doctor('3', 'Market', ['RMP'], ['P1', 'P2']),
  { ...doctor('4', 'Market', ['RMP'], [], 'Evening Visit'), prescriber: 'NRx' },
]
const index = indexDirectory(doctors, products, settings)
const derive = (filters = {}, query = '') => filterDirectory(index, query, { ...empty(), ...filters })
const counts = (result, key) => Object.fromEntries(result.groups.find(group => group.key === key).items.map(item => [item.id, item.count]))
const plain = value => JSON.parse(JSON.stringify(value))

test('all seven groups show live counts, count a doctor once, and omit zero-count options', () => {
  const result = derive()
  assert.deepEqual(counts(result, 'area'), { 'Gandhi Road': 2, Market: 2 })
  assert.deepEqual(counts(result, 'specialty'), { RMP: 3, Cardiology: 1 })
  assert.deepEqual(counts(result, 'product'), { P1: 2, P2: 2 })
  assert.deepEqual(counts(result, 'camp'), { 'Morning Visit': 2, 'Evening Visit': 2 })
  assert.deepEqual(counts(result, 'prescriber'), { Rx: 3, NRx: 1 })
  assert.deepEqual(counts(result, 'callSchedule'), { Daily: 4 })
  assert.deepEqual(counts(result, 'potential'), { High: 4 })
})

test('area then specialty cascades into product and camp; every count uses final results', () => {
  const area = derive({ area: ['Gandhi Road'] })
  assert.deepEqual(counts(area, 'specialty'), { RMP: 1, Cardiology: 1 })
  const specialty = derive({ ...area.filters, specialty: ['RMP'] })
  assert.deepEqual(counts(specialty, 'area'), { 'Gandhi Road': 1 })
  assert.deepEqual(counts(specialty, 'product'), { P1: 1 })
  assert.deepEqual(counts(specialty, 'camp'), { 'Morning Visit': 1 })
  assert.deepEqual(plain(specialty.doctors.map(item => item.id)), ['1'])
  const restored = derive({ ...specialty.filters, specialty: [] })
  assert.deepEqual(counts(restored, 'product'), { P1: 1, P2: 1 })
  assert.deepEqual(counts(derive(), 'area'), { 'Gandhi Road': 2, Market: 2 })
})

test('invalid downstream selections clear, valid selections and original preset values survive', () => {
  const preset = { ...empty(), area: ['Gandhi Road'], specialty: ['RMP'], product: ['P2'], camp: ['Evening Visit'] }
  const before = structuredClone(preset)
  const result = filterDirectory(index, '', preset)
  assert.deepEqual(plain(result.filters), { ...preset, product: [], camp: [] })
  assert.deepEqual(preset, before)
  assert.equal(result.doctors.length, 1)
  const validPreset = { ...empty(), area: ['gandhi road'], specialty: ['RMP'], product: ['P1'] }
  assert.equal(filterDirectory(index, '', validPreset).filters, validPreset)
})

test('search applies first, combines with filters, and clearing search expands counts', () => {
  const result = derive({ area: ['Market'], specialty: ['RMP'] }, 'doctor 1')
  assert.deepEqual(plain(result.filters.area), [])
  assert.deepEqual(plain(result.filters.specialty), ['RMP'])
  assert.deepEqual(counts(result, 'product'), { P1: 1 })
  assert.equal(derive(result.filters, '').doctors.length, 3)
  assert.equal(derive({}, 'cetrizine').doctors.length, 2)
  const none = derive({ area: ['Market'] }, 'no-such-doctor')
  assert.equal(none.doctors.length, 0)
  assert.ok(none.groups.every(group => group.items.length === 0))
  assert.deepEqual(plain(none.filters), empty())
})

test('multi-select is OR within a group and AND between groups; disappearing selections clear', () => {
  const result = derive({ area: ['Gandhi Road', 'Market'], specialty: ['RMP', 'Cardiology'], product: ['P2'] })
  assert.equal(result.doctors.length, 2)
  assert.deepEqual(counts(result, 'specialty'), { RMP: 1, Cardiology: 1 })
  const narrowed = derive({ ...result.filters, camp: ['Evening Visit'] })
  assert.deepEqual(plain(narrowed.filters.area), ['Gandhi Road'])
  assert.deepEqual(plain(narrowed.filters.specialty), ['Cardiology'])
  assert.equal(filterDirectory(index, '', narrowed.filters).filters, narrowed.filters, 'sanitization must stabilize')
})

test('data refresh and edits update counts and clear stale selections without modifying records', () => {
  const updated = doctors.map(item => item.id === '1' ? { ...item, specialties: ['Cardiology'] } : item)
  const result = filterDirectory(indexDirectory(updated, products, settings), '', { ...empty(), area: ['Gandhi Road'], specialty: ['RMP'] })
  assert.deepEqual(counts(result, 'specialty'), { Cardiology: 2 })
  assert.deepEqual(plain(result.filters.specialty), [])
  assert.deepEqual(doctors[0].specialties, ['RMP', 'RMP'])
})

test('legacy product labels and data-only filter values retain existing matching', () => {
  const row = doctor('legacy', 'Legacy area', ['Legacy specialty'], ['Cetrizine (Tablet)'])
  const result = filterDirectory(indexDirectory([row], products, settings), '', { ...empty(), product: ['P1'] })
  assert.equal(result.doctors.length, 1)
  assert.deepEqual(counts(result, 'area'), { 'Legacy area': 1 })
})

const props = result => ({ open: true, groups: result.groups, products, filters: result.filters, presets: [],
  onChange() {}, onClose() {}, onSavePreset() {}, onDeletePreset() {} })
function elements(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...React.Children.toArray(tree.props?.children).flatMap(elements)]
}

test('filter chips render labels and counts separately; clicking and saving persist only raw values', () => {
  const result = derive({ product: ['P1'] })
  let changed, saved
  const tree = FilterSheet({ ...props(result), onChange: value => { changed = value }, onSavePreset: (name, value) => { saved = { name, value } } })
  const nodes = elements(tree)
  const chip = nodes.find(node => node.props?.['aria-label'] === 'Cetrizine (Tablet) (2)')
  assert.equal(chip.props['aria-pressed'], true)
  chip.props.onClick()
  assert.deepEqual(plain(changed.product), [])
  nodes.find(node => node.props?.className === 'secondary-button').props.onClick()
  assert.deepEqual(plain(saved.value.product), ['P1'])
  assert.equal(saved.name, 'Cetrizine')
  const markup = renderToStaticMarkup(React.createElement(FilterSheet, props(result)))
  assert.match(markup, /directory-filter-label/)
  assert.match(markup, /directory-filter-count/)
  assert.doesNotMatch(markup, /Unused|\(0\)/)
})

test('saved preset buttons apply unchanged value objects', () => {
  const filters = { ...empty(), area: ['Gandhi Road'], product: ['P1'] }
  let applied
  const tree = FilterSheet({ ...props(derive()), presets: [{ id: 'saved', name: 'Morning list', filters }], onChange: value => { applied = value } })
  elements(tree).find(node => node.type === 'button' && node.props.children === 'Morning list').props.onClick()
  assert.deepEqual(applied, filters)
  assert.notEqual(applied, filters)
})

test('1,500 records derive counts and render the filter pane within a 100ms median budget', t => {
  const large = Array.from({ length: 1500 }, (_, i) => ({ ...doctors[i % doctors.length], id: String(i), name: 'Doctor ' + i }))
  const indexed = indexDirectory(large, products, settings)
  const filters = { ...empty(), area: ['Gandhi Road'] }
  const timings = []
  for (let i = 0; i < 7; i++) {
    const start = performance.now()
    const result = filterDirectory(indexed, '', filters)
    assert.equal(result.doctors.length, 750)
    renderToStaticMarkup(React.createElement(FilterSheet, props(result)))
    const elapsed = performance.now() - start
    if (i > 1) timings.push(elapsed)
  }
  const median = timings.sort((a, b) => a - b)[2]
  t.diagnostic('Cached filtering + filter pane SSR median: ' + median.toFixed(1) + 'ms for 1,500 doctors')
  assert.ok(median < 100, 'Cached filter interactions exceeded 100ms: ' + median)
  const start = performance.now()
  const markup = renderToStaticMarkup(React.createElement(Directory, { doctors: large, products, settings, filters, presets: [],
    onFiltersChange() {}, onAdd() {}, onOpen() {}, onSavePreset() {}, onDeletePreset() {} }))
  t.diagnostic('Full Directory SSR including initial index: ' + (performance.now() - start).toFixed(1) + 'ms')
  assert.match(markup, /750/)
})
