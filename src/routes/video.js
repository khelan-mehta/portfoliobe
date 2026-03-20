import express from 'express'
import fs from 'fs'
import { readablePath } from '../storage.js'

const router = express.Router()

// GET /api/video — return the current avatar video URL
router.get('/', (req, res) => {
  try {
    // Check the readable uploads dir for avatar video
    const uploadsDir = readablePath('')
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
