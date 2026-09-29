import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const exports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/SyncStatus.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require })

test('sync badge shows green only for verified parity with no pending work or failure', () => {
  for (const [detail, label, green] of [
    [{ phase: 'idle', pending: 0, verified: false }, 'Refresh to verify', false],
    [{ phase: 'idle', pending: 0, verified: true }, 'Synced', true],
    [{ phase: 'idle', pending: 1, verified: true }, 'Pending changes', false],
    [{ phase: 'syncing', activity: 'refreshing', verified: true }, 'Refreshing…', false],
    [{ phase: 'error', verified: true }, 'Sync failed', false],
    [{ phase: 'offline', verified: true }, 'Offline', false],
  ]) {
    const html = renderToStaticMarkup(React.createElement(exports.SyncStatus, { detail, onRetry() {} }))
    assert.ok(html.includes(label))
    assert.equal(html.includes('class="sync-badge idle"'), green)
  }
})
