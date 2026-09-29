import vm from 'node:vm'
import { loadEnv } from 'vite'
import { bundleGas } from './build-gas.js'
import { gasUrl } from '../shared/sync-config.js'

const env = { ...loadEnv('production', process.cwd(), ''), ...process.env }
const context = vm.createContext({})
vm.runInContext(bundleGas(), context)
const url = gasUrl(env.GAS_WEB_APP_URL, env.VITE_GAS_WEB_APP_URL)
let failed = false

function csv(text) {
  const rows = []; let row = []; let value = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(value.replace(/\r$/, '')); value = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else value += char
  }
  if (value || row.length) { row.push(value); rows.push(row) }
  return rows
}

try {
  const result = await fetch(url + '?action=health', { signal: AbortSignal.timeout(25000) })
  const data = await result.json()
  const current = data.success && data.schemaVersion === 2
    && Object.keys(data.tabs || {}).length === Object.keys(context.SHEET_HEADERS).length
    && Object.keys(context.SHEET_HEADERS).every(name => Array.isArray(data.tabs?.[name]))
  console.log('Public GAS access:', result.ok && data.success ? 'reachable without authentication' : 'FAILED')
  console.log('Versioned health:', current ? 'PASS' : 'FAIL: deploy the generated GAS bundle as a NEW version')
  if (!current) failed = true
} catch (error) { failed = true; console.log('GAS health FAILED:', error.message) }

// Read only. Print headers and row numbers, never doctor names or visit details.
for (const [name, required] of Object.entries(context.SHEET_HEADERS)) {
  try {
    const endpoint = new URL('https://docs.google.com/spreadsheets/d/' + context.CONFIG.SPREADSHEET_ID + '/gviz/tq')
    endpoint.searchParams.set('tqx', 'out:csv'); endpoint.searchParams.set('sheet', name)
    const result = await fetch(endpoint, { signal: AbortSignal.timeout(15000) })
    const text = await result.text()
    if (!result.ok || /^\s*</.test(text)) throw new Error('tab is not publicly readable as CSV')
    const rows = csv(text); const headers = rows.shift() || []
    const missing = required.filter(header => !headers.includes(header))
    console.log(name + ':', missing.length ? 'missing exact headers: ' + missing.join(', ') : 'PASS exact headers')
    if (missing.length) failed = true
  } catch (error) { failed = true; console.log(name + ': FAILED ' + error.message) }
}
console.log('Execute as Me and deployment version selection require confirmation in the Apps Script deployment editor.')
process.exitCode = failed ? 1 : 0
