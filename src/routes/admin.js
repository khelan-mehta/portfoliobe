import express from 'express'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { authMiddleware } from '../middleware/auth.js'
import { UPLOADS_DIR, ensureDir, readJSON, writeJSON, readablePath, writablePath } from '../storage.js'

const router = express.Router()

const VOICE_SAMPLE_DIR = path.join(UPLOADS_DIR, 'voice-samples')

// ─── Multer: Video ────────────────────────────────────────────────────────────
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(UPLOADS_DIR)
    cb(null, UPLOADS_DIR)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `avatar-video${ext}`)
  },
})

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo']
    if (allowed.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only video files are allowed'))
    }
  },
})

// ─── Multer: Voice samples ────────────────────────────────────────────────────
const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(VOICE_SAMPLE_DIR)
    cb(null, VOICE_SAMPLE_DIR)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    const ts = Date.now()
    cb(null, `voice-sample-${ts}${ext}`)
  },
})

const uploadVoice = multer({
  storage: voiceStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter: (req, file, cb) => {
    const allowed = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/ogg',
      'audio/webm',
      'audio/flac',
    ]
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|m4a|ogg|flac|webm)$/i)) {
      cb(null, true)
    } else {
      cb(new Error('Only audio files are allowed (mp3, wav, m4a, ogg, flac, webm)'))
    }
  },
})

// ─── POST /api/admin/login ────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { password } = req.body
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'

  if (password !== adminPassword) {
    return res.status(401).json({ error: 'Invalid password' })
  }

  const token = jwt.sign(
    { role: 'admin' },
    process.env.JWT_SECRET || 'default-secret-change-me',
    { expiresIn: '24h' }
  )

  res.json({ token })
})

// ─── POST /api/admin/upload-video (protected) ─────────────────────────────────
router.post('/upload-video', authMiddleware, uploadVideo.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' })
  }

  const videoUrl = `/uploads/${req.file.filename}`
  res.json({
    message: 'Video uploaded successfully',
    videoUrl,
    filename: req.file.filename,
  })
})

// ─── POST /api/admin/upload-voice (protected) ────────────────────────────────
router.post('/upload-voice', authMiddleware, uploadVoice.array('voice', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No audio file(s) provided' })
  }

  const uploaded = req.files.map((f) => ({
    filename: f.filename,
    originalName: f.originalname,
    size: f.size,
    url: `/uploads/voice-samples/${f.filename}`,
  }))

  res.json({
    message: `${req.files.length} voice sample(s) uploaded successfully`,
    samples: uploaded,
    note: 'Samples stored. Select the best matching voice below and save voice config.',
  })
})

// ─── GET /api/admin/voice-samples (protected) ────────────────────────────────
router.get('/voice-samples', authMiddleware, (req, res) => {
  // Check both writable and read-only paths
  const dirs = [VOICE_SAMPLE_DIR]
  const readOnlyDir = readablePath('voice-samples')
  if (readOnlyDir !== VOICE_SAMPLE_DIR) dirs.push(readOnlyDir)

  const allSamples = []
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
      files.forEach((f) => {
        const stat = fs.statSync(path.join(dir, f))
        allSamples.push({
          filename: f,
          size: stat.size,
          url: `/uploads/voice-samples/${f}`,
          uploadedAt: stat.birthtime,
        })
      })
    } catch {}
  }
  res.json({ samples: allSamples })
})

// ─── DELETE /api/admin/voice-samples/:filename (protected) ───────────────────
router.delete('/voice-samples/:filename', authMiddleware, (req, res) => {
  const { filename } = req.params

  if (!filename || filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  const filePath = path.join(VOICE_SAMPLE_DIR, filename)
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      res.json({ message: 'Sample deleted' })
    } else {
      res.status(404).json({ error: 'File not found' })
    }
  } catch {
    res.status(500).json({ error: 'Failed to delete file' })
  }
})

// ─── GET /api/admin/voice-config (protected) ─────────────────────────────────
router.get('/voice-config', authMiddleware, (req, res) => {
  const data = readJSON('voice-config.json', null)
  if (data) {
    res.json(data)
  } else {
    res.json({ selectedVoice: 'onyx', speed: 1.0 })
  }
})

// ─── POST /api/admin/voice-config (protected) ────────────────────────────────
router.post('/voice-config', authMiddleware, (req, res) => {
  const { selectedVoice, speed } = req.body

  const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
  if (selectedVoice && !VALID_VOICES.includes(selectedVoice)) {
    return res.status(400).json({ error: 'Invalid voice selection' })
  }

  const validSpeed = typeof speed === 'number' && speed >= 0.25 && speed <= 4.0 ? speed : 1.0

  const config = {
    selectedVoice: selectedVoice || 'onyx',
    speed: validSpeed,
    updatedAt: new Date().toISOString(),
  }

  writeJSON('voice-config.json', config)
  res.json({ message: 'Voice config saved', config })
})

// ─── GET /api/admin/context (protected) ──────────────────────────────────────
router.get('/context', authMiddleware, (req, res) => {
  const data = readJSON('ai-context.json', null)
  if (data) {
    res.json({ context: data.context || '' })
  } else {
    res.json({ context: '' })
  }
})

// ─── POST /api/admin/context (protected) ─────────────────────────────────────
router.post('/context', authMiddleware, (req, res) => {
  const { context } = req.body
  writeJSON('ai-context.json', { context, updatedAt: new Date().toISOString() })
  res.json({ message: 'Context saved successfully' })
})

export default router
