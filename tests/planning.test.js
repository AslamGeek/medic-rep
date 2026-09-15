import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as availability from '../shared/availability.js'

const exports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/planning.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: () => availability })
const { availabilityFor, compareAvailability, moveInOrder } = exports
const at = time => new Date(`2026-09-15T${time}:00`)
const doctor = windows => ({ availability: windows, callSchedule: 'Everyday', opTiming: '' })
const window = (from, until = '', days = ['Tue']) => ({ days, from, until, notes: '' })

test('closed windows end exactly at the deadline, and a second window becomes next', () => {
  const value = doctor([window('10:00', '11:00'), window('14:00', '15:00')])
  assert.equal(availabilityFor(value, at('09:59')).kind, 'later')
  assert.equal(availabilityFor(value, at('10:00')).kind, 'now')
  assert.equal(availabilityFor(value, at('10:40')).label, 'Closes in 20 min')
  assert.equal(availabilityFor(value, at('11:00')).label, 'Starts in 180 min')
  assert.equal(availabilityFor(value, at('14:00')).kind, 'now')
  assert.equal(availabilityFor(value, at('15:00')).kind, 'ended')
  assert.equal(availabilityFor(value, new Date('2026-09-16T10:30:00')).kind, 'off')
})

test('narrow current windows sort ahead of flexible ones, with upcoming calls after both', () => {
  const narrow = availabilityFor(doctor([window('10:00', '11:00')]), at('10:40'))
  const broad = availabilityFor(doctor([window('09:00', '13:00')]), at('10:40'))
  const later = availabilityFor(doctor([window('14:00')]), at('10:40'))
  assert.ok(compareAvailability(narrow, broad) < 0)
  assert.ok(compareAvailability(broad, later) < 0)
})

test('legacy timings retain unknown closing times and ambiguous schedules stay unknown', () => {
  const value = { callSchedule: 'Tue & Fri', opTiming: 'After 2 pm' }
  assert.equal(availabilityFor(value, at('13:00')).kind, 'later')
  assert.match(availabilityFor(value, at('14:00')).detail, /closing time unknown/)
  assert.match(availabilityFor(value, at('14:00')).label, /confirm availability/)
  assert.equal(availabilityFor({ ...value, callSchedule: 'Occasionally' }, at('14:00')).kind, 'unknown')
  assert.equal(availabilityFor({ ...value, opTiming: 'after lunch' }, at('14:00')).kind, 'unknown')
  assert.equal(availabilityFor({ ...value, opTiming: '10 am to 11 am' }, at('11:00')).kind, 'ended')
})

test('strict validation and sheet time parsing never turn bad windows into open availability', () => {
  for (const windows of [[window('14:00', '13:00')], [window('10:00', '', [])], [window('25:00')]]) {
    assert.throws(() => availability.validateAvailability(windows), /Availability:/)
    assert.equal(availabilityFor(doctor(windows), at('10:40')).kind, 'unknown')
  }
  assert.equal(availability.parseClock('12:00 AM'), '00:00')
  assert.equal(availability.parseClock('2:30:00 PM'), '14:30')
  assert.equal(availability.parseClock('13 pm'), '')
  assert.deepEqual(availability.parseDays('Tuesday, Friday'), ['Tue', 'Fri'])
})

test('reordering a filtered list preserves the positions of hidden doctors', () => {
  assert.deepEqual(Array.from(moveInOrder(['A', 'hidden', 'B', 'C'], 'B', 'A')), ['B', 'hidden', 'A', 'C'])
  assert.deepEqual(Array.from(moveInOrder(['A', 'B'], 'A', 'missing')), ['A', 'B'])
})
