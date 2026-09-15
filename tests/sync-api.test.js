import assert from 'node:assert/strict'
import test from 'node:test'
import handler from '../api/sync.js'

function capture() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value },
    status(code) { this.code = code; return this },
    json(value) { this.body = value }, send(value) { this.body = JSON.parse(value) } }
}

test('a temporary network failure retries the same write operation', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(init.body)
    if (bodies.length === 1) throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ success: true, doctor: { id: 'PDTR-001' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const response = capture()
  await handler({ method: 'POST', body: { action: 'upsertDoctor', opId: 'stable-op', payload: {} } }, response)
  assert.equal(response.code, 200)
  assert.equal(response.body.success, true)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
})

test('an HTML error page must never become a successful empty spreadsheet', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Temporarily unavailable</html>', {
    headers: { 'Content-Type': 'text/html' },
  }))
  const response = capture()
  await handler({ method: 'GET' }, response)
  assert.equal(response.body.success, false)
  assert.equal(response.code, 502)
})
