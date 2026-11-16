import fs from 'node:fs/promises'
import path from 'node:path'
import { bindingsRoot, flowPath, flowsRoot } from './flow-store.js'

function renameKeys(value) {
  if (Array.isArray(value)) return value.map(renameKeys)
  if (!value || typeof value !== 'object') return value
  const out = {}
  const mapping = {
    lineId: 'flowId',
    lineVersion: 'flowVersion',
    lineHash: 'flowHash',
    lineContent: 'flowContent',
    lineSchemaVersion: 'flowSchemaVersion',
  }
  for (const [key, child] of Object.entries(value)) {
    out[mapping[key] || key] = renameKeys(child)
  }
  return out
}

async function listJsonFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) files.push(...await listJsonFiles(full))
      else if (entry.name.endsWith('.json')) files.push(full)
    }
    return files
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temp, file)
}

export async function migrateFlowNames(root) {
  const markerFile = path.join(root, 'migrations', 'flow-names-3.json')
  try {
    return { migrated: false, marker: await readJson(markerFile) }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const oldLines = path.join(root, 'lines')
  const lineFiles = await listJsonFiles(oldLines)
  const oldBindings = path.join(root, 'bindings')
  const bindingFiles = await listJsonFiles(oldBindings)
  if (!lineFiles.length && !bindingFiles.length) {
    const marker = { migratedAt: new Date().toISOString(), empty: true }
    await writeJson(markerFile, marker)
    return { migrated: false, marker }
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backup = path.join(root, 'backups', `m1-lines-${stamp}`)
  await fs.mkdir(backup, { recursive: true })
  if (await fs.stat(oldLines).catch(() => null)) {
    await fs.cp(oldLines, path.join(backup, 'lines'), { recursive: true })
  }
  if (await fs.stat(oldBindings).catch(() => null)) {
    await fs.cp(oldBindings, path.join(backup, 'bindings'), { recursive: true })
  }

  for (const file of lineFiles) {
    const raw = renameKeys(await readJson(file))
    raw.schemaVersion = 3
    const flowId = raw.flowId
    const version = raw.version
    if (!flowId || !version) continue
    const target = flowPath(root, flowId, version)
    if (!target) continue
    const existing = await fs.stat(target).catch(() => null)
    if (!existing) await writeJson(target, raw)
  }
  for (const file of bindingFiles) {
    const raw = renameKeys(await readJson(file))
    const flowId = raw.flowId
    if (!flowId) continue
    const target = path.join(bindingsRoot(root), `${flowId}.json`)
    await writeJson(target, raw)
  }

  const marker = {
    migratedAt: new Date().toISOString(),
    from: 'lines',
    to: 'flows',
    schemaVersion: 3,
    backup,
    lineFiles: lineFiles.length,
    bindingFiles: bindingFiles.length,
  }
  await writeJson(markerFile, marker)
  return { migrated: true, marker }
}
