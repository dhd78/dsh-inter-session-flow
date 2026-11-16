const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const PORT_ID = /^[a-z][a-z0-9_]{0,31}$/
const FLOW_ID = /^[a-z][a-z0-9-]{0,63}$/
const SKILL_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?(?:@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?$/
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const MAX_NODES = 200
const MAX_EDGES = 500
const MAX_PORTS = 3

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function flowError(message, path) {
  return path ? `${path}: ${message}` : message
}

function normalizePorts(raw, direction) {
  const fallback = direction === 'in' ? 'in_1' : 'out_1'
  const source = Array.isArray(raw) && raw.length ? raw : [{ id: fallback }]
  if (source.length > MAX_PORTS) return { error: `too many ${direction} ports` }
  const ports = []
  const ids = new Set()
  for (let i = 0; i < source.length; i++) {
    const item = source[i] && typeof source[i] === 'object' ? source[i] : {}
    const id = typeof item.id === 'string' && PORT_ID.test(item.id)
      ? item.id
      : `${direction}_${i + 1}`
    if (ids.has(id)) return { error: `duplicate ${direction} port: ${id}` }
    const label = text(item.label, 32) || `${direction === 'in' ? 'IN' : 'OUT'}${i + 1}`
    const policy = direction === 'in'
      ? (item.policy === 'all' ? 'all' : 'each')
      : (item.policy === 'roundRobin' ? 'roundRobin' : 'all')
    ids.add(id)
    ports.push({ id, label, policy })
  }
  return { ports }
}

function normalizeOutputSpec(raw, path) {
  const source = raw && typeof raw === 'object' ? raw : {}
  if (source.mode !== 'text' && source.mode !== 'json') {
    return { error: flowError('mode must be text or json', `${path}.mode`) }
  }
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((field) => typeof field === 'string' && FIELD.test(field))
    : []
  const uniqueFields = [...new Set(fields)].slice(0, 3)
  if (source.mode === 'json' && uniqueFields.length === 0) {
    return { error: flowError('json output requires at least one field', `${path}.fields`) }
  }
  const targetField = typeof source.targetField === 'string' && source.targetField.trim()
    ? source.targetField.trim()
    : null
  if (targetField && !FIELD.test(targetField)) {
    return { error: flowError('invalid targetField', `${path}.targetField`) }
  }
  if (targetField && !uniqueFields.includes(targetField)) {
    return { error: flowError('targetField must be included in fields', `${path}.targetField`) }
  }
  const maxResults = finite(source.maxResults)
    ? Math.min(10, Math.max(1, Math.floor(source.maxResults)))
    : 3
  return {
    spec: {
      mode: source.mode,
      fields: uniqueFields,
      maxResults,
      ...(targetField ? { targetField } : {}),
    },
  }
}

function normalizeNode(raw, index) {
  if (!raw || typeof raw !== 'object') return { error: `node[${index}] must be an object` }
  for (const forbidden of ['sessionId', 'cwd', 'title']) {
    if (forbidden in raw) return { error: `node[${index}] must not contain ${forbidden}` }
  }
  const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : ''
  if (!NODE_ID.test(nodeId)) return { error: `node[${index}] has invalid nodeId` }
  if (raw.kind !== 'session') {
    return { error: `node ${nodeId}: unsupported kind ${raw.kind || '(missing)'} (v2.0 only supports session)` }
  }
  const role = text(raw.role, 100)
  if (!role) return { error: `node ${nodeId}: role is required` }
  const prompt = text(raw.prompt, 20000)
  const skillRefs = Array.isArray(raw.skillRefs)
    ? [...new Set(raw.skillRefs.filter((ref) => typeof ref === 'string' && SKILL_REF.test(ref)))]
    : []
  if (Array.isArray(raw.skillRefs) && skillRefs.length !== raw.skillRefs.length) {
    return { error: `node ${nodeId}: invalid skillRefs` }
  }
  const outputSpec = normalizeOutputSpec(raw.outputSpec, `node ${nodeId}.outputSpec`)
  if (outputSpec.error) return { error: outputSpec.error }
  const inputPorts = normalizePorts(raw.inputPorts, 'in')
  if (inputPorts.error) return { error: `node ${nodeId}: ${inputPorts.error}` }
  const outputPorts = normalizePorts(raw.outputPorts, 'out')
  if (outputPorts.error) return { error: `node ${nodeId}: ${outputPorts.error}` }
  const defaultOutputPortId = typeof raw.defaultOutputPortId === 'string' &&
    outputPorts.ports.some((port) => port.id === raw.defaultOutputPortId)
    ? raw.defaultOutputPortId
    : outputPorts.ports[0].id
  const layout = raw.layout && typeof raw.layout === 'object' ? raw.layout : {}
  if (!finite(layout.x) || !finite(layout.y)) {
    return { error: `node ${nodeId}: layout x/y must be finite` }
  }
  const outputSchema = raw.outputSchema && typeof raw.outputSchema === 'object'
    ? raw.outputSchema
    : {}
  return {
    node: {
      nodeId,
      kind: 'session',
      role,
      skillRefs,
      prompt,
      outputSpec: outputSpec.spec,
      outputSchema,
      defaultOutputPortId,
      inputPorts: inputPorts.ports,
      outputPorts: outputPorts.ports,
      layout: { x: layout.x, y: layout.y },
      sessionPolicy: 'existing',
    },
  }
}

function endpoint(raw, side) {
  if (!raw || typeof raw !== 'object') return { nodeId: '', portId: '' }
  return {
    nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : '',
    portId: typeof raw.portId === 'string' ? raw.portId : '',
  }
}

function findCycle(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.nodeId, []]))
  for (const edge of edges) adjacency.get(edge.from.nodeId).push(edge.to.nodeId)
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
    const found = visit(node.nodeId)
    if (found) return found
  }
  return null
}

export function normalizeFlowContent(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'line must be an object' }
  if (raw.schemaVersion !== 3) return { error: `unsupported flow schemaVersion: ${raw.schemaVersion}` }
  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : null
  const edgesRaw = Array.isArray(raw.edges) ? raw.edges : null
  if (!nodesRaw || !edgesRaw) return { error: 'nodes and edges must be arrays' }
  if (nodesRaw.length > MAX_NODES) return { error: 'too many nodes' }
  if (edgesRaw.length > MAX_EDGES) return { error: 'too many edges' }

  const nodes = []
  const nodeIds = new Set()
  for (let i = 0; i < nodesRaw.length; i++) {
    const result = normalizeNode(nodesRaw[i], i)
    if (result.error) return { error: result.error }
    if (nodeIds.has(result.node.nodeId)) {
      return { error: `duplicate nodeId: ${result.node.nodeId}` }
    }
    nodeIds.add(result.node.nodeId)
    nodes.push(result.node)
  }
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))

  const edges = []
  const edgeIds = new Set()
  const pairs = new Set()
  for (let i = 0; i < edgesRaw.length; i++) {
    const rawEdge = edgesRaw[i]
    if (!rawEdge || typeof rawEdge !== 'object') return { error: `edge[${i}] must be an object` }
    const id = typeof rawEdge.id === 'string' ? rawEdge.id : ''
    if (!NODE_ID.test(id)) return { error: `edge[${i}] has invalid id` }
    if (edgeIds.has(id)) return { error: `duplicate edge id: ${id}` }
    const from = endpoint(rawEdge.from)
    const to = endpoint(rawEdge.to)
    const sourceNode = byId.get(from.nodeId)
    const targetNode = byId.get(to.nodeId)
    if (!sourceNode || !targetNode) return { error: `edge ${id}: unknown endpoint` }
    if (from.nodeId === to.nodeId) return { error: `edge ${id}: self edge is not allowed` }
    if (!sourceNode.outputPorts.some((port) => port.id === from.portId)) {
      return { error: `edge ${id}: unknown output port ${from.portId}` }
    }
    if (!targetNode.inputPorts.some((port) => port.id === to.portId)) {
      return { error: `edge ${id}: unknown input port ${to.portId}` }
    }
    const pair = `${from.nodeId}/${from.portId}->${to.nodeId}/${to.portId}`
    if (pairs.has(pair)) return { error: `edge ${id}: duplicate edge ${pair}` }
    const mode = rawEdge.mode === 'returnable' ? 'returnable' : 'hard'
    const order = Number.isInteger(rawEdge.order) && rawEdge.order >= 0 ? rawEdge.order : i
    edges.push({
      id,
      from: { nodeId: from.nodeId, portId: from.portId },
      to: { nodeId: to.nodeId, portId: to.portId },
      mode,
      order,
      instruction: text(rawEdge.instruction, 10000),
      ...(rawEdge.mapping && typeof rawEdge.mapping === 'object'
        ? { mapping: rawEdge.mapping }
        : {}),
    })
    edgeIds.add(id)
    pairs.add(pair)
  }

  const cycle = findCycle(nodes, edges)
  if (cycle) return { error: `cycle is not allowed: ${cycle}` }

  return {
    flow: {
      schemaVersion: 3,
      nodes,
      edges,
      inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? raw.inputSchema : {},
      outputSchema: raw.outputSchema && typeof raw.outputSchema === 'object' ? raw.outputSchema : {},
      requirements: raw.requirements && typeof raw.requirements === 'object'
        ? raw.requirements
        : {},
    },
  }
}

export function normalizeFlow(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'line must be an object' }
  const flowId = typeof raw.flowId === 'string' ? raw.flowId : options.flowId
  const version = typeof raw.version === 'string' ? raw.version : options.version
  if (!FLOW_ID.test(flowId || '')) return { error: 'invalid flowId' }
  if (!SEMVER.test(version || '')) return { error: 'invalid line version' }
  const title = text(raw.title, 120)
  if (!title) return { error: 'line title is required' }
  const content = normalizeFlowContent({
    schemaVersion: 3,
    nodes: raw.nodes,
    edges: raw.edges,
    inputSchema: raw.inputSchema,
    outputSchema: raw.outputSchema,
    requirements: raw.requirements,
  })
  if (content.error) return { error: content.error }
  const now = new Date().toISOString()
  return {
    flow: {
      schemaVersion: 3,
      flowId,
      version,
      title,
      description: text(raw.description, 2000),
      ...content.flow,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: now,
    },
  }
}

export function normalizeBinding(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'binding must be an object' }
  const flowId = typeof raw.flowId === 'string' ? raw.flowId : options.flowId
  const flowVersion = typeof raw.flowVersion === 'string' ? raw.flowVersion : options.flowVersion
  if (!FLOW_ID.test(flowId || '')) return { error: 'invalid binding flowId' }
  if (!SEMVER.test(flowVersion || '')) return { error: 'invalid binding flowVersion' }
  const nodesRaw = raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {}
  const nodes = {}
  for (const [nodeId, value] of Object.entries(nodesRaw)) {
    if (!NODE_ID.test(nodeId)) return { error: `invalid binding nodeId: ${nodeId}` }
    if (!value || typeof value !== 'object') return { error: `binding ${nodeId} must be an object` }
    if (typeof value.sessionId !== 'string' || !value.sessionId) {
      return { error: `binding ${nodeId}: sessionId is required` }
    }
    nodes[nodeId] = {
      sessionId: value.sessionId.slice(0, 200),
      sessionTitle: text(value.sessionTitle, 200),
      cwd: text(value.cwd, 2000),
      boundAt: typeof value.boundAt === 'string' ? value.boundAt : new Date().toISOString(),
    }
  }
  return {
    binding: {
      schemaVersion: 1,
      flowId,
      flowVersion,
      nodes,
      layoutOverrides: raw.layoutOverrides && typeof raw.layoutOverrides === 'object'
        ? raw.layoutOverrides
        : {},
      updatedAt: new Date().toISOString(),
    },
  }
}

export const patterns = { NODE_ID, PORT_ID, FLOW_ID, SKILL_REF, SEMVER, FIELD }
export const limits = { MAX_NODES, MAX_EDGES, MAX_PORTS }
