import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  define: {
    __API_ORIGIN__: JSON.stringify('https://api.deepseek.com'),
  },
  plugins: [
    {
      name: 'resolve-ts-js-extension',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          importer &&
          source.endsWith('.js') &&
          (source.startsWith('./') || source.startsWith('../'))
        ) {
          const base = path.resolve(path.dirname(importer), source.slice(0, -3))
          if (fs.existsSync(`${base}.ts`)) {
            return `${base}.ts`
          }
          if (fs.existsSync(`${base}.tsx`)) {
            return `${base}.tsx`
          }
        }
        return null
      },
    },
  ],
  test: {
    root,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
  },
})
