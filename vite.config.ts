import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: (path) => /[\\/]native[\\/](?:bin|obj)(?:[\\/]|$)/i.test(path),
    },
  },
})
