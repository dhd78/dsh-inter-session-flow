import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.cache', '.tmp', '.venv', 'venv'])
const SKIP_FILES = new Set(['MANIFEST', 'MANIFEST.md', 'SHA256SUMS', 'SHA256SUMS.txt'])

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function skipFile(name) {
  return SKIP_FILES.has(name) || name.endsWith('.pyc') || name.endsWith('.tmp') || name.endsWith('~')
}

async function collect(root, current = root, files = []) {
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collect(root, full, files)
      continue
    }
    if (!entry.isFile() || skipFile(entry.name)) continue
    const rel = path.relative(root, full).split(path.sep).join('/')
    files.push({ full, rel })
  }
  return files
}

export async function hashSkillPackage(root) {
  const files = await collect(root)
  files.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')))
  const lines = []
  for (const file of files) {
    const bytes = await fs.readFile(file.full)
    lines.push(`${sha256Bytes(bytes)}  ${file.rel}`)
  }
  const manifest = lines.join('\n')
  return {
    packageHash: `sha256:${sha256Bytes(Buffer.from(manifest, 'utf8'))}`,
    manifest,
    files: files.map((file) => file.rel),
  }
}
