import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import adminRoutes from './routes/admin.js'
import chatRoutes from './routes/chat.js'
import videoRoutes from './routes/video.js'
import ttsRoutes from './routes/tts.js'
import githubRoutes from './routes/github.js'
import { connectDB } from './db.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  } else if (!origin) {
    // Allow non-browser requests (Postman, curl, server-to-server)
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0])
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))

// ─── Static file serving ──────────────────────────────────────────────────────
// Serve uploaded files from both the bundled dir and /tmp (Vercel)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')))
if (process.env.VERCEL) {
  app.use('/uploads', express.static('/tmp/uploads'))
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/video', videoRoutes)
app.use('/api/tts', ttsRoutes)
app.use('/api/github', githubRoutes)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    tts: !!process.env.OPENAI_API_KEY,
    github: !!process.env.GITHUB_CLIENT_ID,
  })
})

// Connect to Database and start server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`)
    console.log(`  ║  Portfolio Backend Running            ║`)
    console.log(`  ║  http://localhost:${PORT}               ║`)
    console.log(`  ║  TTS: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing OPENAI_API_KEY'}           ║`)
    console.log(`  ╚══════════════════════════════════════╝\n`)
  })
})
