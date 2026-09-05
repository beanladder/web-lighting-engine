import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    // three/webgpu is a big prebundle target; keeping it explicit avoids a
    // mid-session re-optimize + page reload the first time the viewport mounts.
    include: ['three', 'three/webgpu'],
  },
})
