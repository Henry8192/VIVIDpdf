import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Updated to match files actually present in your public dir
      // Removed 'robots.txt' as it was not in your file list
      includeAssets: ['vividpdf.svg', 'favicon.ico', 'apple-touch-icon.png', 'favicon.svg'], 
      
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        maximumFileSizeToCacheInBytes: 5000000,
        navigateFallback: '/index.html',
      },

      manifest: {
        name: 'VIVIDpdf',
        short_name: 'VIVIDpdf',
        description: 'Read aloud PDF.',
        theme_color: '#ffffff',
        background_color: '#242424',
        display: "standalone",
        icons: [
          {
            src: '/web-app-manifest-192x192.png', 
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/web-app-manifest-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/vividpdf.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
})