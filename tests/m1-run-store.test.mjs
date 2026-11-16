import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listRuns, readRun, readRunState, recoverInterrupted, saveRunArtifacts } from '../lib/run-store.js'

test('run artifacts include events, flow and binding snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-run-store-'))
  const run = {
    id: 'run_test_1',
    status: 'stopped',
    startedAt: 1,
    endedAt: 2,
    flowId: 'demo',
    flowVersion: '1.0.0',
    nodes: { n1: { nodeId: 'n1', status: 'done' } },
    events: [{ at: 1, type: 'run-start' }, { at: 2, type: 'run-complete' }],
  }
  const dir = await saveRunArtifacts(root, {
    run,
    graph: { nodes: [{ id: 'n1' }], edges: [] },
    binding: { nodes: { n1: { sessionId: 's1' } } },
    state: { stateVersion: 1, ready: [{ nodeId: 'n1' }], active: [], joins: [], cursors: {} },
  })
  assert.ok(dir)
  assert.equal(await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8'), `${JSON.stringify(run.events[0])}\n${JSON.stringify(run.events[1])}\n`)
  assert.ok((await fs.readFile(path.join(dir, 'flow.json'), 'utf8')).includes('n1'))
  assert.ok((await fs.readFile(path.join(dir, 'binding.json'), 'utf8')).includes('s1'))
  assert.equal((await readRunState(root, 'run_test_1')).ready[0].nodeId, 'n1')
  const rows = await listRuns(root)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].eventCount, 2)
  assert.equal((await readRun(root, 'run_test_1')).id, 'run_test_1')
})

test('recoverInterrupted marks a stale running run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-run-recover-'))
  const run = { id: 'run_test_2', status: 'running', startedAt: 1, nodes: {}, events: [] }
  await saveRunArtifacts(root, { run })
  const recovered = await recoverInterrupted(root)
  assert.equal(recovered.status, 'interrupted')
  assert.ok(recovered.events.some((event) => event.type === 'run-interrupted'))
})
