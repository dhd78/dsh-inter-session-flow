import fs from 'node:fs/promises'
import path from 'node:path'

const FLOW_ID = /^[a-z][a-z0-9-]{0,63}$/
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function safeFlowId(flowId) {
  return typeof flowId === 'string' && FLOW_ID.test(flowId)
}

function safeVersion(version) {
  return typeof version === 'string' && SEMVER.test(version)
}

function compareVersion(a, b) {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return a.localeCompare(b)
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8')
  return JSON.parse(raw)
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temp, file)
}

export function flowsRoot(root) {
  return path.join(root, 'flows')
}

export function bindingsRoot(root) {
  return path.join(root, 'bindings')
}

export function flowPath(root, flowId, version) {
  if (!safeFlowId(flowId) || !safeVersion(version)) return null
  return path.join(flowsRoot(root), flowId, `${version}.json`)
}

export function bindingPath(root, flowId) {
  if (!safeFlowId(flowId)) return null
  return path.join(bindingsRoot(root), `${flowId}.json`)
}

export async function listFlowVersions(root, flowId) {
  if (!safeFlowId(flowId)) return []
  try {
    const names = await fs.readdir(path.join(flowsRoot(root), flowId))
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter(safeVersion)
      .sort(compareVersion)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function listFlows(root) {
  let dirs = []
  try {
    dirs = await fs.readdir(flowsRoot(root), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const dir of dirs) {
    if (!dir.isDirectory() || !safeFlowId(dir.name)) continue
    const versions = await listFlowVersions(root, dir.name)
    if (!versions.length) continue
    const latest = versions[versions.length - 1]
    try {
      const line = await readJson(flowPath(root, dir.name, latest))
      rows.push({
        flowId: line.flowId,
        version: line.version,
        title: line.title,
        description: line.description || '',
        nodeCount: Array.isArray(line.nodes) ? line.nodes.length : 0,
        edgeCount: Array.isArray(line.edges) ? line.edges.length : 0,
        updatedAt: line.updatedAt || '',
        versions,
      })
    } catch {
      // A corrupt revision is skipped; the revision list still shows it.
    }
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function readFlow(root, flowId, version) {
  if (!safeFlowId(flowId)) return null
  let chosen = version
  if (!chosen) {
    const versions = await listFlowVersions(root, flowId)
    chosen = versions[versions.length - 1]
  }
  if (!safeVersion(chosen)) return null
  try {
    return await readJson(flowPath(root, flowId, chosen))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeFlow(root, line) {
  if (!safeFlowId(line?.flowId) || !safeVersion(line?.version)) {
    throw new Error('invalid flow id or version')
  }
  const file = flowPath(root, line.flowId, line.version)
  await writeJson(file, line)
  return file
}

export async function readBinding(root, flowId) {
  const file = bindingPath(root, flowId)
  if (!file) return null
  try {
    return await readJson(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeBinding(root, binding) {
  const file = bindingPath(root, binding?.flowId)
  if (!file) throw new Error('invalid binding flowId')
  await writeJson(file, binding)
  return file
}

export async function deleteFlow(root, flowId, version) {
  if (!safeFlowId(flowId)) return null
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const trash = path.join(root, 'trash')
  await fs.mkdir(trash, { recursive: true })

  if (version) {
    if (!safeVersion(version)) return null
    const source = flowPath(root, flowId, version)
    if (!source) return null
    const exists = await fs.stat(source).catch(() => null)
    if (!exists) return null
    const target = path.join(trash, `${flowId}-${version}-${stamp}.json`)
    await fs.rename(source, target)
    await fs.rmdir(path.join(flowsRoot(root), flowId)).catch(() => {})
    return { deleted: true, scope: 'version', flowId, version, path: target }
  }

  const dir = path.join(flowsRoot(root), flowId)
  const exists = await fs.stat(dir).catch(() => null)
  if (!exists) return null
  const target = path.join(trash, `${flowId}-${stamp}`)
  await fs.rename(dir, target)
  const binding = bindingPath(root, flowId)
  if (binding) {
    const bindingExists = await fs.stat(binding).catch(() => null)
    if (bindingExists) await fs.rename(binding, path.join(trash, `${flowId}-${stamp}.binding.json`))
  }
  return { deleted: true, scope: 'flow', flowId, path: target }
}

export async function readLegacyGraph(root) {
  try {
    return await readJson(path.join(root, 'graph.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function backupLegacyGraph(root) {
  const source = path.join(root, 'graph.json')
  try {
    const raw = await fs.readFile(source, 'utf8')
    const dir = path.join(root, 'backups')
    await fs.mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const target = path.join(dir, `graph-${stamp}.json`)
    await fs.writeFile(target, raw, 'utf8')
    return target
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function readMigrationMarker(root) {
  try {
    return await readJson(path.join(root, 'migrations', 'v2.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeMigrationMarker(root, value) {
  await writeJson(path.join(root, 'migrations', 'v2.json'), value)
}
