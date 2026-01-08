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
        description: 'Read aloud PDF.',
        theme_color: '#ffffff',
        background_color: '#242424', // Match your CSS :root background
        display: "standalone", // Makes it look like a native app
      icons: [
        {
          src: '/vividpdf-192.png', // Needs to be a PNG
          sizes: '192x192',
          type: 'image/png'
        },
        {
          src: '/vividpdf-512.png', // Needs to be a PNG
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable' // Allows Android to crop it safely
        },
        {
          src: '/vividpdf.svg',
          sizes: '512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable' // Optional: keeps SVG for browsers that support it
        }
      ]

      }
    })
  ],
})