#!/usr/bin/env node
/**
 * Deep Scrape Script — fetches ALL code files with full content for top-ranked projects.
 * No file count limits, no content truncation. Builds comprehensive RAG chunks.
 *
 * Usage: node scripts/deep-scrape.js
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')
const SCRAPED_DIR = path.join(UPLOADS_DIR, 'scraped-repos')

// ── GitHub API helpers ─────────────────────────────────────────────────────

async function fetchGitHub(endpoint, token) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'PortfolioDeepScraper',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${res.status}: ${text.substring(0, 200)}`)
  }
  return res.json()
}

async function fetchRaw(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'PortfolioDeepScraper',
    },
  })
  if (!res.ok) return null
  return res.text()
}

async function checkRateLimit(token) {
  const data = await fetchGitHub('/rate_limit', token)
  const core = data.resources.core
  console.log(`  Rate limit: ${core.remaining}/${core.limit} remaining, resets at ${new Date(core.reset * 1000).toLocaleTimeString()}`)
  return core.remaining
}

// ── Allowed extensions for code files ──────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'pyw', 'pyi',
  'java', 'kt', 'kts', 'scala',
  'c', 'cpp', 'cc', 'h', 'hpp', 'hxx',
  'cs', 'fs', 'fsx',
  'go', 'rs', 'zig',
  'php', 'rb', 'swift',
  'dart', 'lua', 'r', 'jl',
  'md', 'mdx', 'txt', 'rst',
  'json', 'jsonc', 'json5',
  'yml', 'yaml', 'toml', 'ini', 'cfg',
  'xml', 'svg', 'plist',
  'html', 'htm', 'ejs', 'hbs', 'pug', 'jade',
  'css', 'scss', 'sass', 'less', 'styl',
  'sql', 'prisma', 'graphql', 'gql',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1', 'cmd',
  'dockerfile', 'docker-compose',
  'env', 'env.example', 'env.local',
  'gitignore', 'eslintrc', 'prettierrc', 'editorconfig',
  'makefile', 'cmake',
  'proto', 'thrift', 'avsc',
  'tf', 'tfvars', 'hcl',
  'ipynb',
])

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '__pycache__', '.git',
  'venv', 'env', '.venv', '.env', 'vendor', 'coverage',
  '.idea', '.vscode', '.vs', 'target', 'bin', 'obj',
  '.gradle', '.mvn', 'out', '.cache', '.parcel-cache',
  'public/assets', '.turbo', '.svelte-kit', '.nuxt',
])

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'Gemfile.lock', 'Pipfile.lock', 'poetry.lock', 'cargo.lock',
  'go.sum', 'flake.lock',
])

function shouldFetchFile(f) {
  if (f.type !== 'blob') return false
  if (f.size > 500 * 1024) return false // skip files > 500KB

  const pathParts = f.path.split('/')
  // Check skip dirs
  for (const part of pathParts.slice(0, -1)) {
    if (SKIP_DIRS.has(part) || SKIP_DIRS.has(part.toLowerCase())) return false
  }

  const filename = pathParts[pathParts.length - 1]
  if (SKIP_FILES.has(filename)) return false

  // Check extension
  const dotParts = filename.split('.')
  if (dotParts.length < 2) {
    // Files without extensions — check known names
    const knownNoExt = ['Makefile', 'Dockerfile', 'Procfile', 'Rakefile', 'Gemfile', 'Pipfile', 'LICENSE', 'README']
    return knownNoExt.some(k => filename.toLowerCase().startsWith(k.toLowerCase()))
  }
  const ext = dotParts.pop().toLowerCase()
  return CODE_EXTENSIONS.has(ext)
}

// ── RAG Chunking ───────────────────────────────────────────────────────────

function buildRAGChunks(data) {
  const chunks = []

  // OVERVIEW — highest priority
  chunks.push({ type: 'OVERVIEW', priority: 10, content: buildOverview(data) })

  // README — full, split by sections
  if (data.readme) {
    chunkReadme(data.readme).forEach((chunk, i) => {
      chunks.push({ type: 'README', priority: 9 - Math.min(i, 4), section: chunk.section, content: chunk.content })
    })
  }

  // TECH_STACK
  if (data.packageJson || data.pythonDeps || Object.keys(data.languages || {}).length > 0) {
    chunks.push({ type: 'TECH_STACK', priority: 8, content: buildTechStack(data) })
  }

  // STRUCTURE
  if (data.fileTree?.length > 0) {
    chunks.push({ type: 'STRUCTURE', priority: 6, content: buildStructure(data) })
  }

  // FILE_CONTENT — full file contents, chunked at 4000 chars each
  if (data.fileTree?.length > 0) {
    data.fileTree.forEach(f => {
      if (!f.content) return
      const lines = f.content.split('\n')
      let current = ''
      let partNum = 1

      for (const line of lines) {
        current += line + '\n'
        if (current.length > 4000) {
          chunks.push({
            type: 'FILE_CONTENT',
            priority: 7,
            section: `${f.path} (Part ${partNum})`,
            content: `File: ${f.path}\n\n${current}`,
          })
          current = ''
          partNum++
        }
      }
      if (current.trim()) {
        chunks.push({
          type: 'FILE_CONTENT',
          priority: 7,
          section: partNum > 1 ? `${f.path} (Part ${partNum})` : f.path,
          content: `File: ${f.path}\n\n${current.trim()}`,
        })
      }
    })
  }

  // ACTIVITY
  if (data.commits?.length > 0) {
    chunks.push({ type: 'ACTIVITY', priority: 5, content: buildActivity(data) })
  }

  // CONTRIBUTORS
  if (data.contributors?.length > 0) {
    chunks.push({ type: 'CONTRIBUTORS', priority: 4, content: buildContributors(data) })
  }

  return chunks
}

function buildOverview(data) {
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
  const sections = readme.split(/^(#{1,3}\s+.+)$/m)
  let currentSection = 'Introduction'
  let currentContent = ''

  for (const part of sections) {
    if (/^#{1,3}\s+/.test(part)) {
      if (currentContent.trim()) {
        chunks.push({ section: currentSection, content: `## ${currentSection}\n${currentContent.trim()}` })
      }
      currentSection = part.replace(/^#+\s+/, '').trim()
      currentContent = ''
    } else {
      currentContent += part
    }
  }
  if (currentContent.trim()) {
    chunks.push({ section: currentSection, content: `## ${currentSection}\n${currentContent.trim()}` })
  }

  if (chunks.length === 0 && readme.trim()) {
    chunks.push({ section: 'Full README', content: readme.trim() })
  }
  return chunks
}

function buildTechStack(data) {
  const parts = ['Tech Stack Analysis:']
  if (data.packageJson) {
    const pkg = data.packageJson
    if (pkg.name) parts.push(`Package: ${pkg.name}${pkg.version ? ` v${pkg.version}` : ''}`)
    if (pkg.description) parts.push(`Description: ${pkg.description}`)
    if (pkg.dependencies?.length) parts.push(`Dependencies (${pkg.dependencies.length}): ${pkg.dependencies.join(', ')}`)
    if (pkg.devDependencies?.length) parts.push(`Dev Dependencies (${pkg.devDependencies.length}): ${pkg.devDependencies.join(', ')}`)
    if (pkg.scripts?.length) parts.push(`Scripts: ${pkg.scripts.join(', ')}`)
  }
  if (data.pythonDeps) parts.push(`Python Dependencies:\n${data.pythonDeps}`)

  const langs = Object.entries(data.languages || {})
  if (langs.length) {
    const total = langs.reduce((sum, [, b]) => sum + b, 0)
    langs.sort((a, b) => b[1] - a[1]).forEach(([lang, bytes]) => {
      parts.push(`  ${lang}: ${((bytes / total) * 100).toFixed(1)}% (${(bytes / 1024).toFixed(0)} KB)`)
    })
  }
  return parts.join('\n')
}

function buildStructure(data) {
  const tree = data.fileTree || []
  const dirs = tree.filter(f => f.type === 'tree').map(f => f.path)
  const files = tree.filter(f => f.type === 'blob')
  const parts = [`Project Structure (${files.length} files, ${dirs.length} directories):`]

  // Full directory tree (top 3 levels)
  const topDirs = dirs.filter(d => d.split('/').length <= 3)
  if (topDirs.length) parts.push('\nDirectory tree:')
  topDirs.forEach(d => {
    const depth = d.split('/').length - 1
    parts.push('  '.repeat(depth) + '├── ' + d.split('/').pop() + '/')
  })

  // Root files
  const topLevel = tree.filter(f => !f.path.includes('/') && f.type === 'blob')
  if (topLevel.length) parts.push('\nRoot files: ' + topLevel.map(f => f.path).join(', '))

  // File type distribution
  const extCounts = {}
  files.forEach(f => {
    const ext = f.path.split('.').pop()?.toLowerCase() || 'other'
    extCounts[ext] = (extCounts[ext] || 0) + 1
  })
  const topExts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).map(([ext, count]) => `${ext}: ${count}`)
  parts.push(`\nFile types: ${topExts.join(', ')}`)

  return parts.join('\n')
}

function buildActivity(data) {
  const parts = [`Recent Activity (${data.commits.length} commits):`]
  data.commits.forEach(c => {
    parts.push(`  ${c.sha} ${c.date?.split('T')[0] || ''} — ${c.message}`)
  })
  return parts.join('\n')
}

function buildContributors(data) {
  const parts = [`Contributors (${data.contributors.length}):`]
  data.contributors.forEach(c => { parts.push(`  ${c.login}: ${c.contributions} contributions`) })
  return parts.join('\n')
}

// ── Deep scrape a single repo ──────────────────────────────────────────────

async function deepScrapeRepo(repoFullName, token) {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  DEEP SCRAPING: ${repoFullName}`)
  console.log(`${'═'.repeat(70)}`)

  const repo = await fetchGitHub(`/repos/${repoFullName}`, token)
  console.log(`  ✓ Repo metadata fetched (${repo.size} KB, ${repo.stargazers_count} stars)`)

  // README
  let readme = null
  try { readme = await fetchRaw(`https://api.github.com/repos/${repoFullName}/readme`, token) } catch {}
  console.log(`  ${readme ? '✓' : '✗'} README ${readme ? `(${readme.length} chars)` : 'not found'}`)

  // package.json
  let packageJson = null
  try {
    const raw = await fetchRaw(`https://api.github.com/repos/${repoFullName}/contents/package.json`, token)
    if (raw) packageJson = JSON.parse(raw)
  } catch {}

  // Python deps
  let pythonDeps = null
  try { pythonDeps = await fetchRaw(`https://api.github.com/repos/${repoFullName}/contents/requirements.txt`, token) } catch {}
  if (!pythonDeps) {
    try { pythonDeps = await fetchRaw(`https://api.github.com/repos/${repoFullName}/contents/pyproject.toml`, token) } catch {}
  }

  // Full file tree (no limit)
  let fileTree = []
  try {
    const tree = await fetchGitHub(`/repos/${repoFullName}/git/trees/${repo.default_branch}?recursive=1`, token)
    fileTree = tree.tree
      .filter(f => f.type === 'blob' || f.type === 'tree')
      .map(f => ({ path: f.path, type: f.type, size: f.size }))
    console.log(`  ✓ File tree: ${fileTree.length} entries`)
  } catch (e) {
    console.log(`  ✗ File tree failed: ${e.message}`)
  }

  // Filter files to fetch — NO LIMIT on count
  const filesToFetch = fileTree.filter(shouldFetchFile)
  console.log(`  → ${filesToFetch.length} code files to fetch (out of ${fileTree.filter(f => f.type === 'blob').length} total blobs)`)

  // Fetch ALL file contents in batches of 15
  let fetched = 0
  let failed = 0
  for (let i = 0; i < filesToFetch.length; i += 15) {
    const batch = filesToFetch.slice(i, i + 15)
    await Promise.all(batch.map(async (f) => {
      try {
        const content = await fetchRaw(`https://api.github.com/repos/${repoFullName}/contents/${f.path}`, token)
        if (content) {
          f.content = content
          fetched++
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }))
    // Progress update every 60 files
    if ((i + 15) % 60 === 0 || i + 15 >= filesToFetch.length) {
      process.stdout.write(`  → Fetched ${Math.min(i + 15, filesToFetch.length)}/${filesToFetch.length} files...\r`)
    }
  }
  console.log(`  ✓ File contents: ${fetched} fetched, ${failed} failed`)

  // Languages
  let languages = {}
  try { languages = await fetchGitHub(`/repos/${repoFullName}/languages`, token) } catch {}

  // Commits (fetch more — 50)
  let commits = []
  try {
    const raw = await fetchGitHub(`/repos/${repoFullName}/commits?per_page=50`, token)
    commits = raw.map(c => ({
      sha: c.sha.substring(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author?.name,
      date: c.commit.author?.date,
    }))
  } catch {}

  // Contributors
  let contributors = []
  try {
    const raw = await fetchGitHub(`/repos/${repoFullName}/contributors?per_page=30`, token)
    contributors = raw.map(c => ({
      login: c.login,
      contributions: c.contributions,
      avatarUrl: c.avatar_url,
    }))
  } catch {}

  // Assemble scraped data
  const scrapedData = {
    repoFullName,
    repoName: repo.name,
    scrapedAt: new Date().toISOString(),
    deepScrape: true,
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
      topics: repo.topics || [],
    },
    languages,
    readme,
    packageJson: packageJson ? {
      name: packageJson.name,
      description: packageJson.description,
      version: packageJson.version,
      scripts: packageJson.scripts ? Object.keys(packageJson.scripts) : [],
      dependencies: packageJson.dependencies ? Object.keys(packageJson.dependencies) : [],
      devDependencies: packageJson.devDependencies ? Object.keys(packageJson.devDependencies) : [],
    } : null,
    pythonDeps,
    fileTree,
    commits,
    contributors,
  }

  // Build RAG chunks
  const chunks = buildRAGChunks(scrapedData)
  scrapedData.ragChunks = chunks

  // Save
  const safeFilename = repoFullName.replace(/\//g, '__')
  const outPath = path.join(SCRAPED_DIR, `${safeFilename}.json`)
  if (!fs.existsSync(SCRAPED_DIR)) fs.mkdirSync(SCRAPED_DIR, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(scrapedData, null, 2))

  const fileSizeKB = (fs.statSync(outPath).size / 1024).toFixed(0)
  const filesWithContent = fileTree.filter(f => f.content).length

  console.log(`  ✓ RAG chunks: ${chunks.length}`)
  console.log(`  ✓ Saved: ${outPath} (${fileSizeKB} KB)`)
  console.log(`  Summary: ${filesWithContent} files scraped, ${Object.keys(languages).length} languages, ${commits.length} commits`)

  return {
    repoName: repo.name,
    filesScraped: filesWithContent,
    chunkCount: chunks.length,
    sizeKB: parseInt(fileSizeKB),
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║         DEEP SCRAPER — Full Code Content for Top Projects      ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')

  // Load GitHub token
  const configPath = path.join(UPLOADS_DIR, 'github-config.json')
  if (!fs.existsSync(configPath)) {
    console.error('ERROR: No github-config.json found. Connect GitHub first via the admin panel.')
    process.exit(1)
  }
  const githubConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  if (!githubConfig.accessToken) {
    console.error('ERROR: No GitHub access token found.')
    process.exit(1)
  }
  console.log(`GitHub user: ${githubConfig.username}`)

  // Check rate limit
  const remaining = await checkRateLimit(githubConfig.accessToken)
  if (remaining < 100) {
    console.error(`ERROR: Only ${remaining} API requests remaining. Wait for reset.`)
    process.exit(1)
  }

  // Load graph config for rankings
  const graphConfigPath = path.join(UPLOADS_DIR, 'graph-config.json')
  const graphConfig = fs.existsSync(graphConfigPath)
    ? JSON.parse(fs.readFileSync(graphConfigPath, 'utf-8'))
    : { projects: {} }

  // Get top ranked projects
  const ranked = Object.entries(graphConfig.projects)
    .filter(([, cfg]) => cfg.rank)
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([id, cfg]) => ({
      id,
      rank: cfg.rank,
      repoName: id.replace('repo-', ''),
      fullName: `${githubConfig.username}/${id.replace('repo-', '')}`,
    }))

  console.log(`\nTop ranked projects (${ranked.length}):`)
  ranked.forEach(r => console.log(`  #${r.rank} — ${r.fullName}`))

  // Scrape each
  const results = []
  for (const project of ranked) {
    try {
      const result = await deepScrapeRepo(project.fullName, githubConfig.accessToken)
      results.push({ ...project, ...result, success: true })
    } catch (err) {
      console.error(`  ✗ FAILED: ${err.message}`)
      results.push({ ...project, success: false, error: err.message })
    }

    // Check rate limit between repos
    await checkRateLimit(githubConfig.accessToken)
  }

  // Final summary
  console.log(`\n${'═'.repeat(70)}`)
  console.log('  SCRAPE COMPLETE — SUMMARY')
  console.log(`${'═'.repeat(70)}`)
  results.forEach(r => {
    if (r.success) {
      console.log(`  ✓ #${r.rank} ${r.repoName}: ${r.filesScraped} files, ${r.chunkCount} chunks, ${r.sizeKB} KB`)
    } else {
      console.log(`  ✗ #${r.rank} ${r.repoName}: FAILED — ${r.error}`)
    }
  })

  const totalFiles = results.filter(r => r.success).reduce((sum, r) => sum + r.filesScraped, 0)
  const totalChunks = results.filter(r => r.success).reduce((sum, r) => sum + r.chunkCount, 0)
  const totalSize = results.filter(r => r.success).reduce((sum, r) => sum + r.sizeKB, 0)
  console.log(`\n  Total: ${totalFiles} files scraped, ${totalChunks} RAG chunks, ${totalSize} KB data`)
  console.log(`  Stored in: ${SCRAPED_DIR}\n`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
