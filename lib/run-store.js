import fs from 'node:fs/promises'
import path from 'node:path'

function runsRoot(root) {
  return path.join(root, 'runs')
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

export async function saveRunArtifacts(root, { run, graph, binding, state } = {}) {
  if (!run?.id) return null
  const dir = path.join(runsRoot(root), run.id)
  await fs.mkdir(dir, { recursive: true })
  await writeJson(path.join(dir, 'run.json'), run)
  const events = Array.isArray(run.events) ? run.events : []
  await fs.writeFile(
    path.join(dir, 'events.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''),
    'utf8',
  )
  if (graph) await writeJson(path.join(dir, 'flow.json'), graph)
  if (binding) await writeJson(path.join(dir, 'binding.json'), binding)
  if (state) await writeJson(path.join(dir, 'state.json'), state)
  // Keep the 1.0.x flat run log for the existing run panel.
  await writeJson(path.join(runsRoot(root), `${run.id}.json`), run)
  return dir
}

export async function listRuns(root) {
  let entries = []
  try {
    entries = await fs.readdir(runsRoot(root), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const entry of entries) {
    const full = path.join(runsRoot(root), entry.name)
    try {
      let run
      let state = null
      if (entry.isDirectory()) {
        run = await readJson(path.join(full, 'run.json'))
        try {
          state = await readJson(path.join(full, 'state.json'))
        } catch {
          state = null
        }
      } else if (entry.name.endsWith('.json')) {
        run = await readJson(full)
      } else {
        continue
      }
      rows.push({
        id: run.id,
        status: run.status,
        flowId: run.flowId || '',
        flowVersion: run.flowVersion || '',
        startedAt: run.startedAt || 0,
        endedAt: run.endedAt || 0,
        error: run.error || '',
        nodeCount: Object.keys(run.nodes || {}).length,
        eventCount: Array.isArray(run.events) ? run.events.length : 0,
        resumable: Boolean(state && Array.isArray(state.ready) && state.ready.length),
      })
    } catch {
      // A corrupt run log is skipped.
    }
  }
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()]
  return unique.sort((a, b) => b.startedAt - a.startedAt)
}

export async function readRun(root, runId) {
  const dir = path.join(runsRoot(root), runId, 'run.json')
  try {
    return await readJson(dir)
  } catch {
    try {
      return await readJson(path.join(runsRoot(root), `${runId}.json`))
    } catch {
      return null
    }
  }
}

export async function readRunState(root, runId) {
  try {
    return await readJson(path.join(runsRoot(root), runId, 'state.json'))
  } catch {
    return null
  }
}

export async function readRunArtifact(root, runId, name) {
  try {
    return await readJson(path.join(runsRoot(root), runId, name))
  } catch {
    return null
  }
}

export async function recoverInterrupted(root) {
  const runs = await listRuns(root)
  const latest = runs.find((run) => run.status === 'running' || run.status === 'stopping')
  if (!latest) return null
  const run = await readRun(root, latest.id)
  if (!run) return null
  run.status = 'interrupted'
  run.endedAt = run.endedAt || Date.now()
  run.events = Array.isArray(run.events) ? run.events : []
  run.events.push({ at: Date.now(), type: 'run-interrupted' })
  await saveRunArtifacts(root, { run })
  return run
}
