import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = path.join(ROOT, 'dist')
const ANDROID_ASSETS_DIR = path.join(ROOT, 'android/app/src/main/assets/web')

if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  throw new Error('dist/index.html not found. Run pnpm build first.')
}

rmSync(ANDROID_ASSETS_DIR, { recursive: true, force: true })
mkdirSync(ANDROID_ASSETS_DIR, { recursive: true })
cpSync(DIST_DIR, ANDROID_ASSETS_DIR, { recursive: true })
process.stdout.write(`Synced dist/ -> ${path.relative(ROOT, ANDROID_ASSETS_DIR)}\n`)
