import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()

// GET /api/video — return the current avatar video URL
router.get('/', (req, res) => {
  const uploadsDir = path.join(__dirname, '..', '..', 'uploads')

  try {
    if (!fs.existsSync(uploadsDir)) {
      return res.json({ videoUrl: null })
    }

    const files = fs.readdirSync(uploadsDir)
    const videoFile = files.find((f) => f.startsWith('avatar-video'))

    if (videoFile) {
      res.json({ videoUrl: `/uploads/${videoFile}` })
    } else {
      res.json({ videoUrl: null })
    }
  } catch {
    res.json({ videoUrl: null })
  }
})

export default router
