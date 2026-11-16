import { normalizeBinding, normalizeFlow, normalizeFlowContent } from './flow-schema.js'
import {
  backupLegacyGraph,
  readMigrationMarker,
  readFlow,
  writeBinding,
  writeFlow,
  writeMigrationMarker,
} from './flow-store.js'

export const DEFAULT_FLOW_ID = 'default'
export const DEFAULT_FLOW_VERSION = '1.0.0'

export function legacyToFlow(graph) {
  const nodes = (graph.nodes || []).map((node) => ({
    nodeId: node.id,
    kind: 'session',
    role: node.title || `工位 ${node.id}`,
    skillRefs: [],
    prompt: node.prompt || '',
    outputSpec: node.outputSpec,
    outputSchema: {},
    defaultOutputPortId: node.defaultOutputPortId,
    inputPorts: node.inputPorts,
    outputPorts: node.outputPorts,
    layout: { x: node.x, y: node.y },
    sessionPolicy: 'existing',
  }))
  const content = normalizeFlowContent({
    schemaVersion: 3,
    nodes,
    edges: graph.edges || [],
    inputSchema: {},
    outputSchema: {},
    requirements: {},
  })
  if (content.error) throw new Error(`legacy-flow-migration: ${content.error}`)
  const now = new Date().toISOString()
  return {
    schemaVersion: 3,
    flowId: DEFAULT_FLOW_ID,
    version: DEFAULT_FLOW_VERSION,
    title: '默认流程图',
    description: '从 1.0.x graph.json 迁移',
    ...content.flow,
    createdAt: now,
    updatedAt: now,
  }
}

export function legacyToBinding(graph) {
  const nodes = {}
  for (const node of graph.nodes || []) {
    nodes[node.id] = {
      sessionId: node.sessionId,
      sessionTitle: node.title || '',
      cwd: node.cwd || '',
      boundAt: new Date().toISOString(),
    }
  }
  const normalized = normalizeBinding({
    schemaVersion: 1,
    flowId: DEFAULT_FLOW_ID,
    flowVersion: DEFAULT_FLOW_VERSION,
    nodes,
    layoutOverrides: graph.viewport ? { viewport: graph.viewport } : {},
  })
  if (normalized.error) throw new Error(`legacy-binding-migration: ${normalized.error}`)
  return normalized.binding
}

export async function migrateLegacyGraph(root, legacyGraph) {
  const marker = await readMigrationMarker(root)
  if (marker) return { migrated: false, reason: 'already-migrated', marker }
  const existing = await readFlow(root, DEFAULT_FLOW_ID, DEFAULT_FLOW_VERSION)
  if (existing) {
    const value = {
      migratedAt: new Date().toISOString(),
      fromVersion: legacyGraph?.version || 2,
      toFlowId: DEFAULT_FLOW_ID,
      toFlowVersion: DEFAULT_FLOW_VERSION,
      skipped: 'line-already-exists',
    }
    await writeMigrationMarker(root, value)
    return { migrated: false, reason: 'line-already-exists', flow: existing }
  }
  if (!legacyGraph) {
    const value = {
      migratedAt: new Date().toISOString(),
      fromVersion: null,
      toFlowId: DEFAULT_FLOW_ID,
      toFlowVersion: DEFAULT_FLOW_VERSION,
      empty: true,
    }
    await writeMigrationMarker(root, value)
    return { migrated: false, reason: 'empty', marker: value }
  }

  const backup = await backupLegacyGraph(root)
  const line = legacyToFlow(legacyGraph)
  const normalizedFlow = normalizeFlow(line, {
    flowId: DEFAULT_FLOW_ID,
    version: DEFAULT_FLOW_VERSION,
  })
  if (normalizedFlow.error) throw new Error(normalizedFlow.error)
  const binding = legacyToBinding(legacyGraph)
  await writeFlow(root, normalizedFlow.flow)
  await writeBinding(root, binding)
  const value = {
    migratedAt: new Date().toISOString(),
    fromVersion: legacyGraph.version || 2,
    toFlowId: DEFAULT_FLOW_ID,
    toFlowVersion: DEFAULT_FLOW_VERSION,
    backup,
    nodeCount: normalizedFlow.flow.nodes.length,
    edgeCount: normalizedFlow.flow.edges.length,
  }
  await writeMigrationMarker(root, value)
  return { migrated: true, flow: normalizedFlow.flow, binding, backup, marker: value }
}

export function flowToLegacyGraph(line, binding) {
  const bindings = binding?.nodes || {}
  return {
    version: 2,
    updatedAt: Date.parse(line.updatedAt) || Date.now(),
    viewport: binding?.layoutOverrides?.viewport || { x: 0, y: 0, zoom: 1 },
    nodes: line.nodes.map((node) => {
      const bound = bindings[node.nodeId] || {}
      return {
        id: node.nodeId,
        sessionId: bound.sessionId || '',
        title: bound.sessionTitle || node.role || '',
        cwd: bound.cwd || '',
        prompt: node.prompt,
        outputSpec: node.outputSpec,
        defaultOutputPortId: node.defaultOutputPortId,
        inputPorts: node.inputPorts,
        outputPorts: node.outputPorts,
        x: node.layout.x,
        y: node.layout.y,
      }
    }),
    edges: line.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      mode: edge.mode,
      order: edge.order,
      instruction: edge.instruction,
    })),
  }
}
