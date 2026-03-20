import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { KeyStore } from './db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const IS_VERCEL = !!process.env.VERCEL
const LOCAL_UPLOADS = path.join(__dirname, '..', 'uploads')
const VERCEL_UPLOADS = '/tmp/uploads'

export const UPLOADS_DIR = IS_VERCEL ? VERCEL_UPLOADS : LOCAL_UPLOADS

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Read a JSON file or from MongoDB.
 */
export async function readJSON(relativePath, fallback = null) {
  // Try MongoDB first
  try {
    const doc = await KeyStore.findOne({ key: relativePath })
    if (doc) return doc.data
  } catch (err) {
    console.error(`MongoDB read error for ${relativePath}:`, err.message)
  }

  // Fallback to local filesystem (for pre-deployed files or dev)
  const tmpPath = path.join(VERCEL_UPLOADS, relativePath)
  const localPath = path.join(LOCAL_UPLOADS, relativePath)

  if (IS_VERCEL) {
    try {
      if (fs.existsSync(tmpPath)) return JSON.parse(fs.readFileSync(tmpPath, 'utf-8'))
    } catch {}
    try {
      if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf-8'))
    } catch {}
    return fallback
  }

  try {
    if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf-8'))
  } catch {}
  return fallback
}

/**
 * Write a JSON file or to MongoDB.
 */
export async function writeJSON(relativePath, data) {
  // Write to MongoDB
  try {
    await KeyStore.findOneAndUpdate(
      { key: relativePath },
      { data, updatedAt: new Date() },
      { upsert: true, new: true }
    )
  } catch (err) {
    console.error(`MongoDB write error for ${relativePath}:`, err.message)
  }

  // Also write to filesystem (best effort)
  try {
    const fullPath = path.join(UPLOADS_DIR, relativePath)
    ensureDir(path.dirname(fullPath))
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2))
  } catch {}
}

/**
 * List keys in MongoDB or files in a directory.
 */
export async function listJSON(prefix) {
  const keys = new Set()

  // From MongoDB
  try {
    const docs = await KeyStore.find({ key: new RegExp(`^${prefix}`) }, 'key')
    docs.forEach(d => keys.add(d.key))
  } catch {}

  // From Filesystem
  try {
    const dir = path.join(UPLOADS_DIR, prefix)
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .forEach(f => keys.add(`${prefix}/${f}`))
    }
  } catch {}

  return Array.from(keys)
}

export function fileExists(relativePath) {
  // Note: sync version for file system only
  if (IS_VERCEL) {
    return (
      fs.existsSync(path.join(VERCEL_UPLOADS, relativePath)) ||
      fs.existsSync(path.join(LOCAL_UPLOADS, relativePath))
    )
  }
  return fs.existsSync(path.join(LOCAL_UPLOADS, relativePath))
}

export function writablePath(relativePath) {
  return path.join(UPLOADS_DIR, relativePath)
}

export function readablePath(relativePath) {
  if (IS_VERCEL) {
    const tmpPath = path.join(VERCEL_UPLOADS, relativePath)
    if (fs.existsSync(tmpPath)) return tmpPath
    const localPath = path.join(LOCAL_UPLOADS, relativePath)
    if (fs.existsSync(localPath)) return localPath
    return tmpPath
  }
  return path.join(LOCAL_UPLOADS, relativePath)
}
