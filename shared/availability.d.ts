import type { CallWindow } from '../src/types'
export const WEEKDAYS: string[]
export function parseDays(value: unknown): string[]
export function parseClock(value: unknown): string
export function validateAvailability(windows: unknown): CallWindow[]
export function availabilityFromRecords(records: Record<string, unknown>[]): Record<string, CallWindow[]>
