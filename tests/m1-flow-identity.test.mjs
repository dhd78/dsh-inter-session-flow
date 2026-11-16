import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { uniqueFlowIdentity } from '../lib/flow-identity.js'
import { writeFlow } from '../lib/flow-store.js'

function flow(flowId, title) {
  return {
    schemaVersion: 3,
    flowId,
    version: '1.0.0',
    title,
    description: '',
    nodes: [],
    edges: [],
    createdAt: 'x',
    updatedAt: 'x',
  }
}

test('import identity keeps a free id/title', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-identity-'))
  const result = await uniqueFlowIdentity(root, 'demo', 'Demo')
  assert.deepEqual(result, { flowId: 'demo', title: 'Demo', renamed: false, idRenamed: false })
})

test('duplicate id gets -2 and title gets (2)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-identity-'))
  await writeFlow(root, flow('demo', 'Demo'))
  const result = await uniqueFlowIdentity(root, 'demo', 'Demo')
  assert.equal(result.flowId, 'demo-2')
  assert.equal(result.title, 'Demo (2)')
  assert.equal(result.renamed, true)
})

test('duplicate title with free id gets numeric title suffix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-identity-'))
  await writeFlow(root, flow('other', 'Demo'))
  const result = await uniqueFlowIdentity(root, 'demo', 'Demo')
  assert.equal(result.flowId, 'demo')
  assert.equal(result.title, 'Demo (2)')
  assert.equal(result.idRenamed, false)
})
