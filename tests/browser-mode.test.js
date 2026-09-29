import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../src/browserMode.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function fixture(registration) {
  const calls = []
  const caches = { delete: async name => { calls.push(['cache', name]); return true } }
  const exports = {}
  vm.runInNewContext(source, {
    exports, URL, location: { origin: 'https://medrep.example' }, window: { caches }, caches,
    navigator: { serviceWorker: { getRegistration: async () => registration } },
  })
  return { retire: exports.retireLegacyServiceWorker, calls }
}

test('browser mode retires the legacy root worker and only its app-shell cache', async () => {
  let unregistered = false
  const { retire, calls } = fixture({
    scope: 'https://medrep.example/', active: { scriptURL: 'https://medrep.example/sw.js' },
    unregister: async () => { unregistered = true; return true },
  })
  await retire()
  assert.equal(unregistered, true)
  assert.deepEqual(calls, [['cache', 'workbox-precache-v2-https://medrep.example/']])
})

test('browser mode leaves unrelated workers and caches alone', async () => {
  for (const registration of [undefined,
    { scope: 'https://medrep.example/other/', active: { scriptURL: 'https://medrep.example/sw.js' } },
    { scope: 'https://medrep.example/', active: { scriptURL: 'https://medrep.example/unrelated.js' } },
  ]) {
    const { retire, calls } = fixture(registration)
    await retire()
    assert.deepEqual(calls, [])
  }
})

test('restricted storage does not prevent opening the website', async () => {
  const { retire } = fixture({ scope: 'https://medrep.example/',
    active: { scriptURL: 'https://medrep.example/sw.js' }, unregister: async () => { throw new Error('Blocked') } })
  await assert.doesNotReject(retire())
})

test('the retirement worker takes over legacy clients, unregisters, and never intercepts requests', async () => {
  const handlers = new Map()
  const calls = []
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => calls.push('skipWaiting'),
      clients: { claim: async () => calls.push('claim') },
      registration: { scope: 'https://medrep.example/', unregister: async () => calls.push('unregister') },
    },
    caches: { delete: async name => calls.push(name) },
  })
  let pending
  const event = { waitUntil: promise => { pending = promise } }
  handlers.get('install')(event)
  await pending
  handlers.get('activate')(event)
  await pending
  assert.deepEqual(calls, ['skipWaiting', 'workbox-precache-v2-https://medrep.example/', 'claim', 'unregister'])
  assert.equal(handlers.has('fetch'), false)
})
