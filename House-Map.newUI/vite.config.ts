import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "tailwindcss"
import autoprefixer from "autoprefixer"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "build"
  },
  resolve: {
    alias: {
      '@': "/src"
    }
  },
  server: {
    proxy: {
      '/amap-subway': {
        target: 'https://map.amap.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/amap-subway/, '/service/subway'),
      },
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss,
        autoprefixer,
      ]
    }
  }
})
