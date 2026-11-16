import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { saveRunArtifacts } from './run-store.js'
import { snapshotState, restoreState } from './run-state.js'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function renderPart(template, payload) {
  const text = typeof template === 'string' ? template : ''
  if (!text.trim()) return { text: '', used: false }
  if (text.includes('{{input-x}}')) {
    return { text: text.split('{{input-x}}').join(payload || ''), used: true }
  }
  return { text, used: false }
}

function composePrompt(edgeInstruction, nodePrompt, payload) {
  const edge = renderPart(edgeInstruction, payload)
  const node = renderPart(nodePrompt, payload)
  const parts = [edge.text, node.text].filter((part) => part.trim())
  let prompt = parts.join('\n\n')
  const used = edge.used || node.used
  if (!prompt) {
    prompt = payload || ''
  } else if (!used && payload) {
    prompt += `\n\n${payload}`
  }
  return prompt.trim()
}

function outputSpecOf(node) {
  const spec = node?.outputSpec && typeof node.outputSpec === 'object' ? node.outputSpec : {}
  const fields = Array.isArray(spec.fields) && spec.fields.length ? spec.fields : ['x']
  return {
    mode: spec.mode === 'json' ? 'json' : 'text',
    fields: fields.filter((field) => typeof field === 'string' && field).slice(0, 3),
    maxResults: Number.isFinite(spec.maxResults) ? Math.min(10, Math.max(1, spec.maxResults)) : 3,
  }
}

function formatInstruction(spec, node) {
  if (spec.mode !== 'json') return ''
  const fields = spec.fields.length ? spec.fields : ['x']
  const example = { results: [Object.fromEntries(fields.map((field) => [field, '...']))] }
  const ports = Array.isArray(node?.outputPorts) ? node.outputPorts : []
  const targetFlow = ports.length > 1
    ? `可选字段 target：值为输出口 id 之一（${ports.map((port) => port.id).join('、')}）；不写则走默认输出口。`
    : ''
  return [
    '',
    '【输出格式要求】',
    '只返回一个合法 JSON 对象，不要 Markdown 代码块，不要额外解释。',
    `结构：${JSON.stringify(example)}`,
    `results 必须是数组，长度 1 到 ${spec.maxResults}。`,
    `每个结果必须包含字段：${fields.join('、')}。`,
    targetFlow,
  ].filter(Boolean).join('\n')
}

function parseModelOutput(raw, spec) {
  if (spec.mode !== 'json') return [{ x: String(raw || '') }]
  let text = String(raw || '').trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('output-not-json')
    data = JSON.parse(text.slice(start, end + 1))
  }
  let items
  if (Array.isArray(data)) items = data
  else if (Array.isArray(data?.results)) items = data.results
  else if (data && typeof data === 'object') items = [data]
  else throw new Error('output-results-missing')
  if (!items.length) throw new Error('output-results-empty')
  if (items.length > spec.maxResults) throw new Error('output-too-many-results')
  return items.map((item, index) => {
    if (typeof item === 'string') return { x: item }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`output-result-${index + 1}-not-object`)
    }
    const result = {}
    for (const field of spec.fields) {
      if (item[field] === undefined || item[field] === null) {
        throw new Error(`output-result-${index + 1}-missing-${field}`)
      }
      result[field] = String(item[field])
    }
    if (typeof item.target === 'string' && item.target) result.target = item.target
    return result
  })
}

function edgeDeliveryText(edge, payload) {
  const part = renderPart(edge.instruction, payload)
  if (!part.text.trim()) return payload || ''
  if (part.used) return part.text
  return `${part.text}\n\n${payload || ''}`
}

function joinText(edgeTexts) {
  return edgeTexts.map((text) => String(text || '').trim()).filter(Boolean).join('\n\n---\n\n')
}

function composeJoinPrompt(node, merged) {
  const nodePart = renderPart(node.prompt, merged)
  if (nodePart.used) return nodePart.text.trim()
  const parts = [merged, nodePart.text].filter((part) => part.trim())
  return parts.join('\n\n').trim()
}

async function skillPromptForNode(ctx, node) {
  const refs = Array.isArray(node.skillRefs) ? node.skillRefs : []
  if (!refs.length) return { text: '', missing: [] }
  const skills = ctx.get('skills')
  if (!skills || typeof skills.get !== 'function') return { text: '', missing: refs }
  const parts = []
  const missing = []
  for (const ref of refs) {
    const name = String(ref).split('@')[0]
    try {
      const definition = await skills.get(name)
      if (!definition) {
        missing.push(name)
        continue
      }
      const content = String(definition.content || '').trim()
      if (content) parts.push(`【Skill: ${name}】\n${content.slice(0, 12000)}`)
    } catch {
      missing.push(name)
    }
  }
  return { text: parts.join('\n\n'), missing }
}

function findPort(node, portId, direction) {
  const ports = direction === 'in'
    ? (Array.isArray(node?.inputPorts) && node.inputPorts.length ? node.inputPorts : [{ id: 'in_1', policy: 'each' }])
    : (Array.isArray(node?.outputPorts) && node.outputPorts.length ? node.outputPorts : [{ id: 'out_1', policy: 'all' }])
  return ports.find((port) => port.id === portId) || ports[0]
}

function portInstruction(node, outgoingByPort, incomingByPort) {
  const inputs = Array.isArray(node.inputPorts) ? node.inputPorts : []
  const outputs = Array.isArray(node.outputPorts) ? node.outputPorts : []
  const flows = ['', '【本节点端口信息】']
  if (inputs.length) {
    flows.push('输入口：')
    for (const port of inputs) {
      const count = (incomingByPort.get(`${node.id}\u0000${port.id}`) || []).length
      flows.push(`- ${port.id}（${port.label || port.id}，${port.policy}，${count} 条输入线）`)
    }
  }
  if (outputs.length) {
    flows.push('输出口：')
    for (const port of outputs) {
      const count = (outgoingByPort.get(`${node.id}\u0000${port.id}`) || []).length
      const isDefault = port.id === (node.defaultOutputPortId || outputs[0]?.id)
      flows.push(`- ${port.id}（${port.label || port.id}，${port.policy}，${count} 条输出线${isDefault ? '，默认' : ''}）`)
    }
    flows.push('如果结果需要从非默认输出口发出，在每条结果里写 target 字段，值为对应输出口 id；不写则走默认输出口。')
  }
  return flows.join('\n')
}

function messageText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

async function latestSeq(ctx, sessionId) {
  try {
    const events = await ctx.sessionQuery.listEvents(sessionId)
    return events.length ? events[events.length - 1].seq : 0
  } catch {
    return 0
  }
}

async function readAssistantAfter(ctx, sessionId, afterSeq) {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.seq <= afterSeq) break
    if (event.type !== 'assistant/message') continue
    const text = messageText(event.data?.message).trim()
    if (text) return text
  }
  return ''
}

async function waitForAssistant(ctx, sessionId, afterSeq, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      last = await readAssistantAfter(ctx, sessionId, afterSeq)
      if (last) return last
    } catch {
      // The log may not be readable during a live write; retry.
    }
    await delay(250)
  }
  throw new Error(`node-timeout: no assistant output after ${timeoutMs}ms`)
}

async function waitForTurnEnd(ctx, sessionId, afterSeq, isStopped) {
  while (true) {
    if (isStopped()) throw new Error('run-stopped')
    try {
      const events = await ctx.sessionQuery.listEvents(sessionId)
      if (events.some((event) => event.type === 'turn/end' && event.seq > afterSeq)) {
        return
      }
    } catch {
      // The log may not be readable during a live write; retry.
    }
    await delay(500)
  }
}

async function waitIdle(agent, timeoutMs) {
  if (!agent || typeof agent.whenIdle !== 'function') return
  let timer = null
  try {
    await Promise.race([
      Promise.resolve(agent.whenIdle()),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`node-timeout: agent idle after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveAgent(ctx, sessionId) {
  const live = ctx.agents.get(sessionId)
  if (live) return live
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.resolveAgent === 'function') {
    const result = await controller.resolveAgent(sessionId)
    const candidate = result?.agent || result?.value?.agent || result?.session?.agent || result
    if (candidate && typeof candidate.followup === 'function') return candidate
  }
  return null
}

function runJson(run) {
  return JSON.parse(JSON.stringify(run))
}

export function createRunner(ctx) {
  let current = null
  let currentGraph = null
  let currentBinding = null
  let activeExecution = null
  let liveDispatch = null
  let liveSnapshot = null
  let counter = 0
  let stopRequested = false
  const activeAgents = new Map()

  const start = async (graph, options = {}) => {
    if (current && current.status === 'running') {
      throw new Error('run-already-active')
    }
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
    if (!nodes.length) throw new Error('graph-has-no-nodes')
    const incoming = new Set(
      (graph.edges || []).map((edge) => edge.to.nodeId)
    )
    const root = nodes.find((node) => !incoming.has(node.id))
    const startNodeId = options.startNodeId || (root ? root.id : nodes[0].id)
    const startNode = nodes.find((node) => node.id === startNodeId)
    if (!startNode) throw new Error('start-node-not-found')

    const timeoutMs = Math.min(30 * 60 * 1000, Math.max(10000, Number(options.timeoutMs) || 15 * 60 * 1000))
    const bindingSnapshot = options.binding || null
    const resumeState = options.resumeState || null
    counter += 1
    const run = {
      id: `run_${Date.now().toString(36)}_${counter}`,
      status: 'running',
      resumedFrom: typeof options.resumedFrom === 'string' ? options.resumedFrom : '',
      flowId: typeof options.flowId === 'string' ? options.flowId : '',
      flowVersion: typeof options.flowVersion === 'string' ? options.flowVersion : '',
      startedAt: Date.now(),
      endedAt: 0,
      input: typeof options.input === 'string' ? options.input : '',
      startPrompt: typeof options.startPrompt === 'string' ? options.startPrompt : '',
      startNodeId,
      timeoutMs,
      nodes: {},
      events: [],
      errors: [],
      error: '',
      deliveries: {},
    }
    current = run
    currentGraph = graph
    currentBinding = bindingSnapshot
    stopRequested = false
    void persistRun(run, graph, bindingSnapshot)
    activeExecution = execute(graph, run, bindingSnapshot, resumeState)
    return runJson(run)
  }

  const execute = async (graph, run, bindingSnapshot, resumeState) => {
    const nodes = new Map((graph.nodes || []).map((node) => [node.id, node]))
    const outgoingByPort = new Map()
    const incomingByPort = new Map()
    for (const node of graph.nodes || []) {
      for (const port of node.outputPorts || []) outgoingByPort.set(`${node.id}\u0000${port.id}`, [])
      for (const port of node.inputPorts || []) incomingByPort.set(`${node.id}\u0000${port.id}`, [])
    }
    for (const edge of graph.edges || []) {
      const outKey = `${edge.from.nodeId}\u0000${edge.from.portId}`
      const inKey = `${edge.to.nodeId}\u0000${edge.to.portId}`
      if (outgoingByPort.has(outKey)) outgoingByPort.get(outKey).push(edge)
      if (incomingByPort.has(inKey)) incomingByPort.get(inKey).push(edge)
    }
    for (const list of outgoingByPort.values()) {
      list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    }

    const ready = []
    const joins = new Map()
    const cursors = new Map()
    if (resumeState) {
      const restored = restoreState(resumeState)
      ready.push(...restored.ready)
      for (const [key, value] of restored.joins) joins.set(key, value)
      for (const [key, value] of restored.cursors) cursors.set(key, value)
      run.resumedFrom = run.resumedFrom || ''
    }
    let jobCounter = 0
    const checkpoint = () => {
      run.state = snapshotState({ ready, joins, cursors })
      void persistRun(run, graph, bindingSnapshot)
    }

    const sendAgentMessage = async (agent, text, hop, senderSessionId, messageId) => {
      const id = messageId || randomUUID()
      const source = {
        kind: 'agent-message',
        form: 'relay',
        busMessageId: id,
        threadId: run.id,
        hop: hop || 0,
      }
      if (senderSessionId) source.senderSessionId = senderSessionId
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source,
      })
    }

    const deliver = (edge, payload, sourceNode, hop, meta = {}) => {
      const target = nodes.get(edge.to.nodeId)
      if (!target) return
      const deliveryId = `${meta.sourceJobId || 'start'}:${edge.id}:${meta.resultIndex ?? 0}`
      if (run.deliveries[deliveryId]?.status === 'delivered') return
      run.deliveries[deliveryId] = {
        deliveryId,
        edgeId: edge.id,
        sourceJobId: meta.sourceJobId || '',
        resultIndex: meta.resultIndex ?? 0,
        to: target.id,
        toPort: edge.to.portId,
        status: 'delivered',
        at: Date.now(),
      }
      const port = findPort(target, edge.to.portId, 'in')
      const edgeText = edgeDeliveryText(edge, payload)
      run.events.push({
        at: Date.now(),
        nodeId: sourceNode.id,
        edgeId: edge.id,
        type: 'edge-deliver',
        to: target.id,
        toPort: port.id,
        policy: port.policy,
        payload: edgeText,
      })
      if (port.policy === 'all') {
        const key = `${target.id}\u0000${port.id}`
        const expected = incomingByPort.get(key) || []
        const state = joins.get(key) || {
          expected: new Set(expected.map((item) => item.id)),
          queues: new Map(expected.map((item) => [item.id, []])),
        }
        if (!state.queues.has(edge.id)) state.queues.set(edge.id, [])
        state.queues.get(edge.id).push({ edgeText })
        joins.set(key, state)
        while (expected.length > 0 && expected.every((item) => (state.queues.get(item.id) || []).length > 0)) {
          const batch = expected.map((item) => state.queues.get(item.id).shift())
          const merged = joinText(batch.map((item) => item.edgeText))
          ready.push({
            nodeId: target.id,
            portId: port.id,
            prompt: composeJoinPrompt(target, merged),
            hop: (hop || 0) + 1,
            senderSessionId: sourceNode.sessionId,
            inputs: batch.length,
          })
        }
        if (expected.every((item) => (state.queues.get(item.id) || []).length === 0)) {
          joins.delete(key)
        }
        checkpoint()
        return
      }
      ready.push({
        nodeId: target.id,
        portId: port.id,
        prompt: composePrompt(edge.instruction, target.prompt, payload),
        hop: (hop || 0) + 1,
        senderSessionId: sourceNode.sessionId,
        inputs: 1,
      })
      checkpoint()
    }

    const dispatchResults = (node, results, jobId, hop) => {
      const outputPorts = Array.isArray(node.outputPorts) && node.outputPorts.length
        ? node.outputPorts
        : [{ id: 'out_1', label: 'OUT1', policy: 'all' }]
      const outputPortIds = new Set(outputPorts.map((port) => port.id))
      const defaultPortId = outputPortIds.has(node.defaultOutputPortId)
        ? node.defaultOutputPortId
        : outputPorts[0]?.id
      const grouped = new Map()
      for (const result of results) {
        const targetPortId = typeof result.target === 'string' && result.target
          ? result.target
          : defaultPortId
        if (!targetPortId || !outputPortIds.has(targetPortId)) {
          throw new Error(`unknown-output-target: ${result.target || '(default)'}`)
        }
        if (!grouped.has(targetPortId)) grouped.set(targetPortId, [])
        grouped.get(targetPortId).push(result)
      }
      for (const [portId, portResults] of grouped) {
        const port = outputPorts.find((item) => item.id === portId)
        if (!port) continue
        const edges = (outgoingByPort.get(`${node.id}\u0000${port.id}`) || [])
          .slice()
          .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        if (!edges.length) {
          run.events.push({
            at: Date.now(),
            jobId,
            nodeId: node.id,
            portId: port.id,
            type: 'output-skip',
            reason: 'no-edges',
          })
          continue
        }
        if (port.policy === 'conditional') {
          throw new Error(`unsupported-output-policy: conditional (${node.title || node.id})`)
        }
        if (port.policy === 'roundRobin') {
          const cursorKey = `${node.id}\u0000${port.id}`
          const startCursor = cursors.get(cursorKey) || 0
          for (let index = 0; index < portResults.length; index += 1) {
            const edge = edges[(startCursor + index) % edges.length]
            deliver(edge, portResults[index].x, node, hop, { sourceJobId: jobId, resultIndex: index })
          }
          cursors.set(cursorKey, (startCursor + portResults.length) % edges.length)
          continue
        }
        for (let index = 0; index < portResults.length; index += 1) {
          const result = portResults[index]
          for (const edge of edges) {
            deliver(edge, result.x, node, hop, { sourceJobId: jobId, resultIndex: index })
          }
        }
      }
    }

    liveDispatch = dispatchResults
    liveSnapshot = () => snapshotState({ ready, joins, cursors })

    const runNodeJob = async (job) => {
      const node = nodes.get(job.nodeId)
      if (!node) return
      const spec = outputSpecOf(node)
      const jobId = `${node.id}#${++jobCounter}`
      const nodeRun = {
        jobId,
        nodeId: node.id,
        inputPortId: job.portId || '',
        sessionId: node.sessionId,
        title: node.title || '',
        status: 'running',
        input: '',
        basePrompt: job.prompt || '',
        hop: job.hop || 0,
        inputs: job.inputs || 1,
        output: '',
        results: [],
        resultCount: 0,
        startedAt: Date.now(),
        endedAt: 0,
        error: '',
      }
      run.nodes[jobId] = nodeRun
      const agent = await resolveAgent(ctx, node.sessionId)
      if (!agent) throw new Error(`session-not-live: ${node.title || node.sessionId}`)
      const basePrompt = String(job.prompt || '')
      if (!basePrompt.trim()) throw new Error(`empty-input: ${node.title || node.id}`)
      const topology = portInstruction(node, outgoingByPort, incomingByPort)
      const skillPart = await skillPromptForNode(ctx, node)
      if (skillPart.missing.length) {
        run.events.push({ at: Date.now(), jobId, nodeId: node.id, type: 'skill-missing', skills: skillPart.missing })
      }
      const prompt = [skillPart.text, `${basePrompt}${topology}${formatInstruction(spec, node)}`]
        .filter((part) => part && part.trim())
        .join('\n\n')
      nodeRun.input = prompt
      run.events.push({
        at: Date.now(),
        jobId,
        nodeId: node.id,
        portId: job.portId || '',
        type: 'node-start',
        input: prompt,
      })
      activeAgents.set(node.id, agent)
      let baseline = await latestSeq(ctx, node.sessionId)
      const primaryMessageId = `${run.id}:${jobId}:primary`
      nodeRun.messageId = primaryMessageId
      nodeRun.afterSeq = baseline
      checkpoint()
      await sendAgentMessage(agent, prompt, job.hop, job.senderSessionId, primaryMessageId)
      await waitForTurnEnd(ctx, node.sessionId, baseline, () => stopRequested)
      let raw = ''
      try {
        raw = await readAssistantAfter(ctx, node.sessionId, baseline)
      } catch {
        raw = ''
      }
      if (!raw) throw new Error(`empty-assistant-output: ${node.title || node.id}`)
      let results
      try {
        results = parseModelOutput(raw, spec)
      } catch (firstError) {
        run.events.push({
          at: Date.now(),
          jobId,
          nodeId: node.id,
          type: 'format-retry',
          error: String(firstError?.message || firstError),
        })
        run.events.push({
          at: Date.now(),
          jobId,
          nodeId: node.id,
          type: 'format-attempt',
          attempt: 2,
        })
        baseline = await latestSeq(ctx, node.sessionId)
        nodeRun.afterSeq = baseline
        const correctionMessageId = `${run.id}:${jobId}:format`
        nodeRun.messageId = correctionMessageId
        checkpoint()
        const correction = [
          '上一条输出不符合约定格式。',
          `原因：${String(firstError?.message || firstError)}`,
          '请重新输出，只返回约定结构，不要解释。',
          topology,
          formatInstruction(spec, node),
        ].join('\n')
        await sendAgentMessage(agent, correction, job.hop, job.senderSessionId, correctionMessageId)
        await waitForTurnEnd(ctx, node.sessionId, baseline, () => stopRequested)
        try {
          raw = await readAssistantAfter(ctx, node.sessionId, baseline)
        } catch {
          raw = ''
        }
        if (!raw) throw new Error(`empty-assistant-output: ${node.title || node.id}`)
        results = parseModelOutput(raw, spec)
      }
      activeAgents.delete(node.id)
      nodeRun.output = raw
      nodeRun.results = results
      nodeRun.resultCount = results.length
      nodeRun.status = 'done'
      nodeRun.endedAt = Date.now()
      run.events.push({
        at: Date.now(),
        jobId,
        nodeId: node.id,
        type: 'node-done',
        resultCount: results.length,
        output: raw,
      })

      dispatchResults(node, results, jobId, job.hop)
    }

    const startNode = nodes.get(run.startNodeId)
    if (!startNode) throw new Error('start-node-not-found')
    if (!resumeState) {
      ready.push({
        nodeId: startNode.id,
        portId: startNode.inputPorts?.[0]?.id || '',
        prompt: run.startPrompt || composePrompt('', startNode.prompt, run.input),
        hop: 0,
        inputs: 1,
        isStart: true,
      })
      checkpoint()
    }

    try {
      const MAX_PARALLEL = 8
      const activeJobs = new Set()
      const activeNodes = new Set()
      let finishing = false
      let fatalError = null
      let resolveDone = null
      const donePromise = new Promise((resolve) => { resolveDone = resolve })

      const markRunningStopped = () => {
        for (const nodeRun of Object.values(run.nodes)) {
          if (nodeRun.status !== 'running') continue
          nodeRun.status = 'stopped'
          nodeRun.endedAt = Date.now()
          run.events.push({
            at: Date.now(),
            jobId: nodeRun.jobId,
            nodeId: nodeRun.nodeId,
            type: 'node-stopped',
          })
        }
      }

      const finish = () => {
        if (finishing) return
        if (ready.length || activeJobs.size) return
        finishing = true
        let finalError = fatalError
        if (!finalError && joins.size) {
          const [key, state] = joins.entries().next().value
          const [nodeId, portId] = key.split('\u0000')
          const received = [...state.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
          finalError = new Error(`incomplete-join: ${nodeId}/${portId} (${received}/${state.expected.size})`)
        }
        if (stopRequested) {
          markRunningStopped()
          run.status = 'stopped'
          run.events.push({ at: Date.now(), type: 'run-stopped' })
        } else if (finalError || run.errors.length) {
          run.status = 'error'
          run.error = String((finalError || run.errors[0])?.message || finalError || run.errors[0]?.error || 'run-error')
          run.events.push({ at: Date.now(), type: 'run-error', error: run.error })
        } else {
          run.status = 'done'
        }
        run.endedAt = Date.now()
        resolveDone()
      }

      const pump = () => {
        if (finishing) return
        if (stopRequested) {
          ready.length = 0
          for (const agent of activeAgents.values()) {
            if (typeof agent.cancel === 'function') {
              try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ }
            }
          }
          activeAgents.clear()
          if (!activeJobs.size) finish()
          return
        }
        for (let i = 0; i < ready.length && activeJobs.size < MAX_PARALLEL;) {
          const job = ready[i]
          if (activeNodes.has(job.nodeId)) {
            i += 1
            continue
          }
          ready.splice(i, 1)
          activeNodes.add(job.nodeId)
          const task = (async () => {
            try {
              await runNodeJob(job)
            } catch (error) {
              if (stopRequested) return
              if (job.isStart) {
                fatalError = error
                ready.length = 0
                for (const agent of activeAgents.values()) {
                  if (typeof agent.cancel === 'function') {
                    try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ }
                  }
                }
                activeAgents.clear()
                return
              }
              const failedAgent = activeAgents.get(job.nodeId)
              if (failedAgent && typeof failedAgent.cancel === 'function') {
                try { failedAgent.cancel({ kind: 'user' }) } catch { /* best effort */ }
              }
              activeAgents.delete(job.nodeId)
              const failed = Object.values(run.nodes).reverse().find((nodeRun) => (
                nodeRun.nodeId === job.nodeId && nodeRun.status === 'running'
              ))
              if (failed) {
                failed.status = 'error'
                failed.error = String(error?.message || error)
                failed.endedAt = Date.now()
              }
              run.errors.push({
                nodeId: job.nodeId,
                portId: job.portId || '',
                error: String(error?.message || error),
              })
              run.events.push({
                at: Date.now(),
                nodeId: job.nodeId,
                type: 'job-error',
                error: String(error?.message || error),
              })
            } finally {
              activeNodes.delete(job.nodeId)
              activeJobs.delete(task)
              checkpoint()
              pump()
            }
          })()
          activeJobs.add(task)
        }
        if (!ready.length && !activeJobs.size) finish()
      }

      pump()
      await donePromise
    } catch (error) {
      for (const agent of activeAgents.values()) {
        if (typeof agent.cancel === 'function') {
          try {
            agent.cancel({ kind: 'user' })
          } catch {
            // Best effort: the log tail remains available for diagnosis.
          }
        }
      }
      activeAgents.clear()
      if (stopRequested || String(error?.message || error) === 'run-stopped') {
        for (const nodeRun of Object.values(run.nodes)) {
          if (nodeRun.status !== 'running') continue
          nodeRun.status = 'stopped'
          nodeRun.endedAt = Date.now()
          run.events.push({
            at: Date.now(),
            jobId: nodeRun.jobId,
            nodeId: nodeRun.nodeId,
            type: 'node-stopped',
          })
        }
        run.status = 'stopped'
        run.endedAt = Date.now()
        run.events.push({ at: Date.now(), type: 'run-stopped' })
      } else {
        run.status = 'error'
        run.error = String(error?.message || error)
        run.endedAt = Date.now()
        for (const nodeRun of Object.values(run.nodes)) {
          if (nodeRun.status === 'running') {
            nodeRun.status = 'error'
            nodeRun.error = run.error
            nodeRun.endedAt = Date.now()
          }
        }
        run.events.push({ at: Date.now(), type: 'run-error', error: run.error })
      }
    }
    void persistRun(run, graph, bindingSnapshot)
  }
  const persistRun = async (run, graph, binding) => {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const dir = path.join(home, 'inter-session-flow')
      await saveRunArtifacts(dir, { run, graph, binding, state: run.state })
    } catch {
      // A run log is diagnostic, not a reason to fail execution.
    }
  }

  const stop = () => {
    stopRequested = true
    for (const agent of activeAgents.values()) {
      if (typeof agent.cancel === 'function') {
        try {
          agent.cancel({ kind: 'user' })
        } catch {
          // Cancellation is best effort; the polling loop still stops.
        }
      }
    }
    if (current && (current.status === 'running' || current.status === 'stopping')) {
      current.status = 'stopping'
      current.events.push({ at: Date.now(), type: 'stop-requested' })
    }
    return current ? runJson(current) : null
  }

  const retry = async (jobId) => {
    if (!current || !currentGraph) throw new Error('no-run')
    if (current.status === 'running' || current.status === 'stopping') throw new Error('run-active')
    const nodeRun = current.nodes?.[jobId]
    if (!nodeRun) throw new Error('node-run-not-found')
    if (activeExecution) {
      try { await activeExecution } catch { /* old attempt already settled */ }
      activeExecution = null
    }
    const node = (currentGraph.nodes || []).find((item) => item.id === nodeRun.nodeId)
    if (!node) throw new Error('node-not-found')
    if (!node.sessionId) throw new Error('node-session-missing')
    if (nodeRun.status === 'done' && nodeRun.output) throw new Error('node-already-done')
    const state = current.state && typeof current.state === 'object' ? current.state : {}
    const ready = Array.isArray(state.ready) ? [...state.ready] : []
    ready.push({
      nodeId: nodeRun.nodeId,
      portId: nodeRun.inputPortId || '',
      prompt: nodeRun.basePrompt || nodeRun.input || node.prompt || '',
      hop: nodeRun.hop || 0,
      inputs: nodeRun.inputs || 1,
    })
    const resumeState = { ...state, ready, active: [] }
    current.status = 'running'
    current.endedAt = 0
    current.error = ''
    current.errors = []
    current.retryCount = (current.retryCount || 0) + 1
    stopRequested = false
    current.events.push({ at: Date.now(), jobId, nodeId: node.id, type: 'node-retry-start' })
    activeExecution = execute(currentGraph, current, currentBinding, resumeState)
    return runJson(current)
  }

  const adopt = async (jobId, runId) => {
    if (!current || !currentGraph) throw new Error('no-run')
    if (runId && current.id !== runId) throw new Error('run-not-current')
    if (current.status === 'running' || current.status === 'stopping') throw new Error('run-active')
    if (activeExecution) {
      try { await activeExecution } catch { /* old attempt already settled */ }
      activeExecution = null
    }
    const nodeRun = current.nodes?.[jobId]
    if (!nodeRun) throw new Error('node-run-not-found')
    const node = (currentGraph.nodes || []).find((item) => item.id === nodeRun.nodeId)
    if (!node) throw new Error('node-not-found')
    if (!liveDispatch || !liveSnapshot) throw new Error('no-live-context')
    const events = await ctx.sessionQuery.listEvents(nodeRun.sessionId)
    const sent = events.find((event) => event.type === 'user/message' &&
      event.data?.source?.busMessageId === nodeRun.messageId)
    const assistant = sent
      ? events.find((event) => event.type === 'assistant/message' && event.seq > sent.seq)
      : null
    if (!assistant) throw new Error('no-assistant-output')
    const raw = (assistant.data?.message?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (!raw.trim()) throw new Error('empty-assistant-output')
    const results = parseModelOutput(raw, outputSpecOf(node))
    nodeRun.output = raw
    nodeRun.results = results
    nodeRun.resultCount = results.length
    nodeRun.status = 'done'
    nodeRun.endedAt = Date.now()
    current.events.push({ at: Date.now(), jobId, nodeId: node.id, type: 'node-adopted', output: raw })
    liveDispatch(node, results, jobId, nodeRun.hop || 0)
    const resumeState = liveSnapshot()
    current.status = 'running'
    current.endedAt = 0
    current.error = ''
    current.errors = []
    current.endedAt = 0
    stopRequested = false
    activeExecution = execute(currentGraph, current, currentBinding, resumeState)
    return runJson(current)
  }

  const abandon = async (jobId, runId) => {
    if (!current) throw new Error('no-run')
    if (runId && current.id !== runId) throw new Error('run-not-current')
    if (current.status === 'running' || current.status === 'stopping') throw new Error('run-active')
    const nodeRun = current.nodes?.[jobId]
    if (!nodeRun) throw new Error('node-run-not-found')
    nodeRun.status = 'abandoned'
    nodeRun.endedAt = Date.now()
    current.events.push({ at: Date.now(), jobId, nodeId: nodeRun.nodeId, type: 'node-abandoned' })
    current.status = 'stopped'
    current.endedAt = Date.now()
    await persistRun(current, currentGraph, currentBinding)
    return runJson(current)
  }

  return {
    start,
    stop,
    retry,
    adopt,
    abandon,
    get: () => (current ? runJson(current) : null),
  }
}


