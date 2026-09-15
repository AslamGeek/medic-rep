import { createHash } from 'node:crypto'

const SPREADSHEET_ID = '1Zg5Rxn6TNskev1EFwwrZI9gWP1mDyifBg6ACI_YTFxU'
const DEFAULT_GAS_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbzKQC-4sk9A-7K3C32W5CZwGkvggkp_jM_p93QJTgcgO_TQX9dSyY3KymzcM3HAHOx4/exec'

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        value += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(value)
      value = ''
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''))
      rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }

  if (value || row.length) {
    row.push(value.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

function unique(values) {
  const seen = new Set()
  return values.filter((value) => {
    const clean = String(value || '').trim()
    const key = clean.toLocaleLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function cleanList(value) {
  const text = String(value || '').trim()
  if (!text) return []
  return unique(text.split(/,|\n/).map((item) => item.trim()))
}

function productLabel(product) {
  return product.name + (product.dosageForm ? ` (${product.dosageForm})` : '')
}

// Keep this cell format compatible with productReferences_ in gas/Code.gs.
function productReferences(value, products) {
  if (Array.isArray(value)) return unique(value.map((item) => String(item).trim()))
  let text = String(value || '').trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return productReferences(parsed, products)
    } catch { /* Also accept manually entered, non-JSON lists. */ }
  }
  const labels = products.map(productLabel).sort((a, b) => b.length - a.length)
  const references = []
  while (text) {
    const label = labels.find((candidate) =>
      text.slice(0, candidate.length).toLowerCase() === candidate.toLowerCase()
      && /^\s*(?:,|\r?\n|$)/.test(text.slice(candidate.length)),
    )
    const reference = label ? text.slice(0, label.length) : text.split(/,|\r?\n/)[0]
    references.push(reference.trim())
    text = text.slice(reference.length).replace(/^\s*[,\r\n]\s*/, '').trim()
  }
  return unique(references)
}

function productIdsFromCell(value, products) {
  return unique(productReferences(value, products).map((reference) => {
    const key = reference.toLowerCase()
    const product = products.find((item) => item.prodId.toLowerCase() === key)
      || products.find((item) => productLabel(item).toLowerCase() === key)
    return product ? product.prodId : reference
  }))
}

function records(csv, sheetName) {
  const rows = parseCsv(csv)
  const headers = rows.shift() || []
  const required = {
    Doctors: ['ID', 'Name', 'Specialties', 'Hospital', 'Pharmacy', 'Area', 'Camp', 'Potential', 'Stockist', 'Prescriber', 'OP Timing', 'Call Schedule', 'Prescribing Products', 'Notes'],
    Visits: ['Date', 'Day', 'Camp', 'Doctors (count)', 'Pharmacy (count)', 'Doctors', 'Pharmacy'],
    Settings: ['Areas', 'Specialties', 'Camps', 'Potentials', 'Stockist', 'OP Timings', 'Call Schedule'],
    Products: ['ProdID', 'Name', 'DosageForm'],
  }
  if (!required[sheetName].every((header) => headers.includes(header))) {
    throw new Error(`Invalid ${sheetName} response from Google Sheets`)
  }
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])))
}

async function readSheet(name, signal) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq`)
  url.searchParams.set('tqx', 'out:csv')
  url.searchParams.set('sheet', name)
  url.searchParams.set('_', Date.now().toString())
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await fetch(url, { cache: 'no-store', signal })
      if (!result.ok) throw new Error(`Could not read the ${name} sheet`)
      return records(await result.text(), name)
    } catch (error) {
      if (signal.aborted || attempt === 1) throw error
    }
  }
}

function makeVisit(row, index) {
  const doctorLines = String(row.Doctors || '').split(/\r?\n/).filter(Boolean)
  const pharmacyLines = String(row.Pharmacy || '').split(/\r?\n/).filter(Boolean)
  const noVisit = doctorLines[0]?.startsWith('NO_VISIT:')
    ? doctorLines[0].slice('NO_VISIT:'.length)
    : ''
  const kind = ['Sunday', 'Holiday', 'Leave'].includes(noVisit) ? noVisit : 'Visit'
  const fingerprint = createHash('sha256')
    .update([row.Date, row.Camp, row.Doctors, row.Pharmacy, index].join('|'))
    .digest('base64url')
    .slice(0, 18)

  return {
    localId: `server-${fingerprint}`,
    date: String(row.Date || ''),
    day: String(row.Day || ''),
    camp: String(row.Camp || ''),
    kind,
    doctorIds: doctorLines.map((line) => {
      const unnumbered = line.replace(/^\s*\d+\.\s*/, '')
      const match = unnumbered.match(/^(.+?)\s+[—-]\s+/)
      return match?.[1]?.trim() || ''
    }).filter(Boolean),
    doctorCount: Number(row['Doctors (count)']) || 0,
    pharmacyCount: Number(row['Pharmacy (count)']) || 0,
    doctorLines,
    pharmacyLines,
    createdAt: row.Date ? `${row.Date}T00:00:00.000Z` : new Date().toISOString(),
    syncState: 'synced',
  }
}

async function bootstrap(response) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const [doctorRows, visitRows, settingRows, productRows] = await Promise.all([
      readSheet('Doctors', controller.signal),
      readSheet('Visits', controller.signal),
      readSheet('Settings', controller.signal),
      readSheet('Products', controller.signal),
    ])
    const serverTime = new Date().toISOString()
    const products = productRows.filter((row) => row.ProdID && row.Name).map((row) => ({
      prodId: row.ProdID.trim(),
      name: row.Name.trim(),
      dosageForm: row.DosageForm.trim(),
    }))
    const settingColumn = (name) => unique(settingRows.map((row) => row[name]))
    const payload = {
      success: true,
      doctors: doctorRows.filter((row) => row.ID).map((row) => ({
        id: row.ID.trim(),
        name: row.Name.trim(),
        specialties: cleanList(row.Specialties),
        hospital: row.Hospital.trim(),
        pharmacy: row.Pharmacy.trim(),
        area: row.Area.trim(),
        camp: row.Camp.trim(),
        potential: row.Potential.trim(),
        stockist: row.Stockist.trim(),
        prescriber: String(row.Prescriber).trim().toLocaleLowerCase() === 'rx' ? 'Rx' : 'NRx',
        opTiming: row['OP Timing'].trim(),
        callSchedule: row['Call Schedule'].trim(),
        prescribingProductIds: productIdsFromCell(row['Prescribing Products'], products),
        notes: row.Notes.trim(),
        updatedAt: serverTime,
        syncState: 'synced',
      })),
      visits: visitRows.filter((row) => row.Date).map(makeVisit),
      settings: {
        areas: settingColumn('Areas'),
        specialties: settingColumn('Specialties'),
        camps: settingColumn('Camps'),
        potentials: settingColumn('Potentials'),
        stockists: settingColumn('Stockist'),
        opTimings: settingColumn('OP Timings'),
        callSchedules: settingColumn('Call Schedule'),
      },
      products,
      serverTime,
    }
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(200).json(payload)
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError'
    return response.status(timedOut ? 504 : 502).json({
      success: false,
      message: timedOut ? 'Google Sheets took too long to respond' : 'Could not read Google Sheets',
    })
  } finally {
    clearTimeout(timer)
  }
}

async function forwardWrite(request, response) {
  const upstreamUrl = new URL(process.env.GAS_WEB_APP_URL || DEFAULT_GAS_WEB_APP_URL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50_000)
  try {
    const body = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body || {})

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json,text/plain,*/*',
            'Content-Type': 'text/plain;charset=utf-8',
            // Google content redirects can fail even after a successful write.
            // Reuse the operation ID on every retry so the write is deduplicated.
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
          },
          body,
          cache: 'no-store',
          redirect: 'follow',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22_000)]),
        })
        const text = await upstream.text()
        const contentType = upstream.headers.get('content-type') || ''
        if (upstream.ok && contentType.includes('application/json')) {
          const data = JSON.parse(text)
          if (typeof data.success !== 'boolean') throw new Error('Invalid Apps Script response')
          response.setHeader('Cache-Control', 'no-store, max-age=0')
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          return response.status(200).send(text)
        }
      } catch (error) {
        if (controller.signal.aborted || attempt === 1) throw error
      }
    }

    throw new Error('Apps Script did not accept the change')
  } catch (error) {
    const timedOut = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
    return response.status(timedOut ? 504 : 502).json({
      success: false,
      message: timedOut
        ? 'Saving to Google Sheets took too long; it will retry automatically'
        : 'Google Sheets did not accept the change; it will retry automatically',
    })
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(request, response) {
  if (request.method === 'GET') return bootstrap(response)
  if (request.method === 'POST') return forwardWrite(request, response)
  response.setHeader('Allow', 'GET, POST')
  return response.status(405).json({ success: false, message: 'Method not allowed' })
}
