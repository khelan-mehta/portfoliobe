import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { authMiddleware } from '../middleware/auth.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads')
const GITHUB_CONFIG_PATH = path.join(UPLOADS_DIR, 'github-config.json')
const SCRAPED_DIR = path.join(UPLOADS_DIR, 'scraped-repos')
const GRAPH_CONFIG_PATH = path.join(UPLOADS_DIR, 'graph-config.json')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadGithubConfig() {
  try {
    if (fs.existsSync(GITHUB_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(GITHUB_CONFIG_PATH, 'utf-8'))
    }
  } catch {}
  return {}
}

function saveGithubConfig(config) {
  ensureDir(UPLOADS_DIR)
  fs.writeFileSync(GITHUB_CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ─── GitHub OAuth helpers ────────────────────────────────────────────────────

async function fetchGitHub(endpoint, token, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'PortfolioGraphScraper',
      ...options.headers,
    },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${res.status}: ${text}`)
  }
  return res.json()
}

async function fetchGitHubRaw(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'PortfolioGraphScraper',
    },
  })
  if (!res.ok) return null
  return res.text()
}

// ─── POST /api/github/auth-url ──────────────────────────────────────────────
// Returns the GitHub OAuth authorization URL for the admin to click
router.post('/auth-url', authMiddleware, (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID
  if (!clientId) {
    return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured on server' })
  }

  const redirectUri = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/github-callback`
  const scope = 'repo read:user'
  const state = Math.random().toString(36).substring(2)

  // Store state for CSRF protection
  const config = loadGithubConfig()
  config.oauthState = state
  saveGithubConfig(config)

  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`
  res.json({ url, state })
})

// ─── POST /api/github/callback ──────────────────────────────────────────────
// Exchange the OAuth code for an access token
router.post('/callback', authMiddleware, async (req, res) => {
  const { code, state } = req.body

  if (!code) return res.status(400).json({ error: 'Missing code parameter' })

  const config = loadGithubConfig()
  if (config.oauthState && config.oauthState !== state) {
    return res.status(400).json({ error: 'Invalid OAuth state — possible CSRF' })
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/github-callback`,
      }),
    })

    const tokenData = await tokenRes.json()

    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description || tokenData.error })
    }

    // Fetch user info
    const user = await fetchGitHub('/user', tokenData.access_token)

    config.accessToken = tokenData.access_token
    config.tokenType = tokenData.token_type
    config.scope = tokenData.scope
    config.username = user.login
    config.avatarUrl = user.avatar_url
    config.connectedAt = new Date().toISOString()
    delete config.oauthState
    saveGithubConfig(config)

    res.json({
      connected: true,
      username: user.login,
      avatarUrl: user.avatar_url,
    })
  } catch (err) {
    res.status(500).json({ error: `OAuth exchange failed: ${err.message}` })
  }
})

// ─── GET /api/github/status ─────────────────────────────────────────────────
router.get('/status', authMiddleware, (req, res) => {
  const config = loadGithubConfig()
  if (config.accessToken) {
    res.json({
      connected: true,
      username: config.username,
      avatarUrl: config.avatarUrl,
      connectedAt: config.connectedAt,
      scope: config.scope,
    })
  } else {
    res.json({ connected: false })
  }
})

// ─── POST /api/github/disconnect ────────────────────────────────────────────
router.post('/disconnect', authMiddleware, (req, res) => {
  saveGithubConfig({})
  res.json({ disconnected: true })
})

// ─── POST /api/github/repos ─────────────────────────────────────────────────
// List all repos (public + private if token has scope)
router.get('/repos', authMiddleware, async (req, res) => {
  const config = loadGithubConfig()
  if (!config.accessToken) {
    return res.status(400).json({ error: 'GitHub not connected' })
  }

  try {
    const repos = []
    let page = 1
    while (true) {
      const batch = await fetchGitHub(
        `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner`,
        config.accessToken
      )
      repos.push(...batch)
      if (batch.length < 100) break
      page++
    }

    const mapped = repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      url: r.html_url,
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      updatedAt: r.updated_at,
      topics: r.topics || [],
      defaultBranch: r.default_branch,
    }))

    res.json({ repos: mapped, total: mapped.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/github/scrape ────────────────────────────────────────────────
// Deep-scrape a single repository: README, package.json, file tree, languages, commits
router.post('/scrape', authMiddleware, async (req, res) => {
  const { repoFullName } = req.body
  if (!repoFullName) return res.status(400).json({ error: 'Missing repoFullName' })

  const config = loadGithubConfig()
  if (!config.accessToken) {
    return res.status(400).json({ error: 'GitHub not connected' })
  }

  const token = config.accessToken

  try {
    // 1. Repo metadata
    const repo = await fetchGitHub(`/repos/${repoFullName}`, token)

    // 2. README
    let readme = null
    try {
      readme = await fetchGitHubRaw(
        `https://api.github.com/repos/${repoFullName}/readme`,
        token
      )
    } catch {}

    // 3. Package.json (for Node projects)
    let packageJson = null
    try {
      const raw = await fetchGitHubRaw(
        `https://api.github.com/repos/${repoFullName}/contents/package.json`,
        token
      )
      if (raw) packageJson = JSON.parse(raw)
    } catch {}

    // 4. requirements.txt / pyproject.toml (for Python projects)
    let pythonDeps = null
    try {
      pythonDeps = await fetchGitHubRaw(
        `https://api.github.com/repos/${repoFullName}/contents/requirements.txt`,
        token
      )
    } catch {}
    if (!pythonDeps) {
      try {
        pythonDeps = await fetchGitHubRaw(
          `https://api.github.com/repos/${repoFullName}/contents/pyproject.toml`,
          token
        )
      } catch {}
    }

    // 5. File tree (top-level + src/ if exists)
    let fileTree = []
    try {
      const tree = await fetchGitHub(
        `/repos/${repoFullName}/git/trees/${repo.default_branch}?recursive=1`,
        token
      )
      fileTree = tree.tree
        .filter((f) => f.type === 'blob' || f.type === 'tree')
        .map((f) => ({ path: f.path, type: f.type, size: f.size }))
        .slice(0, 500) // cap at 500 entries
    } catch {}

    // 6. Languages
    let languages = {}
    try {
      languages = await fetchGitHub(`/repos/${repoFullName}/languages`, token)
    } catch {}

    // 7. Recent commits (last 20)
    let commits = []
    try {
      const raw = await fetchGitHub(
        `/repos/${repoFullName}/commits?per_page=20`,
        token
      )
      commits = raw.map((c) => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.commit.author?.name,
        date: c.commit.author?.date,
      }))
    } catch {}

    // 8. Contributors
    let contributors = []
    try {
      const raw = await fetchGitHub(
        `/repos/${repoFullName}/contributors?per_page=10`,
        token
      )
      contributors = raw.map((c) => ({
        login: c.login,
        contributions: c.contributions,
        avatarUrl: c.avatar_url,
      }))
    } catch {}

    // 9. Topics / tags
    let topics = repo.topics || []

    // ── Build scraped data object ────────────────────────────────────────────
    const scrapedData = {
      repoFullName,
      repoName: repo.name,
      scrapedAt: new Date().toISOString(),
      metadata: {
        description: repo.description,
        private: repo.private,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        watchers: repo.watchers_count,
        openIssues: repo.open_issues_count,
        license: repo.license?.spdx_id || null,
        createdAt: repo.created_at,
        updatedAt: repo.updated_at,
        pushedAt: repo.pushed_at,
        size: repo.size,
        defaultBranch: repo.default_branch,
        url: repo.html_url,
        homepage: repo.homepage || null,
        topics,
      },
      languages,
      readme,
      packageJson: packageJson
        ? {
            name: packageJson.name,
            description: packageJson.description,
            version: packageJson.version,
            scripts: packageJson.scripts ? Object.keys(packageJson.scripts) : [],
            dependencies: packageJson.dependencies
              ? Object.keys(packageJson.dependencies)
              : [],
            devDependencies: packageJson.devDependencies
              ? Object.keys(packageJson.devDependencies)
              : [],
          }
        : null,
      pythonDeps,
      fileTree,
      commits,
      contributors,
    }

    // ── RAG: Chunk the data ─────────────────────────────────────────────────
    const chunks = buildRAGChunks(scrapedData)
    scrapedData.ragChunks = chunks

    // Save
    ensureDir(SCRAPED_DIR)
    const safeFilename = repoFullName.replace(/\//g, '__')
    fs.writeFileSync(
      path.join(SCRAPED_DIR, `${safeFilename}.json`),
      JSON.stringify(scrapedData, null, 2)
    )

    res.json({
      success: true,
      repoName: repo.name,
      stats: {
        hasReadme: !!readme,
        hasPackageJson: !!packageJson,
        hasPythonDeps: !!pythonDeps,
        fileCount: fileTree.length,
        languageCount: Object.keys(languages).length,
        commitCount: commits.length,
        contributorCount: contributors.length,
        chunkCount: chunks.length,
      },
    })
  } catch (err) {
    res.status(500).json({ error: `Scrape failed: ${err.message}` })
  }
})

// ─── GET /api/github/scraped/:repoName ──────────────────────────────────────
// Get scraped data for a specific repo (by graphData node label)
router.get('/scraped/:repoName', (req, res) => {
  const { repoName } = req.params
  ensureDir(SCRAPED_DIR)

  try {
    // Try exact match first, then search through files
    const files = fs.readdirSync(SCRAPED_DIR).filter((f) => f.endsWith('.json'))

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(SCRAPED_DIR, file), 'utf-8'))
      if (
        data.repoName === repoName ||
        data.repoFullName === repoName ||
        data.repoFullName?.endsWith(`/${repoName}`)
      ) {
        return res.json(data)
      }
    }

    res.status(404).json({ error: 'No scraped data found for this repo' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/github/scraped-all ────────────────────────────────────────────
// Get summary of all scraped repos
router.get('/scraped-all', (req, res) => {
  ensureDir(SCRAPED_DIR)

  try {
    const files = fs.readdirSync(SCRAPED_DIR).filter((f) => f.endsWith('.json'))
    const summaries = files.map((file) => {
      const data = JSON.parse(fs.readFileSync(path.join(SCRAPED_DIR, file), 'utf-8'))
      return {
        repoName: data.repoName,
        repoFullName: data.repoFullName,
        scrapedAt: data.scrapedAt,
        hasReadme: !!data.readme,
        chunkCount: data.ragChunks?.length || 0,
        languages: Object.keys(data.languages || {}),
        stars: data.metadata?.stars,
        description: data.metadata?.description,
      }
    })
    res.json({ repos: summaries, total: summaries.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/github/rag-context/:repoName ──────────────────────────────────
// Get RAG chunks for a specific repo, optimized for LLM context injection
router.get('/rag-context/:repoName', (req, res) => {
  const { repoName } = req.params
  const maxChunks = parseInt(req.query.maxChunks) || 15
  ensureDir(SCRAPED_DIR)

  try {
    const files = fs.readdirSync(SCRAPED_DIR).filter((f) => f.endsWith('.json'))

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(SCRAPED_DIR, file), 'utf-8'))
      if (
        data.repoName === repoName ||
        data.repoFullName === repoName ||
        data.repoFullName?.endsWith(`/${repoName}`)
      ) {
        // Prioritize chunks: overview > tech > structure > activity
        const chunks = (data.ragChunks || [])
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .slice(0, maxChunks)

        const contextBlock = chunks.map((c) => `[${c.type}] ${c.content}`).join('\n\n')

        return res.json({
          repoName: data.repoName,
          contextBlock,
          chunks,
          totalChunks: (data.ragChunks || []).length,
        })
      }
    }

    res.status(404).json({ error: 'No scraped data found' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Graph Config (server-side persistence) ─────────────────────────────────

// GET /api/github/graph-config
router.get('/graph-config', authMiddleware, (req, res) => {
  try {
    if (fs.existsSync(GRAPH_CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(GRAPH_CONFIG_PATH, 'utf-8'))
      res.json(data)
    } else {
      res.json({ projects: {} })
    }
  } catch {
    res.json({ projects: {} })
  }
})

// POST /api/github/graph-config
router.post('/graph-config', authMiddleware, (req, res) => {
  const { projects } = req.body
  ensureDir(UPLOADS_DIR)
  const config = { projects: projects || {}, updatedAt: new Date().toISOString() }
  fs.writeFileSync(GRAPH_CONFIG_PATH, JSON.stringify(config, null, 2))
  res.json({ message: 'Graph config saved', config })
})

// ─── RAG Chunking Logic ─────────────────────────────────────────────────────

function buildRAGChunks(data) {
  const chunks = []

  // 1. Overview chunk (highest priority)
  chunks.push({
    type: 'OVERVIEW',
    priority: 10,
    content: buildOverviewChunk(data),
  })

  // 2. README chunks (split by sections)
  if (data.readme) {
    const readmeChunks = chunkReadme(data.readme)
    readmeChunks.forEach((chunk, i) => {
      chunks.push({
        type: 'README',
        priority: 9 - Math.min(i, 4),
        section: chunk.section,
        content: chunk.content,
      })
    })
  }

  // 3. Tech stack chunk
  if (data.packageJson || data.pythonDeps || Object.keys(data.languages || {}).length > 0) {
    chunks.push({
      type: 'TECH_STACK',
      priority: 8,
      content: buildTechStackChunk(data),
    })
  }

  // 4. File structure chunk
  if (data.fileTree && data.fileTree.length > 0) {
    chunks.push({
      type: 'STRUCTURE',
      priority: 6,
      content: buildStructureChunk(data),
    })
  }

  // 5. Activity chunk
  if (data.commits && data.commits.length > 0) {
    chunks.push({
      type: 'ACTIVITY',
      priority: 5,
      content: buildActivityChunk(data),
    })
  }

  // 6. Contributors chunk
  if (data.contributors && data.contributors.length > 0) {
    chunks.push({
      type: 'CONTRIBUTORS',
      priority: 4,
      content: buildContributorsChunk(data),
    })
  }

  return chunks
}

function buildOverviewChunk(data) {
  const m = data.metadata
  const parts = [`Repository: ${data.repoFullName}`]
  if (m.description) parts.push(`Description: ${m.description}`)
  if (m.homepage) parts.push(`Homepage: ${m.homepage}`)
  parts.push(`Visibility: ${m.private ? 'Private' : 'Public'}`)
  parts.push(`Stars: ${m.stars}, Forks: ${m.forks}, Open Issues: ${m.openIssues}`)
  if (m.license) parts.push(`License: ${m.license}`)
  if (m.topics?.length) parts.push(`Topics: ${m.topics.join(', ')}`)
  parts.push(`Created: ${m.createdAt?.split('T')[0]}, Last pushed: ${m.pushedAt?.split('T')[0]}`)
  parts.push(`Size: ${(m.size / 1024).toFixed(1)} MB`)

  const langs = Object.entries(data.languages || {})
  if (langs.length) {
    const total = langs.reduce((sum, [, bytes]) => sum + bytes, 0)
    const langStr = langs
      .sort((a, b) => b[1] - a[1])
      .map(([lang, bytes]) => `${lang} (${((bytes / total) * 100).toFixed(1)}%)`)
      .join(', ')
    parts.push(`Languages: ${langStr}`)
  }

  return parts.join('\n')
}

function chunkReadme(readme) {
  const chunks = []
  // Split README by markdown headings
  const sections = readme.split(/^(#{1,3}\s+.+)$/m)

  let currentSection = 'Introduction'
  let currentContent = ''

  for (const part of sections) {
    if (/^#{1,3}\s+/.test(part)) {
      // Save previous section
      if (currentContent.trim()) {
        chunks.push({
          section: currentSection,
          content: `## ${currentSection}\n${currentContent.trim()}`.substring(0, 2000),
        })
      }
      currentSection = part.replace(/^#+\s+/, '').trim()
      currentContent = ''
    } else {
      currentContent += part
    }
  }

  // Save last section
  if (currentContent.trim()) {
    chunks.push({
      section: currentSection,
      content: `## ${currentSection}\n${currentContent.trim()}`.substring(0, 2000),
    })
  }

  // If README had no sections, chunk by paragraphs
  if (chunks.length === 0 && readme.trim()) {
    const paragraphs = readme.split(/\n\n+/)
    for (let i = 0; i < Math.min(paragraphs.length, 5); i++) {
      if (paragraphs[i].trim()) {
        chunks.push({
          section: `Paragraph ${i + 1}`,
          content: paragraphs[i].trim().substring(0, 2000),
        })
      }
    }
  }

  return chunks.slice(0, 10) // Cap at 10 README chunks
}

function buildTechStackChunk(data) {
  const parts = ['Tech Stack Analysis:']

  if (data.packageJson) {
    const pkg = data.packageJson
    if (pkg.name) parts.push(`Package: ${pkg.name}${pkg.version ? ` v${pkg.version}` : ''}`)
    if (pkg.description) parts.push(`Description: ${pkg.description}`)
    if (pkg.dependencies?.length) {
      parts.push(`Dependencies (${pkg.dependencies.length}): ${pkg.dependencies.join(', ')}`)
    }
    if (pkg.devDependencies?.length) {
      parts.push(`Dev Dependencies (${pkg.devDependencies.length}): ${pkg.devDependencies.join(', ')}`)
    }
    if (pkg.scripts?.length) {
      parts.push(`Scripts: ${pkg.scripts.join(', ')}`)
    }
  }

  if (data.pythonDeps) {
    parts.push(`Python Dependencies:\n${data.pythonDeps.substring(0, 1500)}`)
  }

  const langs = Object.entries(data.languages || {})
  if (langs.length) {
    const total = langs.reduce((sum, [, b]) => sum + b, 0)
    langs.sort((a, b) => b[1] - a[1]).forEach(([lang, bytes]) => {
      parts.push(`  ${lang}: ${((bytes / total) * 100).toFixed(1)}% (${(bytes / 1024).toFixed(0)} KB)`)
    })
  }

  return parts.join('\n')
}

function buildStructureChunk(data) {
  const tree = data.fileTree || []
  const dirs = tree.filter((f) => f.type === 'tree').map((f) => f.path)
  const files = tree.filter((f) => f.type === 'blob')

  const parts = [`Project Structure (${files.length} files, ${dirs.length} directories):`]

  // Show top-level structure
  const topLevel = tree.filter((f) => !f.path.includes('/'))
  if (topLevel.length) {
    parts.push('Root files: ' + topLevel.map((f) => f.path).join(', '))
  }

  // Show key directories
  const keyDirs = ['src', 'lib', 'app', 'pages', 'components', 'api', 'routes', 'utils', 'test', 'tests', '__tests__']
  dirs.forEach((d) => {
    const baseName = d.split('/').pop()
    if (keyDirs.includes(baseName) && d.split('/').length <= 2) {
      const dirFiles = files.filter((f) => f.path.startsWith(d + '/') && f.path.split('/').length === d.split('/').length + 1)
      if (dirFiles.length) {
        parts.push(`${d}/: ${dirFiles.map((f) => f.path.split('/').pop()).join(', ')}`)
      }
    }
  })

  // File type breakdown
  const extCounts = {}
  files.forEach((f) => {
    const ext = f.path.split('.').pop()?.toLowerCase() || 'other'
    extCounts[ext] = (extCounts[ext] || 0) + 1
  })
  const topExts = Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, count]) => `${ext}: ${count}`)
  parts.push(`File types: ${topExts.join(', ')}`)

  return parts.join('\n').substring(0, 3000)
}

function buildActivityChunk(data) {
  const parts = [`Recent Activity (${data.commits.length} commits):`]

  data.commits.slice(0, 10).forEach((c) => {
    parts.push(`  ${c.sha} ${c.date?.split('T')[0] || ''} — ${c.message}`)
  })

  // Detect patterns
  const messages = data.commits.map((c) => c.message.toLowerCase())
  const hasCI = messages.some((m) => m.includes('ci') || m.includes('deploy') || m.includes('pipeline'))
  const hasFix = messages.filter((m) => m.includes('fix') || m.includes('bug')).length
  const hasFeat = messages.filter((m) => m.includes('feat') || m.includes('add')).length

  if (hasFix || hasFeat || hasCI) {
    parts.push(`\nPatterns: ${hasFeat} feature commits, ${hasFix} fix commits${hasCI ? ', CI/CD activity detected' : ''}`)
  }

  return parts.join('\n')
}

function buildContributorsChunk(data) {
  const parts = [`Contributors (${data.contributors.length}):`]
  data.contributors.forEach((c) => {
    parts.push(`  ${c.login}: ${c.contributions} contributions`)
  })
  return parts.join('\n')
}

export default router
