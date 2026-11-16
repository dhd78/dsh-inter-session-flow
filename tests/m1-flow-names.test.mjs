import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { migrateFlowNames } from '../lib/migrate-flow-names.js'
import { readFlow, readBinding } from '../lib/flow-store.js'
test('migrates m1 lines/ and lineId fields to flows/ and flowId', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-flow-names-'))
  const lineDir = path.join(root, 'lines', 'legacy')
  await fs.mkdir(lineDir, { recursive: true })
  await fs.writeFile(path.join(lineDir, '1.0.0.json'), JSON.stringify({
    schemaVersion: 2,
    lineId: 'legacy',
    version: '1.0.0',
    title: 'Legacy',
    description: '',
    nodes: [],
    edges: [],
    createdAt: 'x',
    updatedAt: 'x',
  }), 'utf8')
  await fs.mkdir(path.join(root, 'bindings'), { recursive: true })
  await fs.writeFile(path.join(root, 'bindings', 'legacy.json'), JSON.stringify({
    schemaVersion: 1,
    lineId: 'legacy',
    lineVersion: '1.0.0',
    nodes: {},
    updatedAt: 'x',
  }), 'utf8')
  const result = await migrateFlowNames(root)
  assert.equal(result.migrated, true)
  const flow = await readFlow(root, 'legacy', '1.0.0')
  const binding = await readBinding(root, 'legacy')
  assert.equal(flow.schemaVersion, 3)
  assert.equal(flow.flowId, 'legacy')
  assert.equal(binding.flowId, 'legacy')
  assert.equal(binding.flowVersion, '1.0.0')
})
