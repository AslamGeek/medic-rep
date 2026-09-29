import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { gasUrl } from './shared/sync-config.js'
import { VitePWA } from 'vite-plugin-pwa'

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
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['app-icon.svg'],
        manifest: {
          name: 'MedRep Field Companion',
          short_name: 'MedRep',
          description: 'A fast offline-first doctor directory and visit logger for a medical representative.',
          theme_color: '#167b5a',
          background_color: '#f3f6f4',
          display: 'standalone',
          orientation: 'portrait-primary',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/app-icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any',
            },
            {
              src: '/app-icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,woff2}'],
          navigateFallback: '/index.html',
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
        },
      }),
    ],
  }
})
