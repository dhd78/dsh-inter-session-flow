import path from 'node:path'
import fs from 'node:fs/promises'
import { hashValue } from './hash.js'
import { hashSkillPackage } from './skill-package.js'

function parseRef(ref) {
  const withoutVersion = String(ref || '').split('@')[0]
  const slash = withoutVersion.indexOf('/')
  if (slash > 0) {
    return {
      provider: withoutVersion.slice(0, slash),
      name: withoutVersion.slice(slash + 1),
      version: String(ref).includes('@') ? String(ref).split('@')[1] : null,
    }
  }
  return {
    provider: '',
    name: withoutVersion,
    version: String(ref).includes('@') ? String(ref).split('@')[1] : null,
  }
}

function contentHashFor(definition) {
  return hashValue({
    name: definition.name || '',
    description: definition.description || '',
    whenToUse: definition.whenToUse || '',
    content: definition.content || '',
    source: definition.source || '',
  })
}

async function packageHashFor(definition) {
  if (!definition.path) return null
  try {
    const stat = await fs.stat(definition.path)
    const dir = stat.isDirectory() ? definition.path : path.dirname(definition.path)
    return (await hashSkillPackage(dir)).packageHash
  } catch {
    return null
  }
}

function findDefinition(list, provider, name) {
  if (provider) return list.find((item) => item.provider === provider && item.name === name)
  return list.find((item) => item.name === name)
}

function lockPath(root, flowId) {
  return path.join(root, 'skill-locks', `${flowId}.json`)
}

export async function readSkillLocks(root, flowId) {
  try {
    return JSON.parse(await fs.readFile(lockPath(root, flowId), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeSkillLocks(root, flowId, flowVersion, locks) {
  const file = lockPath(root, flowId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const value = { schemaVersion: 1, flowId, flowVersion, locks: Array.isArray(locks) ? locks : [] }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temp, file)
  return value
}

export async function resolveSkillLocks(skills, nodes) {
  const refs = []
  const seen = new Set()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    for (const ref of Array.isArray(node.skillRefs) ? node.skillRefs : []) {
      if (!seen.has(ref)) {
        seen.add(ref)
        refs.push(ref)
      }
    }
  }
  let list = []
  try {
    list = skills && typeof skills.list === 'function' ? await skills.list({}) : []
  } catch {
    list = []
  }
  const locks = []
  const missing = []
  for (const ref of refs) {
    const parsed = parseRef(ref)
    const summary = findDefinition(Array.isArray(list) ? list : [], parsed.provider, parsed.name)
    let definition = null
    try {
      definition = skills && typeof skills.get === 'function' ? await skills.get(parsed.name) : null
    } catch {
      definition = null
    }
    if (!definition) {
      missing.push(ref)
      locks.push({
        name: parsed.name,
        provider: parsed.provider || undefined,
        version: parsed.version,
        required: true,
        contentHash: null,
        packageHash: null,
        archiveHash: null,
        source: '',
        license: 'TBD',
        distribution: 'referenced',
      })
      continue
    }
    locks.push({
      name: definition.name || parsed.name,
      provider: definition.provider || parsed.provider || undefined,
      version: parsed.version,
      required: true,
      contentHash: contentHashFor(definition),
      packageHash: await packageHashFor(summary || definition),
      archiveHash: null,
      source: definition.source || '',
      license: 'TBD',
      distribution: 'referenced',
    })
  }
  return { locks, missing }
}

export async function checkSkillLocks(skills, locks, service) {
  const checks = []
  const list = Array.isArray(skills) ? skills : []
  for (const lock of Array.isArray(locks) ? locks : []) {
    const candidate = findDefinition(list, lock.provider || '', lock.name)
    checks.push({
      id: `skill:${lock.provider ? `${lock.provider}/${lock.name}` : lock.name}`,
      status: candidate ? 'pass' : lock.required ? 'error' : 'warning',
      message: candidate ? 'ok' : `skill not found: ${lock.name}`,
    })
    if (!candidate) continue
    let definition = null
    try {
      definition = service && typeof service.get === 'function' ? await service.get(lock.name) : null
    } catch {
      definition = null
    }
    if (lock.contentHash && definition) {
      const actual = contentHashFor(definition)
      checks.push({
        id: `skill:${lock.name}:contentHash`,
        status: actual === lock.contentHash ? 'pass' : lock.required ? 'error' : 'warning',
        message: actual === lock.contentHash ? 'ok' : 'contentHash mismatch',
      })
    }
    if (lock.packageHash) {
      const actual = await packageHashFor(candidate)
      if (actual) {
        checks.push({
          id: `skill:${lock.name}:packageHash`,
          status: actual === lock.packageHash ? 'pass' : lock.required ? 'error' : 'warning',
          message: actual === lock.packageHash ? 'ok' : 'packageHash mismatch',
        })
      }
    }
  }
  return checks
}
