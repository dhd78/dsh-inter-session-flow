import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeFlowContent } from '../lib/flow-schema.js'
import { migrateLegacyGraph, flowToLegacyGraph } from '../lib/migrate.js'
import { deleteFlow, listFlows, readBinding, readFlow } from '../lib/flow-store.js'
import { preflightFlow } from '../lib/preflight.js'

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'inter-session-flow-m1-'))
}

function legacyGraph() {
  return {
    version: 2,
    viewport: { x: 1, y: 2, zoom: 1 },
    nodes: [{
      id: 'n1',
      sessionId: 'session-a',
      title: '写作',
      cwd: 'C:/work',
      prompt: '写',
      outputSpec: { mode: 'text', fields: ['x'], maxResults: 1 },
      defaultOutputPortId: 'out_1',
      inputPorts: [{ id: 'in_1', label: 'IN1', policy: 'each' }],
      outputPorts: [{ id: 'out_1', label: 'OUT1', policy: 'all' }],
      x: 10,
      y: 20,
    }],
    edges: [],
  }
}

test('migrates legacy graph without leaking session ids into line', async () => {
  const root = await tempRoot()
  const result = await migrateLegacyGraph(root, legacyGraph())
  assert.equal(result.migrated, true)
  const line = await readFlow(root, 'default', '1.0.0')
  const binding = await readBinding(root, 'default')
  assert.equal(line.nodes.length, 1)
  assert.equal(JSON.stringify(line).includes('sessionId'), false)
  assert.equal(binding.nodes.n1.sessionId, 'session-a')
  assert.equal(flowToLegacyGraph(line, binding).nodes[0].sessionId, 'session-a')
  assert.equal((await listFlows(root)).length, 1)
})

test('preflight blocks missing bindings and passes complete bindings', async () => {
  const root = await tempRoot()
  await migrateLegacyGraph(root, legacyGraph())
  const line = await readFlow(root, 'default', '1.0.0')
  const binding = await readBinding(root, 'default')
  const missing = preflightFlow(line, { nodes: {} })
  assert.equal(missing.ok, false)
  assert.ok(missing.checks.some((item) => item.id === 'binding-keys' && item.status === 'error'))
  const good = preflightFlow(line, binding)
  assert.equal(good.ok, true)
})

test('rejects unsupported node kinds in v2', () => {
  const result = normalizeFlowContent({
    schemaVersion: 3,
    nodes: [{
      nodeId: 'n1',
      kind: 'builtin',
      role: 'x',
      skillRefs: [],
      prompt: '',
      outputSpec: { mode: 'text', fields: [], maxResults: 1 },
      defaultOutputPortId: 'out_1',
      inputPorts: [{ id: 'in_1', policy: 'each' }],
      outputPorts: [{ id: 'out_1', policy: 'all' }],
      layout: { x: 0, y: 0 },
      sessionPolicy: 'existing',
    }],
    edges: [],
  })
  assert.match(result.error, /only supports session/)
})

test('targetField must belong to fields', () => {
  const result = normalizeFlowContent({
    schemaVersion: 3,
    nodes: [{
      nodeId: 'n1',
      kind: 'session',
      role: 'x',
      skillRefs: [],
      prompt: '',
      outputSpec: { mode: 'json', fields: ['task'], maxResults: 2, targetField: 'target' },
      defaultOutputPortId: 'out_1',
      inputPorts: [{ id: 'in_1', policy: 'each' }],
      outputPorts: [{ id: 'out_1', policy: 'all' }],
      layout: { x: 0, y: 0 },
      sessionPolicy: 'existing',
    }],
    edges: [],
  })
  assert.match(result.error, /targetField must be included/)
})

test('deletes a flow and its binding into trash', async () => {
  const root = await tempRoot()
  await migrateLegacyGraph(root, legacyGraph())
  const result = await deleteFlow(root, 'default')
  assert.equal(result.deleted, true)
  assert.equal(await readFlow(root, 'default', '1.0.0'), null)
  assert.equal(await readBinding(root, 'default'), null)
  assert.equal((await listFlows(root)).length, 0)
  const trash = await fs.readdir(path.join(root, 'trash'))
  assert.ok(trash.some((name) => name.startsWith('default-')))
})

