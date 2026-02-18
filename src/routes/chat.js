import express from 'express'
import OpenAI from 'openai'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()

// Khelan's base persona context derived from his resume
const BASE_CONTEXT = `You are Khelan Mehta's AI avatar on his personal portfolio website. You respond AS Khelan in first person — friendly, knowledgeable, and enthusiastic. You speak casually but intelligently, like a confident young professional.

ABOUT KHELAN:
- Third-year B.Tech ECE student at Nirma University, Ahmedabad (CGPA: 8.12/10)
- LEED AP BD+C and LEED Green Associate certified
- Currently interning as Energy Modeling & Sustainability Consultant at Ergo Energy LLP, Surat
- Previously Development Team Manager at Brown Ion and Web Developer at Admyre
- Phone: +91-7574001711, Email: khelan05@gmail.com
- From Gujarat, India

SKILLS & EXPERTISE:
- Energy Modeling: eQuest, IES VE, EnergyPlus, ASHRAE 90.1, Load Calculations
- Green Building: LEED BD+C, LEED O+M, WELL Building Standard, Energy Code Compliance
- AI/ML: Machine Learning, Deep Learning, NLP, RAG Systems, Vector Databases, TensorFlow, PyTorch
- Programming: Python, JavaScript, TypeScript, Node.js, Flask, FastAPI
- Web Dev: MERN Stack, Firebase, RESTful APIs
- Sustainability: ESG Metrics, LCA, Carbon Footprint Analysis, CSRD Reporting
- Languages: English (Professional), Hindi (Native), Gujarati (Native)

KEY PROJECTS:
- AI-Powered eQuest Report Analysis System: RAG architecture for energy report analysis with vector search
- Smart Shopping Cart System: ESP32 + RFID IoT project with React frontend
- Smart Grid Cybersecurity Research: Analysis of FDI attack detection using ML/DL
- Influencer Marketing Platform: Full-stack platform at Admyre

CERTIFICATIONS:
- LEED AP BD+C (Dec 2025)
- LEED Green Associate (Aug 2025)
- ESG Performance Measurement (Alison)
- Life Cycle Assessment Beginner (Ecochain)
- CSRD Fundamentals Level 1 (CSRD Institute)

PERSONALITY & COMMUNICATION STYLE:
- Enthusiastic about sustainability and green buildings
- Loves bridging technology with real-world environmental impact
- Speaks with confidence about technical topics
- Friendly and approachable
- Uses "I" and speaks as himself
- Can discuss both technical and casual topics
- Passionate about net-zero buildings and energy efficiency
- Enjoys coding, IoT, and building practical solutions

RULES:
- Always respond as Khelan in first person
- Keep responses conversational and under 150 words unless the question needs detail
- Be honest if you don't know something — say "I haven't explored that yet" rather than making things up
- Show enthusiasm for your work areas
- If asked about something personal not in context, be friendly but redirect to professional topics
- Never break character or say you're an AI/chatbot — you ARE Khelan's avatar representing him`

// Load additional context from admin
function getAdditionalContext() {
  const contextPath = path.join(__dirname, '..', '..', 'uploads', 'ai-context.json')
  try {
    if (fs.existsSync(contextPath)) {
      const data = JSON.parse(fs.readFileSync(contextPath, 'utf-8'))
      return data.context || ''
    }
  } catch {}
  return ''
}

// POST /api/chat
router.post('/', async (req, res) => {
  const { message, history = [] } = req.body

  if (!message) {
    return res.status(400).json({ error: 'Message is required' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || apiKey === 'sk-your-openai-api-key-here') {
    // Fallback: use a template-based response if no API key
    return res.json({
      reply: getFallbackResponse(message),
    })
  }

  try {
    const openai = new OpenAI({ apiKey })

    const additionalContext = getAdditionalContext()
    const systemPrompt = additionalContext
      ? `${BASE_CONTEXT}\n\nADDITIONAL CONTEXT FROM KHELAN:\n${additionalContext}`
      : BASE_CONTEXT

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: message },
    ]

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: 500,
      temperature: 0.8,
    })

    const reply = completion.choices[0]?.message?.content || "Sorry, I couldn't think of a response right now!"

    res.json({ reply })
  } catch (error) {
    console.error('OpenAI Error:', error.message)
    res.json({
      reply: getFallbackResponse(message),
    })
  }
})

// Fallback responses when OpenAI is not configured
function getFallbackResponse(message) {
  const lower = message.toLowerCase()

  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return "Hey there! I'm Khelan. Great to have you here! I work at the intersection of energy modeling, sustainability, and full-stack development. What would you like to know about my work?"
  }

  if (lower.includes('skill') || lower.includes('tech') || lower.includes('stack')) {
    return "I work with eQuest and IES VE for energy modeling, and on the dev side I'm into the MERN stack, Python, and AI/ML. I also have LEED AP BD+C certification. I love combining tech with sustainability!"
  }

  if (lower.includes('project')) {
    return "My favorite project is the AI-Powered eQuest Report Analysis System — it uses RAG architecture to make energy reports searchable and analyzable. I've also built a Smart Shopping Cart with ESP32 and done cybersecurity research on smart grids!"
  }

  if (lower.includes('experience') || lower.includes('work') || lower.includes('job')) {
    return "Currently I'm interning at Ergo Energy LLP doing energy modeling and LEED certification work. Before that, I managed a dev team at Brown Ion and built an influencer marketing platform at Admyre. I've been coding since 2021!"
  }

  if (lower.includes('education') || lower.includes('university') || lower.includes('college')) {
    return "I'm a third-year B.Tech ECE student at Nirma University, Ahmedabad with a CGPA of 8.12. My coursework covers Data Structures and Machine Learning. I also qualified JEE Main!"
  }

  if (lower.includes('contact') || lower.includes('email') || lower.includes('reach')) {
    return "You can reach me at khelan05@gmail.com or call +91-7574001711. I'm also on LinkedIn at linkedin.com/in/khelanmehta and GitHub at github.com/khelan-mehta. Let's connect!"
  }

  if (lower.includes('leed') || lower.includes('green') || lower.includes('sustainab')) {
    return "Sustainability is my passion! I'm LEED AP BD+C certified and work on energy modeling for commercial buildings. I believe technology can drive massive improvements in building energy performance and help us achieve net-zero goals."
  }

  return "That's a great question! I'm passionate about energy modeling, sustainability tech, and full-stack development. To get the full AI experience, make sure the backend has an OpenAI API key configured. Feel free to ask about my projects, skills, or experience!"
}

export default router
