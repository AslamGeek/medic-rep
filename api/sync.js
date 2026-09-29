import { gasUrl } from '../shared/sync-config.js'

// Both directions use the same deployment and the same GAS serializers.
export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  if (!['GET', 'POST'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST')
    return response.status(405).json({ success: false, retryable: false, message: 'Method not allowed' })
  }
  let url
  try {
    url = new URL(gasUrl(process.env.GAS_WEB_APP_URL, process.env.VITE_GAS_WEB_APP_URL))
  } catch (error) {
    return response.status(400).json({ success: false, retryable: false, message: error.message })
  }
  if (request.method === 'GET') url.searchParams.set('action', request.query?.action === 'health' ? 'health' : 'bootstrap')
  const body = request.method === 'POST'
    ? typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {})
    : undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const upstream = await fetch(url, {
        method: request.method, body,
        headers: { Accept: 'application/json', 'Content-Type': 'text/plain;charset=utf-8' },
        cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(22_000),
      })
      const transient = [408, 429, 500, 502, 503, 504].includes(upstream.status)
      if (transient && attempt === 0) continue
      if (!upstream.ok) return response.status(transient ? 503 : 400).json({
        success: false, retryable: transient, message: 'Apps Script returned HTTP ' + upstream.status + '. Check deployment access and configuration.',
      })
      let data
      try { data = JSON.parse(await upstream.text()) } catch {
        return response.status(502).json({ success: false, retryable: false,
          message: 'Apps Script returned HTML or invalid JSON. Deploy a new version with Execute as Me and access Anyone.' })
      }
      if (typeof data.success !== 'boolean') return response.status(400).json({ success: false, retryable: false, message: 'Invalid Apps Script response' })
      return response.status(200).json(data)
    } catch (error) {
      const transient = error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name)
      if (transient && attempt === 0) continue
      return response.status(transient ? 503 : 400).json({ success: false, retryable: transient,
        message: transient ? 'Google Sheets is temporarily unavailable.' : 'Could not contact the sync service.' })
    }
  }
}
