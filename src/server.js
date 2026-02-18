import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import adminRoutes from './routes/admin.js'
import chatRoutes from './routes/chat.js'
import videoRoutes from './routes/video.js'
import ttsRoutes from './routes/tts.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:5173'
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))

// ─── Static file serving ──────────────────────────────────────────────────────
// Serve uploaded videos + voice samples
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')))

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/video', videoRoutes)
app.use('/api/tts', ttsRoutes)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    tts: !!process.env.OPENAI_API_KEY,
  })
})

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`)
  console.log(`  ║  Portfolio Backend Running            ║`)
  console.log(`  ║  http://localhost:${PORT}               ║`)
  console.log(`  ║  TTS: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing OPENAI_API_KEY'}           ║`)
  console.log(`  ╚══════════════════════════════════════╝\n`)
})
