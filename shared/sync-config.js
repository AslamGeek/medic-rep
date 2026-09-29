export const DEFAULT_GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzHTV9wlkDNV5YTag9YBaaDqg85ksTfEKlW97H26BL6hQdxLLM5kRmDkU1rmI_JdG8/exec'

export function gasUrl(server, client) {
  if (server && client && server !== client) throw new Error('GAS_WEB_APP_URL and VITE_GAS_WEB_APP_URL must match')
  const value = server || client || DEFAULT_GAS_WEB_APP_URL
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(value)) {
    throw new Error('Use the deployed Apps Script /exec URL')
  }
  return value
}
