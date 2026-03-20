import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// On Vercel (serverless), the filesystem is read-only except /tmp.
// Locally, use the project's uploads/ directory.
const IS_VERCEL = !!process.env.VERCEL

const LOCAL_UPLOADS = path.join(__dirname, '..', 'uploads')
const VERCEL_UPLOADS = '/tmp/uploads'

export const UPLOADS_DIR = IS_VERCEL ? VERCEL_UPLOADS : LOCAL_UPLOADS

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Read a JSON file. On Vercel, tries /tmp first, then falls back to
 * the bundled read-only copy (for pre-deployed files like ai-context.json).
 */
export function readJSON(relativePath, fallback = null) {
  const tmpPath = path.join(VERCEL_UPLOADS, relativePath)
  const localPath = path.join(LOCAL_UPLOADS, relativePath)

  // On Vercel: check /tmp first (writable), then bundled read-only copy
  if (IS_VERCEL) {
    try {
      if (fs.existsSync(tmpPath)) {
        return JSON.parse(fs.readFileSync(tmpPath, 'utf-8'))
      }
    } catch {}
    try {
      if (fs.existsSync(localPath)) {
        return JSON.parse(fs.readFileSync(localPath, 'utf-8'))
      }
    } catch {}
    return fallback
  }

  // Local: just read from uploads/
  try {
    if (fs.existsSync(localPath)) {
      return JSON.parse(fs.readFileSync(localPath, 'utf-8'))
    }
  } catch {}
  return fallback
}

/**
 * Write a JSON file. Always writes to the writable location.
 */
export function writeJSON(relativePath, data) {
  const fullPath = path.join(UPLOADS_DIR, relativePath)
  ensureDir(path.dirname(fullPath))
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2))
}

/**
 * Check if a file exists (checking both /tmp and bundled on Vercel).
 */
export function fileExists(relativePath) {
  if (IS_VERCEL) {
    return (
      fs.existsSync(path.join(VERCEL_UPLOADS, relativePath)) ||
      fs.existsSync(path.join(LOCAL_UPLOADS, relativePath))
    )
  }
  return fs.existsSync(path.join(LOCAL_UPLOADS, relativePath))
}

/**
 * Get the absolute writable path for a relative path.
 */
export function writablePath(relativePath) {
  return path.join(UPLOADS_DIR, relativePath)
}

/**
 * Get the absolute readable path (prefers /tmp on Vercel, falls back to bundled).
 */
export function readablePath(relativePath) {
  if (IS_VERCEL) {
    const tmpPath = path.join(VERCEL_UPLOADS, relativePath)
    if (fs.existsSync(tmpPath)) return tmpPath
    const localPath = path.join(LOCAL_UPLOADS, relativePath)
    if (fs.existsSync(localPath)) return localPath
    return tmpPath // default to writable path
  }
  return path.join(LOCAL_UPLOADS, relativePath)
}
