// Keep the portable helpers in sync with the marked block in gas/Code.gs.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parseDays(value) {
  const text = String(value || '').trim().toLowerCase()
  if (/^(everyday|every day|daily|all days)$/.test(text)) return [...WEEKDAYS]
  const tokens = text.split(/\s*(?:,|&|\/|\band\b)\s*/).filter(Boolean)
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const days = tokens.map(token => WEEKDAYS.find((day, index) => token === day.toLowerCase() || token === names[index]))
  return days.length && days.every(Boolean) ? [...new Set(days)] : []
}

function parseClock(value) {
  const text = String(value || '').trim().toLowerCase().replace(/\./g, '')
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?(?::00)?\s*(am|pm)?$/)
  if (!match) return ''
  let hour = Number(match[1])
  const minute = Number(match[2] || 0)
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return ''
  if (match[3]) hour = hour % 12 + (match[3] === 'pm' ? 12 : 0)
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
}

function validateAvailability(windows) {
  if (!Array.isArray(windows) || windows.length > 14) throw new Error('Availability: use up to 14 time windows.')
  return windows.map(window => {
    if (!window || !Array.isArray(window.days) || !window.days.length || window.days.some(day => !WEEKDAYS.includes(day))) {
      throw new Error('Availability: select at least one valid weekday for each window.')
    }
    if (!/^\d{2}:\d{2}$/.test(window.from || '') || parseClock(window.from) !== window.from) {
      throw new Error('Availability: enter a valid start time for each window.')
    }
    const until = window.until || ''
    if (until && (!/^\d{2}:\d{2}$/.test(until) || parseClock(until) !== until || until <= window.from)) {
      throw new Error('Availability: closing time must be after start time on the same day.')
    }
    return { days: WEEKDAYS.filter(day => window.days.includes(day)), from: window.from, until,
      notes: String(window.notes || '').trim().slice(0, 200) }
  })
}

function availabilityFromRecords(records) {
  const byDoctor = Object.create(null)
  records.forEach(row => {
    const id = String(row['Doctor ID'] || '').trim()
    if (!id) return
    const window = { days: parseDays(row.Days), from: parseClock(row.From) || String(row.From || ''),
      until: parseClock(row.Until) || String(row.Until || ''), notes: String(row.Notes || '').trim() }
    if (!byDoctor[id]) byDoctor[id] = []
    byDoctor[id].push(window)
  })
  return byDoctor
}

export { WEEKDAYS, parseDays, parseClock, validateAvailability, availabilityFromRecords }
