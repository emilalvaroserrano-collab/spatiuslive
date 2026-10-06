import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { avatarkitVitePlugin } from '@spatius/avatarkit/vite'

const configDir = path.dirname(fileURLToPath(import.meta.url))

function ensureAvatarAssetsDir() {
  return {
    name: 'ensure-avatarkit-assets-dir',
    closeBundle() {
      mkdirSync(path.resolve(configDir, 'dist/assets'), { recursive: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), ensureAvatarAssetsDir(), avatarkitVitePlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
})
