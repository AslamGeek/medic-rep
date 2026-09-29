import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('v2 migration preserves data and marks every queued entity unconfirmed', async () => {
  let upgrade
  class Dexie {
    version() { return { stores: () => ({ upgrade: callback => { upgrade = callback } }) } }
  }
  const context = vm.createContext({ exports: {}, require: name => name === 'dexie' ? Dexie : { EMPTY_SETTINGS: {} } })
  const source = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const rows = {
    doctors: [{ id: 'queued', name: 'Keep local', updatedAt: '2026-09-01T00:00:00.000Z', syncState: 'synced' },
      { id: 'confirmed', name: 'Keep too', syncState: 'synced' }],
    visits: [{ localId: 'old-hash', doctorLines: ['Keep history'], syncState: 'synced' }],
    queue: [{ id: 1, entityId: 'queued', payload: { name: 'Queued payload' }, opId: 'keep-receipt' }],
    presets: [{ id: 'preset', filters: { camp: ['A'] } }],
    meta: [{ key: 'master', value: { products: [] } }],
  }
  await upgrade({ table: name => ({ toArray: async () => structuredClone(rows[name]),
    toCollection: () => ({ modify: async fn => rows[name].forEach(fn) }) }) })
  assert.equal(rows.doctors[0]._synced, false)
  assert.equal(rows.doctors[0].name, 'Keep local')
  assert.equal(rows.doctors[1]._synced, true)
  assert.equal(rows.visits[0]._legacyId, true)
  assert.equal(rows.queue[0].opId, 'keep-receipt')
  assert.deepEqual(rows.queue[0].payload, { name: 'Queued payload' })
  for (const record of Object.values(rows).flat()) {
    assert.equal(typeof record._synced, 'boolean')
    assert.equal(new Date(record.updatedAt).toISOString(), record.updatedAt)
  }
})
