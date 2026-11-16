import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRunner } from './lib/runner.js'
import { normalizeBinding, normalizeFlow } from './lib/flow-schema.js'
import {
  DEFAULT_FLOW_ID,
  DEFAULT_FLOW_VERSION,
  legacyToBinding,
  legacyToFlow,
  flowToLegacyGraph,
  migrateLegacyGraph,
} from './lib/migrate.js'
import {
  deleteFlow,
  listFlows,
  readBinding,
  readLegacyGraph,
  readFlow,
  writeBinding,
  writeFlow,
} from './lib/flow-store.js'
import { preflightFlow } from './lib/preflight.js'
import { buildPackage, packageToFlow, preflightPackage } from './lib/package.js'
import { migrateFlowNames } from './lib/migrate-flow-names.js'
import { uniqueFlowIdentity } from './lib/flow-identity.js'
import { listSkills } from './lib/skill-catalog.js'
import { listRuns, readRun, readRunArtifact, readRunState, recoverInterrupted, saveRunArtifacts } from './lib/run-store.js'
import { checkSkillLocks, readSkillLocks, resolveSkillLocks, writeSkillLocks } from './lib/skill-locks.js'

export const name = 'inter-session-flow'
export const inject = ['webServer', 'sessionQuery', 'agents', 'sessionController']

const API_GRAPH = '/api/inter-session-flow/graph'
const API_SESSIONS = '/api/inter-session-flow/sessions'
const API_RUN = '/api/inter-session-flow/run'
const API_RUN_STOP = '/api/inter-session-flow/run/stop'
const API_RUN_RETRY = '/api/inter-session-flow/run/retry'
const API_RUN_RESUME = '/api/inter-session-flow/run/resume'
const API_RUN_RECONCILE = '/api/inter-session-flow/run/reconcile'
const API_RUN_ADOPT = '/api/inter-session-flow/run/adopt'
const API_RUN_ABANDON = '/api/inter-session-flow/run/abandon'
const API_RUNS = '/api/inter-session-flow/runs'
const API_RUNS_PREFIX = '/api/inter-session-flow/runs'
const API_FLOWS = '/api/inter-session-flow/flows'
const API_FLOWS_PREFIX = '/api/inter-session-flow/flows'
const API_IMPORT = '/api/inter-session-flow/import'
const API_IMPORT_PREVIEW = '/api/inter-session-flow/import/preview'
const API_SKILLS = '/api/inter-session-flow/skills'
const MAX_BODY = 1_000_000
const MAX_NODES = 200
const MAX_EDGES = 500

function dataRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'inter-session-flow')
}

function emptyGraph() {
  return {
    version: 2,
    updatedAt: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

async function ensureMigrated() {
  const root = dataRoot()
  const raw = await readLegacyGraph(root)
  let legacy = null
  if (raw) {
    const normalized = normalizeGraph(raw)
    if (!normalized.error) legacy = normalized.graph
  }
  await migrateFlowNames(root)
  return migrateLegacyGraph(root, legacy)
}

async function readGraph() {
  const root = dataRoot()
  try {
    await ensureMigrated()
    const line = await readFlow(root, DEFAULT_FLOW_ID, DEFAULT_FLOW_VERSION)
    if (line) {
      const binding = await readBinding(root, DEFAULT_FLOW_ID)
      return flowToLegacyGraph(line, binding)
    }
    const raw = await readLegacyGraph(root)
    if (raw) {
      const normalized = normalizeGraph(raw)
      if (!normalized.error) return normalized.graph
    }
  } catch {
    // fall through to an empty graph
  }
  return emptyGraph()
}

async function writeGraph(graph) {
  const root = dataRoot()
  const line = normalizeFlow(legacyToFlow(graph), {
    flowId: DEFAULT_FLOW_ID,
    version: DEFAULT_FLOW_VERSION,
  })
  if (line.error) throw new Error(line.error)
  const binding = legacyToBinding(graph)
  await writeFlow(root, line.flow)
  await writeBinding(root, binding)
  await fs.mkdir(root, { recursive: true })
  const target = path.join(root, 'graph.json')
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify({ ...graph, updatedAt: Date.now() }, null, 2), 'utf8')
  await fs.rename(temp, target)
}

function nowVersion() {
  return '1.0.0'
}

function newFlowId() {
  return `flow-${Date.now().toString(36)}`
}

function emptyBinding(line) {
  return {
    schemaVersion: 1,
    flowId: line.flowId,
    flowVersion: line.version,
    nodes: {},
    layoutOverrides: {},
    updatedAt: new Date().toISOString(),
  }
}

async function handleSkills(req, res, skills, sessionCatalog) {
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const url = new URL(req.url || '/', 'http://local')
  const sessionId = url.searchParams.get('sessionId') || ''
  try {
    const list = await listSkills({ skills, sessionCatalog, sessionId })
    json(res, 200, { ok: true, skills: list, sessionId })
  } catch (error) {
    json(res, 500, { ok: false, error: String(error?.message || error) })
  }
}

async function handleImportPreview(req, res, skillService) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  try {
    const body = JSON.parse(await readBody(req))
    const input = body?.package && typeof body.package === 'object' ? body.package : body
    const result = preflightPackage(input, { mode: 'import' })
    const installed = await listSkills({ skills: skillService })
    const skillStatus = await checkSkillLocks(installed, input?.manifest?.skillLocks || [], skillService)
    const nodes = Array.isArray(input?.flow?.nodes) ? input.flow.nodes.length : 0
    json(res, result.ok ? 200 : 409, {
      ok: result.ok,
      checks: result.checks,
      skillStatus,
      manifest: input?.manifest || {},
      summary: {
        flowId: input?.manifest?.flowId || '',
        flowVersion: input?.manifest?.flowVersion || '',
        title: input?.manifest?.title || '',
        nodeCount: nodes,
        skillCount: Array.isArray(input?.manifest?.skillLocks) ? input.manifest.skillLocks.length : 0,
      },
    })
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) })
  }
}

async function handleImport(req, res, skillService) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  try {
    const root = dataRoot()
    const body = JSON.parse(await readBody(req))
    const input = body?.package && typeof body.package === 'object' ? body.package : body
    const result = preflightPackage(input, { mode: 'import' })
    if (!result.ok) {
      json(res, 409, {
        ok: false,
        error: 'package-preflight-failed',
        checks: result.checks.filter((item) => item.status !== 'pass'),
      })
      return
    }
    const line = packageToFlow(input)
    const normalized = normalizeFlow(line, { flowId: line.flowId, version: line.version })
    if (normalized.error) {
      json(res, 400, { ok: false, error: normalized.error })
      return
    }
    const identity = await uniqueFlowIdentity(root, normalized.flow.flowId, normalized.flow.title)
    if (!identity.renamed) {
      const existing = await readFlow(root, normalized.flow.flowId, normalized.flow.version)
      if (existing) {
        json(res, 409, { ok: false, error: 'flow-version-already-exists' })
        return
      }
    }
    const imported = identity.renamed
      ? { ...normalized.flow, flowId: identity.flowId, title: identity.title, updatedAt: new Date().toISOString() }
      : normalized.flow
    await writeFlow(root, imported)
    await writeBinding(root, emptyBinding(imported))
    await writeSkillLocks(root, imported.flowId, imported.version, input?.manifest?.skillLocks || [])
    const installed = await listSkills({ skills: skillService })
    const skillStatus = await checkSkillLocks(installed, input?.manifest?.skillLocks || [], skillService)
    json(res, 200, {
      ok: true,
      flow: imported,
      renamed: identity.renamed,
      originalFlowId: normalized.flow.flowId,
      checks: result.checks,
      skillStatus,
    })
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) })
  }
}

async function listFlowRows(root) {
  const rows = await listFlows(root)
  const out = []
  for (const row of rows) {
    const binding = await readBinding(root, row.flowId)
    out.push({
      ...row,
      boundCount: binding?.nodes ? Object.keys(binding.nodes).length : 0,
      hasBinding: Boolean(binding),
    })
  }
  return out
}

function flowPathParts(pathname) {
  if (!pathname.startsWith(`${API_FLOWS_PREFIX}/`)) return null
  const rest = pathname.slice(API_FLOWS_PREFIX.length + 1).replace(/\/+$/, '')
  if (!rest) return null
  const parts = rest.split('/').map((part) => decodeURIComponent(part))
  return {
    flowId: parts[0],
    action: parts[1] || '',
    version: parts[2] || '',
  }
}

async function handleFlows(req, res) {
  const root = dataRoot()
  try {
    await ensureMigrated()
    if (req.method === 'GET') {
      json(res, 200, { ok: true, flows: await listFlowRows(root) })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = JSON.parse(await readBody(req))
    const input = body?.flow && typeof body.flow === 'object' ? body.flow : body
    const flowId = typeof input.flowId === 'string' ? input.flowId : newFlowId()
    const version = typeof input.version === 'string' ? input.version : nowVersion()
    const normalized = normalizeFlow(input, { flowId, version })
    if (normalized.error) {
      json(res, 400, { ok: false, error: normalized.error })
      return
    }
    await writeFlow(root, normalized.flow)
    const existing = await readBinding(root, flowId)
    if (!existing) await writeBinding(root, emptyBinding(normalized.flow))
    json(res, 200, { ok: true, flow: normalized.flow, binding: (await readBinding(root, flowId)) })
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) })
  }
}

async function handleFlowPath(req, res, pathname, skillService) {
  const root = dataRoot()
  const parts = flowPathParts(pathname)
  if (!parts || !parts.flowId) {
    json(res, 404, { ok: false, error: 'flow-not-found' })
    return
  }
  try {
    const line = await readFlow(root, parts.flowId, parts.version || undefined)
    if (!line) {
      json(res, 404, { ok: false, error: 'flow-not-found' })
      return
    }
    if (parts.action === 'binding') {
      if (!parts.version && line.version) {
        // Binding is per flow, not per revision.
      }
      if (req.method === 'GET') {
        json(res, 200, { ok: true, binding: await readBinding(root, parts.flowId) })
        return
      }
      if (req.method !== 'POST' && req.method !== 'PUT') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const body = JSON.parse(await readBody(req))
      const normalized = normalizeBinding({
        ...body,
        flowId: line.flowId,
        flowVersion: body?.flowVersion || line.version,
      }, { flowId: line.flowId, flowVersion: line.version })
      if (normalized.error) {
        json(res, 400, { ok: false, error: normalized.error })
        return
      }
      await writeBinding(root, normalized.binding)
      json(res, 200, { ok: true, binding: normalized.binding })
      return
    }
    if (parts.action === 'export') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const binding = await readBinding(root, parts.flowId)
      const local = await readSkillLocks(root, parts.flowId)
      let locks = local?.locks || []
      if (!locks.length) locks = (await resolveSkillLocks(skillService, line.nodes)).locks
      if (!local?.locks?.length && locks.length) {
        await writeSkillLocks(root, line.flowId, line.version, locks)
      }
      json(res, 200, { ok: true, package: buildPackage(line, binding, { skillLocks: locks }) })
      return
    }
    if (parts.action === 'preflight') {
      const binding = await readBinding(root, parts.flowId)
      const result = preflightFlow(line, binding)
      const local = await readSkillLocks(root, parts.flowId)
      const installed = await listSkills({ skills: skillService })
      const skillChecks = await checkSkillLocks(installed, local?.locks || [], skillService)
      result.checks.push(...skillChecks)
      result.checks.push(...skillChecks)
      result.ok = result.checks.every((item) => item.status !== 'error')
      json(res, result.ok ? 200 : 409, { ok: result.ok, ...result })
      return
    }
    if (parts.action) {
      json(res, 404, { ok: false, error: 'unknown-flow-action' })
      return
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse(await readBody(req))
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (!title || title.length > 120) {
        json(res, 400, { ok: false, error: 'invalid-title' })
        return
      }
      const normalized = normalizeFlow({ ...line, title }, {
        flowId: line.flowId,
        version: line.version,
      })
      if (normalized.error) {
        json(res, 400, { ok: false, error: normalized.error })
        return
      }
      await writeFlow(root, normalized.flow)
      json(res, 200, { ok: true, flow: normalized.flow })
      return
    }
    if (req.method === 'DELETE') {
      const result = await deleteFlow(root, parts.flowId, parts.version || undefined)
      if (!result) {
        json(res, 404, { ok: false, error: 'flow-not-found' })
        return
      }
      json(res, 200, { ok: true, deleted: result })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, {
        ok: true,
        flow: line,
        binding: await readBinding(root, parts.flowId),
      })
      return
    }
    if (req.method !== 'POST' && req.method !== 'PUT') {
      json(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = JSON.parse(await readBody(req))
    const input = body?.flow && typeof body.flow === 'object' ? body.flow : body
    const version = typeof input.version === 'string' ? input.version : line.version
    const normalized = normalizeFlow({ ...line, ...input, flowId: line.flowId, version })
    if (normalized.error) {
      json(res, 400, { ok: false, error: normalized.error })
      return
    }
    await writeFlow(root, normalized.flow)
    json(res, 200, { ok: true, flow: normalized.flow })
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) })
  }
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function nodeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizePorts(rawPorts, direction) {
  const fallbackId = direction === 'in' ? 'in_1' : 'out_1'
  const source = Array.isArray(rawPorts) && rawPorts.length ? rawPorts : [{ id: fallbackId }]
  if (source.length > 3) return { error: `too many ${direction === 'in' ? 'input' : 'output'} ports` }
  const ports = []
  const ids = new Set()
  for (let i = 0; i < source.length; i++) {
    const raw = source[i] || {}
    const id = nodeId(raw.id) ? raw.id : `${direction}_${i + 1}`
    if (ids.has(id)) return { error: `duplicate ${direction} port id: ${id}` }
    const label = typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.slice(0, 40)
      : `${direction === 'in' ? 'IN' : 'OUT'}${i + 1}`
    const policy = direction === 'in'
      ? (raw.policy === 'all' ? 'all' : 'each')
      : (raw.policy === 'roundRobin' || raw.policy === 'conditional' ? raw.policy : 'all')
    ids.add(id)
    ports.push({ id, label, policy })
  }
  return { ports }
}

function normalizeOutputSpec(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((field) => field === 'x' || field === 'y' || field === 'z')
    : ['x']
  if (!fields.includes('x')) fields.unshift('x')
  const uniqueFields = [...new Set(fields)].slice(0, 3)
  return {
    mode: source.mode === 'json' ? 'json' : 'text',
    fields: uniqueFields,
    maxResults: finite(source.maxResults)
      ? Math.min(10, Math.max(1, Math.floor(source.maxResults)))
      : 3,
  }
}

function edgeEndpoint(raw, side) {
  if (raw && typeof raw === 'object') {
    return {
      nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : '',
      portId: typeof raw.portId === 'string' ? raw.portId : '',
    }
  }
  return { nodeId: typeof raw === 'string' ? raw : '', portId: '' }
}

function normalizeGraph(input) {
  if (!input || typeof input !== 'object') return { error: 'graph must be an object' }
  const nodesInput = Array.isArray(input.nodes) ? input.nodes : null
  const edgesInput = Array.isArray(input.edges) ? input.edges : null
  if (!nodesInput || !edgesInput) return { error: 'nodes and edges must be arrays' }
  if (nodesInput.length > MAX_NODES) return { error: 'too many nodes' }
  if (edgesInput.length > MAX_EDGES) return { error: 'too many edges' }

  const nodes = []
  const nodeIds = new Set()
  const sessionIds = new Set()
  for (const raw of nodesInput) {
    if (!raw || typeof raw !== 'object') return { error: 'node must be an object' }
    const id = raw.id
    const sessionId = raw.sessionId
    if (!nodeId(id)) return { error: 'invalid node id' }
    if (!nodeId(sessionId)) return { error: 'node sessionId is required' }
    if (nodeIds.has(id)) return { error: `duplicate node id: ${id}` }
    if (sessionIds.has(sessionId)) return { error: `session already bound: ${sessionId}` }
    if (!finite(raw.x) || !finite(raw.y)) return { error: 'node position must be finite' }
    const inputPorts = normalizePorts(raw.inputPorts, 'in')
    if (inputPorts.error) return { error: `${id}: ${inputPorts.error}` }
    const outputPorts = normalizePorts(raw.outputPorts, 'out')
    if (outputPorts.error) return { error: `${id}: ${outputPorts.error}` }
    const defaultOutputPortId = typeof raw.defaultOutputPortId === 'string' &&
      outputPorts.ports.some((port) => port.id === raw.defaultOutputPortId)
      ? raw.defaultOutputPortId
      : outputPorts.ports[0].id
    nodeIds.add(id)
    sessionIds.add(sessionId)
    nodes.push({
      id,
      sessionId,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
      cwd: typeof raw.cwd === 'string' ? raw.cwd.slice(0, 2000) : '',
      prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 20000) : '',
      outputSpec: normalizeOutputSpec(raw.outputSpec),
      defaultOutputPortId,
      inputPorts: inputPorts.ports,
      outputPorts: outputPorts.ports,
      x: clamp(raw.x, -200000, 200000),
      y: clamp(raw.y, -200000, 200000),
    })
  }

  const edges = []
  const edgeIds = new Set()
  const pairs = new Set()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const raw of edgesInput) {
    if (!raw || typeof raw !== 'object') return { error: 'edge must be an object' }
    const id = raw.id
    const from = edgeEndpoint(raw.from, 'from')
    const to = edgeEndpoint(raw.to, 'to')
    if (!nodeId(id)) return { error: 'invalid edge id' }
    if (!nodeIds.has(from.nodeId) || !nodeIds.has(to.nodeId)) {
      return { error: 'edge endpoints must be existing nodes' }
    }
    if (from.nodeId === to.nodeId) return { error: 'self edge is not allowed' }
    if (edgeIds.has(id)) return { error: `duplicate edge id: ${id}` }
    const fromNode = byId.get(from.nodeId)
    const toNode = byId.get(to.nodeId)
    const fromPort = from.portId || fromNode.outputPorts[0]?.id
    const toPort = to.portId || toNode.inputPorts[0]?.id
    if (!fromNode.outputPorts.some((port) => port.id === fromPort)) {
      return { error: `unknown output port: ${from.nodeId}/${fromPort}` }
    }
    if (!toNode.inputPorts.some((port) => port.id === toPort)) {
      return { error: `unknown input port: ${to.nodeId}/${toPort}` }
    }
    const pair = `${from.nodeId}/${fromPort}->${to.nodeId}/${toPort}`
    if (pairs.has(pair)) return { error: `duplicate edge: ${pair}` }
    const mode = raw.mode === 'returnable' || raw.mode === 'twoway' ? 'returnable' : 'hard'
    edgeIds.add(id)
    pairs.add(pair)
    edges.push({
      id,
      from: { nodeId: from.nodeId, portId: fromPort },
      to: { nodeId: to.nodeId, portId: toPort },
      mode,
      order: finite(raw.order) ? raw.order : edges.length,
      instruction: typeof raw.instruction === 'string' ? raw.instruction.slice(0, 20000) : '',
    })
  }

  const cycle = findCycle(nodes, edges)
  if (cycle) return { error: `cycle is not allowed: ${cycle}` }

  const viewport = input.viewport && typeof input.viewport === 'object'
    ? input.viewport
    : { x: 0, y: 0, zoom: 1 }

  return {
    graph: {
      version: 2,
      updatedAt: Date.now(),
      viewport: {
        x: finite(viewport.x) ? viewport.x : 0,
        y: finite(viewport.y) ? viewport.y : 0,
        zoom: finite(viewport.zoom) ? clamp(viewport.zoom, 0.4, 2.5) : 1,
      },
      nodes,
      edges,
    },
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function findCycle(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    adjacency.get(edge.from.nodeId).push(edge.to.nodeId)
  }
  const state = new Map()
  const stack = []
  function visit(id) {
    const current = state.get(id) || 0
    if (current === 1) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id].join(' -> ')
    }
    if (current === 2) return null
    state.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) || []) {
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const node of nodes) {
    const found = visit(node.id)
    if (found) return found
  }
  return null
}

function listSessions(ctx) {
  const store = ctx.get('sessions')
  const list = typeof store?.list === 'function' ? store.list() : []
  const titleService = ctx.get('sessionTitle')
  const rows = []
  for (const session of list || []) {
    if (!session || typeof session.id !== 'string') continue
    let title = ''
    let cwd = ''
    let updatedAt = 0
    try {
      const snapshot = titleService?.get?.(session)
      if (snapshot && typeof snapshot.title === 'string') title = snapshot.title
    } catch {
      // optional title service; a missing title is not fatal
    }
    const header = session.header && typeof session.header === 'object' ? session.header : null
    if (header) {
      if (typeof header.cwd === 'string') cwd = header.cwd
      if (typeof header.createdAt === 'number') updatedAt = header.createdAt
    }
    rows.push({
      id: session.id,
      title,
      cwd,
      updatedAt,
    })
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

function sessionRows(value) {
  const list = Array.isArray(value?.sessions)
    ? value.sessions
    : Array.isArray(value?.items)
      ? value.items
      : Array.isArray(value)
        ? value
        : []
  return list.map((item) => {
    const id = typeof item?.id === 'string' ? item.id : ''
    const title = typeof item?.title === 'string'
      ? item.title
      : typeof item?.projections?.values?.title === 'string'
        ? item.projections.values.title
        : ''
    const cwd = typeof item?.cwd === 'string' ? item.cwd : ''
    return {
      id,
      title: title || (cwd ? path.basename(cwd) : ''),
      cwd,
      updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : 0,
    }
  }).filter((item) => item.id)
}

export function apply(ctx) {
  const runner = createRunner(ctx)
  const skillService = ctx.get('skills')
  const sessionCatalog = ctx.get('sessionSkillCatalog')
  ctx.effect(() => {
    const disposeGraph = ctx.webServer.register({
      kind: 'exact',
      path: API_GRAPH,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            json(res, 200, { ok: true, graph: await readGraph() })
            return
          }
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          const raw = await readBody(req)
          let input
          try {
            input = JSON.parse(raw)
          } catch {
            json(res, 400, { ok: false, error: 'invalid-json' })
            return
          }
          const normalized = normalizeGraph(input)
          if (normalized.error) {
            json(res, 400, { ok: false, error: normalized.error })
            return
          }
          await writeGraph(normalized.graph)
          json(res, 200, { ok: true, graph: normalized.graph })
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeSessions = ctx.webServer.register({
      kind: 'exact',
      path: API_SESSIONS,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          let records = null
          let lastError = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              records = await ctx.sessionQuery.listSessions(AbortSignal.timeout(5000))
              break
            } catch (error) {
              lastError = error
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
            }
          }
          if (!records) throw lastError || new Error('session-list-unavailable')
          let archived = new Set()
          try {
            const registry = ctx.get('workspaceRegistry')
            const archivedIds = registry?.archivedSessionIds
            const list = Array.isArray(archivedIds)
              ? archivedIds
              : archivedIds instanceof Set
                ? Array.from(archivedIds)
                : []
            archived = new Set(list.filter((id) => typeof id === 'string'))
          } catch {
            archived = new Set()
          }
          records = records.filter((record) => !archived.has(record.header.id))
          // Only top-level resident sessions belong in the flow. Child and
          // subagent sessions are internal execution details.
          records = records.filter((record) => (
            !record.header.parentSession &&
            record.header.origin !== 'subagent' &&
            !(typeof record.header.delegationDepth === 'number' && record.header.delegationDepth > 0)
          ))
          const signal = AbortSignal.timeout(5000)
          const ids = records.map((record) => record.header.id)
          let titleResults = []
          try {
            titleResults = ids.length
              ? await ctx.sessionQuery.readTitleSnapshots(ids, signal)
              : []
          } catch {
            titleResults = []
          }
          const titleById = new Map()
          for (const result of titleResults) {
            if (result.status !== 'fulfilled') continue
            const observation = result.value
            const snapshot = observation?.title
            const title = typeof snapshot === 'string'
              ? snapshot
              : typeof snapshot?.title === 'string'
                ? snapshot.title
                : ''
            if (title) titleById.set(result.sessionId, title)
          }
          const withDialogue = []
          for (const record of records) {
            const id = record.header.id
            if (titleById.has(id)) {
              withDialogue.push(record)
              continue
            }
            // Untitled sessions are usually empty setup shells. Keep one
            // only if its log contains an actual user/assistant turn.
            try {
              const events = await ctx.sessionQuery.listEvents(id)
              const hasMessage = events.some((event) => (
                event.type === 'user/message' || event.type === 'assistant/message'
              ))
              if (hasMessage) withDialogue.push(record)
            } catch {
              withDialogue.push(record)
            }
          }
          records = withDialogue
          const rows = records.map((record) => ({
            id: record.header.id,
            title: titleById.get(record.header.id) || '',
            cwd: typeof record.header.cwd === 'string' ? record.header.cwd : '',
            updatedAt: typeof record.header.createdAt === 'number' ? record.header.createdAt : 0,
            live: Boolean(record.live),
          }))
          json(res, 200, { ok: true, sessions: rows })
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeFlows = ctx.webServer.register({
      kind: 'exact',
      path: API_FLOWS,
      handler: handleFlows,
    })

    const disposeFlowPrefix = ctx.webServer.register({
      kind: 'prefix',
      path: API_FLOWS_PREFIX,
      handler: async (req, res) => {
        const pathname = new URL(req.url || '/', 'http://local').pathname
        await handleFlowPath(req, res, pathname, skillService)
      },
    })

    const disposeImport = ctx.webServer.register({
      kind: 'exact',
      path: API_IMPORT,
      handler: (req, res) => handleImport(req, res, skillService),
    })

    const disposeImportPreview = ctx.webServer.register({
      kind: 'exact',
      path: API_IMPORT_PREVIEW,
      handler: (req, res) => handleImportPreview(req, res, skillService),
    })

    const disposeSkills = ctx.webServer.register({
      kind: 'exact',
      path: API_SKILLS,
      handler: (req, res) => handleSkills(req, res, skillService, sessionCatalog),
    })

    const disposeRun = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            let run = runner.get()
            if (!run) run = await recoverInterrupted(dataRoot())
            json(res, 200, { ok: true, run })
            return
          }
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          const raw = await readBody(req)
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            json(res, 400, { ok: false, error: 'invalid-json' })
            return
          }
          if (typeof body?.input !== 'string' || !body.input.trim()) {
            json(res, 400, { ok: false, error: 'empty-input' })
            return
          }
          let graph
          if (body?.graph) {
            const normalized = normalizeGraph(body.graph)
            if (normalized.error) {
              json(res, 400, { ok: false, error: normalized.error })
              return
            }
            graph = normalized.graph
          } else {
            graph = await readGraph()
          }
          const run = await runner.start(graph, {
            input: typeof body?.input === 'string' ? body.input : '',
            startNodeId: typeof body?.startNodeId === 'string' ? body.startNodeId : '',
            timeoutMs: body?.timeoutMs,
            flowId: typeof body?.flowId === 'string' ? body.flowId : '',
            flowVersion: typeof body?.flowVersion === 'string' ? body.flowVersion : '',
            binding: body?.flowId ? await readBinding(dataRoot(), body.flowId) : null,
          })
          json(res, 200, { ok: true, run })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRunStop = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN_STOP,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        json(res, 200, { ok: true, run: runner.stop() })
      },
    })

    const disposeRunRetry = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN_RETRY,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = JSON.parse(await readBody(req))
          const run = await runner.retry(body?.jobId)
          json(res, 200, { ok: true, run })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRunResume = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN_RESUME,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = JSON.parse(await readBody(req))
          const root = dataRoot()
          const runId = String(body?.runId || '')
          const previous = await readRun(root, runId)
          if (previous?.resumeConsumed || previous?.resumedBy) {
            json(res, 409, { ok: false, error: 'already-resumed' })
            return
          }
          if (previous?.status === 'done') {
            json(res, 400, { ok: false, error: 'run-not-resumable' })
            return
          }
          const state = await readRunState(root, runId)
          const graph = await readRunArtifact(root, runId, 'flow.json')
          const binding = await readRunArtifact(root, runId, 'binding.json')
          if (!previous || !graph || !state) {
            json(res, 400, { ok: false, error: 'nothing-to-resume' })
            return
          }
          const ready = Array.isArray(state.ready) ? [...state.ready] : []
          if (!ready.length) {
            for (const nodeRun of Object.values(previous.nodes || {})) {
              if (nodeRun.status !== 'running') continue
              let sent = null
              try {
                const events = await ctx.sessionQuery.listEvents(nodeRun.sessionId)
                sent = events.find((event) => event.type === 'user/message' &&
                  event.data?.source?.busMessageId === nodeRun.messageId)
              } catch {
                sent = null
              }
              if (!sent) {
                ready.push({
                  nodeId: nodeRun.nodeId,
                  portId: nodeRun.inputPortId || '',
                  prompt: nodeRun.basePrompt || nodeRun.input || '',
                  hop: nodeRun.hop || 0,
                  inputs: nodeRun.inputs || 1,
                })
              }
            }
          }
          if (!ready.length) {
            json(res, 400, { ok: false, error: 'nothing-to-resume' })
            return
          }
          const run = await runner.start(graph, {
            input: previous.input || '',
            startNodeId: previous.startNodeId || '',
            timeoutMs: previous.timeoutMs,
            flowId: previous.flowId || '',
            flowVersion: previous.flowVersion || '',
            binding,
            resumeState: { ...state, ready },
            resumedFrom: runId,
          })
          previous.resumeConsumed = true
          previous.resumedBy = run.id
          previous.events = Array.isArray(previous.events) ? previous.events : []
          previous.events.push({ at: Date.now(), type: 'run-resumed', resumedBy: run.id })
          await saveRunArtifacts(root, { run: previous, graph, binding })
          json(res, 200, { ok: true, run })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRunReconcile = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN_RECONCILE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = JSON.parse(await readBody(req))
          const root = dataRoot()
          const runId = String(body?.runId || '')
          const previous = await readRun(root, runId)
          if (!previous) {
            json(res, 404, { ok: false, error: 'run-not-found' })
            return
          }
          const rows = []
          for (const nodeRun of Object.values(previous.nodes || {})) {
            if (nodeRun.status !== 'running' || !nodeRun.sessionId) continue
            const events = await ctx.sessionQuery.listEvents(nodeRun.sessionId)
            const sent = events.find((event) => event.type === 'user/message' &&
              event.data?.source?.busMessageId === nodeRun.messageId)
            const assistant = sent
              ? events.find((event) => event.type === 'assistant/message' && event.seq > sent.seq)
              : null
            const output = assistant
              ? (assistant.data?.message?.content || [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n')
              : ''
            rows.push({
              jobId: nodeRun.jobId,
              nodeId: nodeRun.nodeId,
              messageId: nodeRun.messageId || '',
              state: !sent ? 'not-sent' : assistant ? 'output-found' : 'sent-no-output',
              sentSeq: sent?.seq || null,
              outputSeq: assistant?.seq || null,
              output: output.slice(0, 4000),
            })
          }
          json(res, 200, { ok: true, runId, active: rows })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRunAdopt = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN_ADOPT,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = JSON.parse(await readBody(req))
          const run = await runner.adopt(String(body?.jobId || ''), String(body?.runId || ''))
          json(res, 200, { ok: true, run })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRunAbandon = ctx.webServer.register({
      kind: 'exact',
      path: API_RUN_ABANDON,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          const body = JSON.parse(await readBody(req))
          const run = await runner.abandon(String(body?.jobId || ''), String(body?.runId || ''))
          json(res, 200, { ok: true, run })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRuns = ctx.webServer.register({
      kind: 'exact',
      path: API_RUNS,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        try {
          json(res, 200, { ok: true, runs: await listRuns(dataRoot()) })
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    const disposeRunsPrefix = ctx.webServer.register({
      kind: 'prefix',
      path: API_RUNS_PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const pathname = new URL(req.url || '/', 'http://local').pathname
        const id = decodeURIComponent(pathname.slice(API_RUNS_PREFIX.length + 1))
        if (!id) {
          json(res, 404, { ok: false, error: 'run-not-found' })
          return
        }
        try {
          const run = await readRun(dataRoot(), id)
          if (!run) {
            json(res, 404, { ok: false, error: 'run-not-found' })
            return
          }
          json(res, 200, { ok: true, run })
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    })

    return () => {
      disposeGraph()
      disposeSessions()
      disposeFlows()
      disposeFlowPrefix()
      disposeImport()
      disposeImportPreview()
      disposeSkills()
      disposeRuns()
      disposeRunsPrefix()
      disposeRun()
      disposeRunStop()
      disposeRunRetry()
      disposeRunResume()
      disposeRunReconcile()
      disposeRunAdopt()
      disposeRunAbandon()
    }
  }, 'inter-session-flow: routes')
}

