import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { gasUrl } from './shared/sync-config.js'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const gasWebAppUrl = new URL(gasUrl(env.GAS_WEB_APP_URL, env.VITE_GAS_WEB_APP_URL))

  const syncProxy = {
    '/api/sync': {
      target: gasWebAppUrl.origin,
      changeOrigin: true,
      followRedirects: true,
      rewrite: (path: string) => path.replace(/^\/api\/sync/, gasWebAppUrl.pathname),
    },
  }

  return {
    server: { proxy: syncProxy },
    preview: { proxy: syncProxy },
    plugins: [react()],
  }
})
