import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { bundleGas } from '../scripts/build-gas.js'
import * as shared from '../shared/availability.js'

test('generated GAS parser matches browser output and rejection messages', () => {
  const context = vm.createContext({})
  vm.runInContext(bundleGas(), context)
  const outcome = (fn, input) => {
    try { return JSON.stringify({ value: fn(input) }) }
    catch (error) { return JSON.stringify({ error: error.message }) }
  }
  const cases = {
    parseDays: ['', 'Mon, Wed', 'Monday & Friday', 'daily', 'Noday', null, 'Tue/Tue'],
    parseClock: ['', '00:00', '23:59', '24:00', '12 am', '12 pm', '9:30 PM', '12:99', '10:15:00', null],
    validateAvailability: [null, [], [{ days: ['Mon', 'Wed'], from: '09:00', until: '17:00', notes: ' clinic ' }],
      [{ days: ['Tue'], from: '11:00', until: '10:00' }], [{ days: ['X'], from: '10:00' }],
      [{ days: ['Tue'], from: '9:00' }], [{ days: ['Tue'], from: '09:00', until: '' }]],
    availabilityFromRecords: [[{ 'Doctor ID': 'D-1', Days: 'Mon, Wed', From: '09:00', Until: '12:00' }],
      [{ 'Doctor ID': 'D-1', Days: 'Friday', From: '2 pm', Until: 'invalid' }]],
  }
  for (const [name, inputs] of Object.entries(cases)) {
    for (const input of inputs) assert.equal(outcome(context[name], input), outcome(shared[name], input), name)
  }
  assert.doesNotMatch(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), /function (parseDays|parseClock|validateAvailability|availabilityFromRecords)\(/)
})
