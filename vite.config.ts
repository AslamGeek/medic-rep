import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const gasWebAppUrl = new URL(
  'https://script.google.com/macros/s/AKfycbxGzHJ5gF_TwPijKu8vzsfEu6wYMnUUqS_1XxLdfs7UmkW-CvOVFDyZGYL2pC-XqNi7/exec',
)

const syncProxy = {
  '/api/sync': {
    target: gasWebAppUrl.origin,
    changeOrigin: true,
    followRedirects: true,
    rewrite: (path: string) => path.replace(/^\/api\/sync/, gasWebAppUrl.pathname),
  },
}

export default defineConfig({
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
})
