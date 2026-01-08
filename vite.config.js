import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['vividpdf.svg', 'robots.txt'], // Add any other static files in /public here
      
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        maximumFileSizeToCacheInBytes: 5000000,
        
        // --- NEW: Ensures the app loads even if you refresh on a sub-route offline ---
        navigateFallback: '/index.html',
      },

      manifest: {
        name: 'VIVIDpdf',
        short_name: 'VIVIDpdf',
        description: 'A webapp that reads PDFs, tailored for academic text.',
        theme_color: '#ffffff',
        display: "standalone", // Makes it look like a native app
        icons: [
          {
            src: '/vividpdf.svg',
            sizes: '192x192',
            type: 'image/svg+xml'
          },
          {
            src: '/vividpdf.svg',
            sizes: '512x512',
            type: 'image/svg+xml'
          }
        ]
      }
    })
  ],
})