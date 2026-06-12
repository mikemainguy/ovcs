import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const api = 'http://localhost:3001'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: { outDir: '../web-dist' },
  server: {
    proxy: {
      '/me': api,
      '/diff': api,
      '/data': api,
      '/info': api,
      '/content': api,
      '/merge-check': api,
      '/merge': api,
      '/pull': api,
      '/presence': api,
      '/sync-status': api,
      '/warnings': api,
      '/hotspots': api,
      '/ready': api,
      '/search': api,
      '/file-info': api,
      '/warning-events': api,
      '/diff-events': api,
    },
  },
})
