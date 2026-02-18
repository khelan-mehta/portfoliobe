import express from 'express'
import OpenAI from 'openai'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()

const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
const VOICE_CONFIG_PATH = path.join(__dirname, '..', '..', 'uploads', 'voice-config.json')
const VOICE_SAMPLE_DIR = path.join(__dirname, '..', '..', 'uploads', 'voice-samples')

function getVoiceConfig() {
  try {
    if (fs.existsSync(VOICE_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(VOICE_CONFIG_PATH, 'utf-8'))
    }
  } catch {}
  return { selectedVoice: 'onyx', speed: 1.0 }
}

// POST /api/tts — Generate speech audio from text using OpenAI TTS
router.post('/', async (req, res) => {
  const { text } = req.body

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required and must be a string' })
  }

  // Enforce a generous but safe limit
  const sanitizedText = text.slice(0, 4096).trim()
  if (!sanitizedText) {
    return res.status(400).json({ error: 'Text cannot be empty' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || apiKey === 'sk-your-openai-api-key-here') {
    return res.status(503).json({ error: 'TTS not configured — set OPENAI_API_KEY in .env' })
  }

  try {
    const openai = new OpenAI({ apiKey })
    const config = getVoiceConfig()

    const voice = VALID_VOICES.includes(config.selectedVoice) ? config.selectedVoice : 'onyx'
    const speed =
      typeof config.speed === 'number' && config.speed >= 0.25 && config.speed <= 4.0
        ? config.speed
        : 1.0

    const mp3Response = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice,
      input: sanitizedText,
      speed,
    })

    const buffer = Buffer.from(await mp3Response.arrayBuffer())

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Voice-Used': voice,
      'X-Voice-Speed': String(speed),
    })

    return res.send(buffer)
  } catch (error) {
    console.error('[TTS] OpenAI error:', error.message)
    return res.status(500).json({ error: 'TTS generation failed', detail: error.message })
  }
})

// GET /api/tts/config — Return current voice configuration and available voices
router.get('/config', (req, res) => {
  const config = getVoiceConfig()
  const hasSample = fs.existsSync(VOICE_SAMPLE_DIR) && fs.readdirSync(VOICE_SAMPLE_DIR).length > 0

  res.json({
    voices: VALID_VOICES.map((v) => ({
      id: v,
      label: v.charAt(0).toUpperCase() + v.slice(1),
      selected: v === (config.selectedVoice || 'onyx'),
    })),
    speed: config.speed ?? 1.0,
    hasSample,
    model: 'tts-1-hd',
  })
})

export default router
