import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5973,
    // Comma-separated extra hostnames Vite's dev server will accept.
    // Useful when the dev UI is reached via Tailscale, ngrok, a LAN hostname, etc.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim())
      : true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://server:3901',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: process.env.VITE_API_URL || 'http://server:3901',
        ws: true,
      },
    },
  },
})
