window.__ModuleLoader__.load({
  id: '@local/dsh-inter-session-flow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const NODE_W = 190
    const NODE_H = 68
    const CANVAS_W = 1680
    const CANVAS_H = 1040
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
    const API_FLOWS = '/api/inter-session-flow/flows'
    const API_IMPORT = '/api/inter-session-flow/import'
    const API_IMPORT_PREVIEW = '/api/inter-session-flow/import/preview'
    const API_SKILLS = '/api/inter-session-flow/skills'
    const THEMES = ['graphite', 'mist', 'pine', 'amber', 'violet', 'paper']

    const emptyGraph = () => ({
      version: 2,
      updatedAt: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    })

    function defaultPorts(direction) {
      return [{
        id: direction === 'in' ? 'in_1' : 'out_1',
        label: direction === 'in' ? 'IN1' : 'OUT1',
        policy: direction === 'in' ? 'each' : 'all',
      }]
    }

    function inputPortsOf(node) {
      return Array.isArray(node?.inputPorts) && node.inputPorts.length
        ? node.inputPorts
        : defaultPorts('in')
    }

    function outputPortsOf(node) {
      return Array.isArray(node?.outputPorts) && node.outputPorts.length
        ? node.outputPorts
        : defaultPorts('out')
    }

    function outputSpecOf(node) {
      const spec = node?.outputSpec && typeof node.outputSpec === 'object' ? node.outputSpec : {}
      return {
        mode: spec.mode === 'json' ? 'json' : 'text',
        fields: Array.isArray(spec.fields) && spec.fields.length ? spec.fields : ['x'],
        maxResults: Number.isFinite(spec.maxResults) ? spec.maxResults : 3,
      }
    }

    function defaultOutputPortOf(node) {
      const ports = outputPortsOf(node)
      return ports.some((port) => port.id === node?.defaultOutputPortId)
        ? node.defaultOutputPortId
        : ports[0].id
    }

    function portPoint(node, portId, direction) {
      const ports = direction === 'in' ? inputPortsOf(node) : outputPortsOf(node)
      const index = Math.max(0, ports.findIndex((port) => port.id === portId))
      const y = node.y + (NODE_H * (index + 1)) / (ports.length + 1)
      const x = direction === 'in' ? node.x : node.x + NODE_W
      return { x, y }
    }

    function uid(prefix) {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return prefix + globalThis.crypto.randomUUID().slice(0, 8)
      }
      return prefix + Math.random().toString(36).slice(2, 10)
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function edgeKey(from, to) {
      return from + '\u0000' + to
    }

    function wouldCycle(graph, from, to) {
      const adjacency = new Map()
      for (const node of graph.nodes) adjacency.set(node.id, [])
      for (const edge of graph.edges) {
        adjacency.get(edge.from.nodeId).push(edge.to.nodeId)
      }
      const seen = new Set()
      const stack = [to]
      while (stack.length) {
        const id = stack.pop()
        if (id === from) return true
        if (seen.has(id)) continue
        seen.add(id)
        for (const next of adjacency.get(id) || []) stack.push(next)
      }
      return false
    }

    function pathOf(a, b) {
      const x1 = a.x
      const y1 = a.y
      const x2 = b.x
      const y2 = b.y
      const bend = Math.max(68, Math.abs(x2 - x1) * 0.42)
      return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
    }

    function readJson(response) {
      return response.json().then((value) => {
        if (!response.ok || value?.ok === false) {
          throw new Error(value?.error || `HTTP ${response.status}`)
        }
        return value
      })
    }

    function normalizeSessions(value) {
      const list = Array.isArray(value?.sessions) ? value.sessions : []
      return list
        .filter((item) => item && typeof item.id === 'string' && item.id)
        .map((item) => ({
          id: item.id,
          title: typeof item.title === 'string' ? item.title : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        }))
    }

    function labelForSession(session) {
      const suffix = session.id.slice(-6)
      if (session.title) return `${session.title} · ${suffix}`
      if (session.cwd) {
        const parts = session.cwd.split(/[\\/]/).filter(Boolean)
        if (parts.length) return `${parts[parts.length - 1]} · ${suffix}`
      }
      return session.id.slice(-8)
    }

    function duplicateInputWarnings(graph) {
      const nodes = new Map((graph.nodes || []).map((node) => [node.id, node]))
      const warnings = []
      for (const edge of graph.edges || []) {
        const target = nodes.get(edge.to.nodeId)
        if (!target) continue
        if ((edge.instruction || '').includes('{{input-x}}') &&
            (target.prompt || '').includes('{{input-x}}')) {
          warnings.push({
            edgeId: edge.id,
            from: nodes.get(edge.from.nodeId)?.title || edge.from.nodeId,
            to: target.title || edge.to.nodeId,
          })
        }
      }
      return warnings
    }

    function FlowPanel(props) {
      const t = props.t || ((key) => key)
      const language = props.language || 'zh'
      const onLanguageChange = props.onLanguageChange || (() => {})
      const statusText = (value) => t(`status_${value}`) || value
      const [graph, setGraph] = useState(emptyGraph)
      const [sessions, setSessions] = useState([])
      const [view, setView] = useState('library')
      const [flows, setFlows] = useState([])
      const [flowsLoading, setFlowsLoading] = useState(true)
      const [libraryError, setLibraryError] = useState('')
      const [newFlowTitle, setNewFlowTitle] = useState('')
      const [flowMeta, setFlowMeta] = useState(null)
      const [menuFlowId, setMenuFlowId] = useState(null)
      const [skills, setSkills] = useState([])
      const [skillsLoading, setSkillsLoading] = useState(false)
      const [skillsLoaded, setSkillsLoaded] = useState(false)
      const [skillQuery, setSkillQuery] = useState('')
      const [skillsOpen, setSkillsOpen] = useState(false)
      const [importPreview, setImportPreview] = useState(null)
      const [importBusy, setImportBusy] = useState(false)
      const [preflightResult, setPreflightResult] = useState(null)
      const [reconcileResult, setReconcileResult] = useState(null)
      const [mode, setMode] = useState('node')
      const [theme, setTheme] = useState(() => {
        try {
          const stored = localStorage.getItem('inter-session-flow-theme') ||
            localStorage.getItem('session-flow-theme')
          return THEMES.includes(stored) ? stored : 'graphite'
        } catch {
          return 'graphite'
        }
      })
      const [edgeKind, setEdgeKind] = useState('hard')
      const [selectedNode, setSelectedNode] = useState(null)
      const [selectedEdge, setSelectedEdge] = useState(null)
      const [wireFrom, setWireFrom] = useState(null)
      const [sessionChoice, setSessionChoice] = useState('')
      const [sessionFilter, setSessionFilter] = useState('')
      const [status, setStatus] = useState('')
      const [saving, setSaving] = useState(false)
      const [loading, setLoading] = useState(true)
      const [sessionsError, setSessionsError] = useState('')
      const [sessionReload, setSessionReload] = useState(0)
      const [runInput, setRunInput] = useState('')
      const [startNodeId, setStartNodeId] = useState('')
      const [startTouched, setStartTouched] = useState(false)
      const [run, setRun] = useState(null)
      const [runHistory, setRunHistory] = useState([])
      const [runBusy, setRunBusy] = useState(false)
      const [runError, setRunError] = useState('')
      const [runWarning, setRunWarning] = useState(null)
      const graphRef = useRef(emptyGraph())
      const dragRef = useRef(null)
      const suppressClickRef = useRef(false)
      const fileInputRef = useRef(null)
      const [camera, setCamera] = useState({ x: 30, y: 30, zoom: 1 })
      const cameraRef = useRef(camera)
      const panRef = useRef(null)
      const cameraSaveTimer = useRef(null)
      const [panning, setPanning] = useState(false)
      const viewportRef = useRef(null)
      const svgRef = useRef(null)
      const [wirePointer, setWirePointer] = useState(null)

      const setCameraValue = (next) => {
        cameraRef.current = next
        setCamera(next)
      }

      const scheduleCameraSave = () => {
        if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
        cameraSaveTimer.current = setTimeout(() => {
          const next = { ...graphRef.current, viewport: cameraRef.current }
          void saveGraph(next)
        }, 350)
      }

      const stopCameraSaveTimer = () => {
        if (cameraSaveTimer.current) {
          clearTimeout(cameraSaveTimer.current)
          cameraSaveTimer.current = null
        }
      }

      const setGraphValue = (next) => {
        graphRef.current = next
        setGraph(next)
      }

      const loadFlows = async () => {
        setFlowsLoading(true)
        setLibraryError('')
        try {
          const response = await fetch(API_FLOWS, { cache: 'no-store' })
          const value = await readJson(response)
          setFlows(Array.isArray(value.flows) ? value.flows : [])
        } catch (error) {
          setLibraryError(String(error?.message || error))
        } finally {
          setFlowsLoading(false)
        }
      }

      const loadSkills = async (sessionId) => {
        setSkillsLoading(true)
        try {
          const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
          const response = await fetch(`${API_SKILLS}${query}`, { cache: 'no-store' })
          const value = await readJson(response)
          setSkills(Array.isArray(value.skills) ? value.skills : [])
          setSkillsLoaded(true)
        } catch {
          setSkills([])
          setSkillsLoaded(true)
        } finally {
          setSkillsLoading(false)
        }
      }

      const loadRunHistory = async () => {
        try {
          const response = await fetch(API_RUNS, { cache: 'no-store' })
          const value = await readJson(response)
          setRunHistory(Array.isArray(value.runs) ? value.runs : [])
        } catch {
          setRunHistory([])
        }
      }

      const openRunHistory = async (runId) => {
        try {
          const response = await fetch(`${API_RUNS}/${encodeURIComponent(runId)}`, { cache: 'no-store' })
          const value = await readJson(response)
          if (value.run) setRun(value.run)
        } catch (error) {
          setRunError(String(error.message || error))
        }
      }

      const retryRunNode = async (jobId) => {
        setRunBusy(true)
        setRunError('')
        try {
          const response = await fetch(API_RUN_RETRY, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId }),
          })
          const value = await readJson(response)
          if (value.run) setRun(value.run)
          void loadRunHistory()
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      const resumeRun = async (runId) => {
        setRunBusy(true)
        setRunError('')
        try {
          const response = await fetch(API_RUN_RESUME, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId }),
          })
          const value = await readJson(response)
          if (value.run) setRun(value.run)
          void loadRunHistory()
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      const reconcileRun = async (runId) => {
        try {
          const response = await fetch(API_RUN_RECONCILE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId }),
          })
          const value = await readJson(response)
          setReconcileResult({ runId, rows: value.active || [] })
        } catch (error) {
          setRunError(String(error.message || error))
        }
      }

      const adoptRunNode = async (jobId, runId) => {
        setRunBusy(true)
        setRunError('')
        try {
          const response = await fetch(API_RUN_ADOPT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, runId }),
          })
          const value = await readJson(response)
          if (value.run) setRun(value.run)
          setReconcileResult(null)
          void loadRunHistory()
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      const abandonRunNode = async (jobId, runId) => {
        setRunBusy(true)
        setRunError('')
        try {
          const response = await fetch(API_RUN_ABANDON, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, runId }),
          })
          const value = await readJson(response)
          if (value.run) setRun(value.run)
          setReconcileResult(null)
          void loadRunHistory()
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      useEffect(() => {
        setSkillsOpen(false)
      }, [selectedNode])

      useEffect(() => {
        void loadFlows()
        void loadRunHistory()
      }, [])

      useEffect(() => {
        if (!menuFlowId) return undefined
        const close = () => setMenuFlowId(null)
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenuFlowId(null)
        }
        document.addEventListener('click', close)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [menuFlowId])

      const selectedSessionId = selectedNode
        ? (graph.nodes.find((node) => node.id === selectedNode)?.sessionId || '')
        : ''

      useEffect(() => {
        void loadSkills(selectedSessionId)
      }, [selectedSessionId])

      useEffect(() => {
        let alive = true
        const loadSessions = async () => {
          setSessionsError('')
          setLoading(true)
          let lastError = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await fetch(API_SESSIONS, { cache: 'no-store' })
              const value = await readJson(response)
              if (!alive) return
              setSessions(normalizeSessions(value))
              setSessionsError('')
              setLoading(false)
              return
            } catch (error) {
              lastError = error
              if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
              }
            }
          }
          if (alive) {
            setLoading(false)
            setSessionsError(String(lastError?.message || 'sessions-unavailable'))
            setStatus(t('loadSessionsError'))
          }
        }
        loadSessions()
        return () => { alive = false }
      }, [sessionReload])

      useEffect(() => {
        let alive = true
        const loadRun = async () => {
          try {
            const response = await fetch(API_RUN, { cache: 'no-store' })
            const value = await readJson(response)
            if (alive) setRun(value.run || null)
          } catch {
            // A missing run is normal before the first execution.
          }
        }
        void loadRun()
        return () => { alive = false }
      }, [])

      useEffect(() => () => {
        stopCameraSaveTimer()
      }, [])

      useEffect(() => {
        try {
          localStorage.setItem('inter-session-flow-theme', theme)
        } catch {
          // Theme persistence is optional.
        }
      }, [theme])

      useEffect(() => {
        if (!graph.nodes.length) {
          if (startNodeId) setStartNodeId('')
          return
        }
        const incoming = new Set(
          graph.edges.map((edge) => edge.to.nodeId)
        )
        const root = graph.nodes.find((node) => !incoming.has(node.id))
        const valid = graph.nodes.some((node) => node.id === startNodeId)
        if (!startTouched || !valid) {
          setStartNodeId(root ? root.id : graph.nodes[0].id)
        }
      }, [graph.nodes, graph.edges, startNodeId, startTouched])

      useEffect(() => {
        if (!run || (run.status !== 'running' && run.status !== 'stopping')) return undefined
        const timer = setInterval(async () => {
          try {
            const response = await fetch(API_RUN, { cache: 'no-store' })
            const value = await readJson(response)
            if (value.run) setRun(value.run)
          } catch {
            // Polling is best effort; the next tick retries.
          }
        }, 500)
        return () => clearInterval(timer)
      }, [run?.id, run?.status])

      useEffect(() => {
        if (!wireFrom) {
          setWirePointer(null)
          return undefined
        }
        const viewport = viewportRef.current
        if (!viewport) return undefined
        const toWorld = (clientX, clientY) => {
          const svg = svgRef.current
          if (svg && typeof svg.getScreenCTM === 'function') {
            const point = svg.createSVGPoint()
            point.x = clientX
            point.y = clientY
            const matrix = svg.getScreenCTM()
            if (matrix) {
              const local = point.matrixTransform(matrix.inverse())
              return { x: local.x, y: local.y }
            }
          }
          const rect = viewport.getBoundingClientRect()
          const cameraValue = cameraRef.current
          return {
            x: (clientX - rect.left - cameraValue.x) / cameraValue.zoom,
            y: (clientY - rect.top - cameraValue.y) / cameraValue.zoom,
          }
        }
        const onMove = (event) => {
          const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.sf-port-in')
          if (hovered) {
            const nodeId = hovered.getAttribute('data-node-id')
            const portId = hovered.getAttribute('data-port-id')
            const node = graphRef.current.nodes.find((item) => item.id === nodeId)
            if (node) {
              setWirePointer(portPoint(node, portId, 'in'))
              return
            }
          }
          setWirePointer(toWorld(event.clientX, event.clientY))
        }
        const onUp = (event) => {
          const element = document.elementFromPoint(event.clientX, event.clientY)
          const target = element?.closest?.('.sf-port-in')
          if (!target) return
          const nodeId = target.getAttribute('data-node-id')
          const portId = target.getAttribute('data-port-id')
          if (!nodeId || !portId) return
          createEdge(wireFrom, { nodeId, portId })
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setWireFrom(null)
        }
        window.addEventListener('pointermove', onMove, { passive: true })
        window.addEventListener('pointerup', onUp)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('keydown', onKey)
        }
      }, [wireFrom])

      const nodeMap = useMemo(() => {
        const map = new Map()
        for (const node of graph.nodes) map.set(node.id, node)
        return map
      }, [graph.nodes])
      const visibleSessions = useMemo(() => {
        const needle = sessionFilter.trim().toLowerCase()
        const list = needle
          ? sessions.filter((session) => (
            labelForSession(session).toLowerCase().includes(needle) ||
            session.id.toLowerCase().includes(needle) ||
            session.cwd.toLowerCase().includes(needle)
          ))
          : sessions
        return list.slice(0, 120)
      }, [sessions, sessionFilter])

      const applyFlow = (line, binding) => {
        const bindings = binding?.nodes && typeof binding.nodes === 'object' ? binding.nodes : {}
        const nodes = (line.nodes || []).map((node) => {
          const bound = bindings[node.nodeId] || {}
          return {
            id: node.nodeId,
            sessionId: bound.sessionId || '',
            title: bound.sessionTitle || node.role || '',
            cwd: bound.cwd || '',
            prompt: node.prompt || '',
            outputSpec: node.outputSpec,
            outputSchema: node.outputSchema || {},
            skillRefs: Array.isArray(node.skillRefs) ? node.skillRefs : [],
            defaultOutputPortId: node.defaultOutputPortId,
            inputPorts: node.inputPorts,
            outputPorts: node.outputPorts,
            x: node.layout?.x || 0,
            y: node.layout?.y || 0,
          }
        })
        const edges = (line.edges || []).map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          mode: edge.mode,
          order: edge.order,
          instruction: edge.instruction || '',
        }))
        const next = {
          version: 2,
          updatedAt: Date.now(),
          viewport: binding?.layoutOverrides?.viewport || { x: 30, y: 30, zoom: 1 },
          nodes,
          edges,
        }
        setFlowMeta(line)
        setGraphValue(next)
        const viewport = next.viewport
        if (viewport && Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom)) {
          setCameraValue({ x: viewport.x, y: viewport.y, zoom: clamp(viewport.zoom, 0.35, 2.5) })
        }
        setSelectedNode(null)
        setSelectedEdge(null)
        setWireFrom(null)
        setView('canvas')
      }

      const openFlow = async (flowId) => {
        setStatus(t('saving'))
        try {
          const response = await fetch(`${API_FLOWS}/${encodeURIComponent(flowId)}`, { cache: 'no-store' })
          const value = await readJson(response)
          applyFlow(value.flow, value.binding)
          setStatus('')
        } catch (error) {
          setStatus(`${t('loadError')}: ${error.message}`)
        }
      }

      const createFlow = async () => {
        const title = newFlowTitle.trim() || t('untitledFlow')
        setStatus(t('saving'))
        try {
          const flowId = `flow-${Date.now().toString(36)}`
          const response = await fetch(API_FLOWS, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              flow: {
                flowId,
                version: '1.0.0',
                title,
                description: '',
                nodes: [],
                edges: [],
              },
            }),
          })
          const value = await readJson(response)
          if (value.flow) {
            setNewFlowTitle('')
            await openFlow(value.flow.flowId)
            await loadFlows()
          }
        } catch (error) {
          setStatus(`${t('saveError')}: ${error.message}`)
        }
      }

      const importPackageFile = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setStatus(t('saving'))
        try {
          const text = await file.text()
          const parsed = JSON.parse(text)
          const response = await fetch(API_IMPORT_PREVIEW, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ package: parsed }),
          })
          const value = await response.json()
          setImportPreview({ package: parsed, checks: value.checks || [], skillStatus: value.skillStatus || [], summary: value.summary || {} })
          setStatus('')
        } catch (error) {
          setStatus(`${t('loadError')}: ${error.message}`)
        }
      }

      const confirmImport = async () => {
        if (!importPreview?.package) return
        setImportBusy(true)
        setStatus(t('saving'))
        try {
          const response = await fetch(API_IMPORT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ package: importPreview.package }),
          })
          const value = await readJson(response)
          setImportPreview(null)
          await loadFlows()
          if (value.flow) await openFlow(value.flow.flowId)
          setStatus(value.renamed ? t('importedRenamed') : t('saved'))
        } catch (error) {
          setStatus(`${t('loadError')}: ${error.message}`)
        } finally {
          setImportBusy(false)
        }
      }

      const exportFlowById = async (flowId, version) => {
        if (!flowId) return
        setStatus(t('saving'))
        try {
          const response = await fetch(`${API_FLOWS}/${encodeURIComponent(flowId)}/export`, {
            cache: 'no-store',
          })
          const value = await readJson(response)
          const text = JSON.stringify(value.package, null, 2)
          const blob = new Blob([text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `${flowId}-${version || 'latest'}.interflow.json`
          anchor.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          setStatus(t('saved'))
        } catch (error) {
          setStatus(`${t('saveError')}: ${error.message}`)
        }
      }

      const exportFlow = async () => {
        if (!flowMeta) return
        await exportFlowById(flowMeta.flowId, flowMeta.version)
      }

      const renameFlow = async (flowId, currentTitle) => {
        const title = window.prompt(t('renamePrompt'), currentTitle || '')
        if (!title || !title.trim()) return
        setStatus(t('saving'))
        try {
          const response = await fetch(`${API_FLOWS}/${encodeURIComponent(flowId)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: title.trim() }),
          })
          const value = await readJson(response)
          if (flowMeta?.flowId === flowId && value.flow) setFlowMeta(value.flow)
          await loadFlows()
          setStatus(t('renamed'))
        } catch (error) {
          setStatus(`${t('saveError')}: ${error.message}`)
        }
      }

      const runPreflight = async () => {
        if (!flowMeta) return
        setStatus(t('saving'))
        try {
          const response = await fetch(`${API_FLOWS}/${encodeURIComponent(flowMeta.flowId)}/preflight`, {
            cache: 'no-store',
          })
          const value = await response.json()
          setPreflightResult(value)
          setStatus('')
        } catch (error) {
          setStatus(`${t('loadError')}: ${error.message}`)
        }
      }

      const deleteFlow = async (flowId) => {
        if (!window.confirm(t('deleteFlowConfirm'))) return
        setStatus(t('saving'))
        try {
          const response = await fetch(`${API_FLOWS}/${encodeURIComponent(flowId)}`, {
            method: 'DELETE',
          })
          await readJson(response)
          if (flowMeta?.flowId === flowId) {
            setFlowMeta(null)
            setGraphValue(emptyGraph())
            setView('library')
          }
          await loadFlows()
          setStatus(t('deleted'))
        } catch (error) {
          setStatus(`${t('saveError')}: ${error.message}`)
        }
      }

      const graphToFlow = (next) => {
        if (!flowMeta) return null
        return {
          ...flowMeta,
          nodes: next.nodes.map((node) => ({
            nodeId: node.id,
            kind: 'session',
            role: node.role || node.title || `工位 ${node.id}`,
            skillRefs: Array.isArray(node.skillRefs) ? node.skillRefs : [],
            prompt: node.prompt || '',
            outputSpec: node.outputSpec,
            outputSchema: node.outputSchema || {},
            defaultOutputPortId: node.defaultOutputPortId,
            inputPorts: node.inputPorts,
            outputPorts: node.outputPorts,
            layout: { x: node.x, y: node.y },
            sessionPolicy: 'existing',
          })),
          edges: next.edges.map((edge) => ({
            id: edge.id,
            from: edge.from,
            to: edge.to,
            mode: edge.mode,
            order: edge.order,
            instruction: edge.instruction || '',
          })),
        }
      }

      const saveGraph = async (next, successMessage = t('saved')) => {
        setGraphValue(next)
        if (!flowMeta) {
          setStatus(t('saveError'))
          return
        }
        setSaving(true)
        setStatus(t('saving'))
        try {
          const line = graphToFlow(next)
          const flowResponse = await fetch(`${API_FLOWS}/${encodeURIComponent(flowMeta.flowId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ flow: line }),
          })
          const flowValue = await readJson(flowResponse)
          if (flowValue.flow) setFlowMeta(flowValue.flow)
          const bindings = {}
          for (const node of next.nodes) {
            if (!node.sessionId) continue
            bindings[node.id] = {
              sessionId: node.sessionId,
              sessionTitle: node.title || '',
              cwd: node.cwd || '',
            }
          }
          const bindingResponse = await fetch(`${API_FLOWS}/${encodeURIComponent(flowMeta.flowId)}/binding`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              nodes: bindings,
              flowVersion: flowValue.flow?.version || flowMeta.version,
              layoutOverrides: { viewport: next.viewport },
            }),
          })
          await readJson(bindingResponse)
          setStatus(successMessage)
        } catch (error) {
          setStatus(`${t('saveError')}: ${error.message}`)
        } finally {
          setSaving(false)
        }
      }

      const addNode = () => {
        const session = sessions.find((item) => item.id === sessionChoice)
        if (session && graph.nodes.some((node) => node.sessionId === session.id)) {
          setStatus(t('duplicateSession'))
          return
        }
        const index = graph.nodes.length
        const node = {
          id: uid('n_'),
          sessionId: session?.id || '',
          title: session ? labelForSession(session) : t('newWorkstation'),
          cwd: session?.cwd || '',
          prompt: '',
          outputSpec: { mode: 'text', fields: ['x'], maxResults: 3 },
          defaultOutputPortId: 'out_1',
          inputPorts: defaultPorts('in'),
          outputPorts: defaultPorts('out'),
          x: 44 + (index % 4) * 220,
          y: 44 + Math.floor(index / 4) * 132,
        }
        const next = { ...graph, nodes: [...graph.nodes, node] }
        setSessionChoice('')
        void saveGraph(next)
      }

      const deleteNode = (id) => {
        const next = {
          ...graph,
          nodes: graph.nodes.filter((node) => node.id !== id),
          edges: graph.edges.filter((edge) => edge.from.nodeId !== id && edge.to.nodeId !== id),
        }
        setSelectedNode(null)
        setSelectedEdge(null)
        setWireFrom(null)
        void saveGraph(next)
      }

      const deleteEdge = (id) => {
        const next = { ...graph, edges: graph.edges.filter((edge) => edge.id !== id) }
        setSelectedEdge(null)
        void saveGraph(next)
      }

      const createEdge = (fromEndpoint, toEndpoint) => {
        if (!fromEndpoint || !toEndpoint) return
        if (fromEndpoint.nodeId === toEndpoint.nodeId) {
          setStatus(t('selfEdge'))
          return
        }
        if (graph.edges.some((edge) => (
          edge.from.nodeId === fromEndpoint.nodeId &&
          edge.from.portId === fromEndpoint.portId &&
          edge.to.nodeId === toEndpoint.nodeId &&
          edge.to.portId === toEndpoint.portId
        ))) {
          setStatus(t('duplicateEdge'))
          return
        }
        if (wouldCycle(graph, fromEndpoint.nodeId, toEndpoint.nodeId)) {
          setStatus(t('cycle'))
          return
        }
        const edge = {
          id: uid('e_'),
          from: fromEndpoint,
          to: toEndpoint,
          mode: edgeKind,
          order: graph.edges.length,
        }
        const next = { ...graph, edges: [...graph.edges, edge] }
        setWireFrom(null)
        void saveGraph(next)
      }

      const onNodePointerDown = (event, node) => {
        if (mode !== 'node') return
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = {
          id: node.id,
          startX: event.clientX,
          startY: event.clientY,
          originX: node.x,
          originY: node.y,
          moved: false,
          latest: null,
        }
        setSelectedNode(node.id)
        setSelectedEdge(null)
        if (event.currentTarget.setPointerCapture) {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }

      const onNodePointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const zoom = cameraRef.current.zoom
        const dx = (event.clientX - drag.startX) / zoom
        const dy = (event.clientY - drag.startY) / zoom
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => (
            node.id === drag.id
              ? { ...node, x: clamp(drag.originX + dx, 0, CANVAS_W - NODE_W), y: clamp(drag.originY + dy, 0, CANVAS_H - NODE_H) }
              : node
          )),
        }
        drag.latest = next
        setGraphValue(next)
      }

      const onNodePointerUp = (event) => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        if (event.currentTarget.releasePointerCapture) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (drag.moved && drag.latest) {
          suppressClickRef.current = true
          void saveGraph(drag.latest)
        }
      }

      const onNodeClick = (event, node) => {
        event.stopPropagation()
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        if (mode === 'node' || mode === 'wire') {
          if (mode === 'wire') setWireFrom(null)
          setSelectedNode(node.id)
          setSelectedEdge(null)
        }
      }

      const onPortClick = (event, node, port, direction) => {
        event.stopPropagation()
        event.preventDefault()
        if (mode !== 'wire') return
        if (direction === 'out') {
          setWireFrom({ nodeId: node.id, portId: port.id })
          setSelectedNode(node.id)
          setSelectedEdge(null)
          return
        }
        if (!wireFrom) {
          setStatus(t('wireNeedOutput'))
        }
      }

      const onCanvasWheel = (event) => {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const mx = event.clientX - rect.left
        const my = event.clientY - rect.top
        const current = cameraRef.current
        const factor = Math.exp(-event.deltaY * 0.0015)
        const nextZoom = clamp(current.zoom * factor, 0.35, 2.5)
        if (Math.abs(nextZoom - current.zoom) < 0.0001) return
        const worldX = (mx - current.x) / current.zoom
        const worldY = (my - current.y) / current.zoom
        setCameraValue({
          x: mx - worldX * nextZoom,
          y: my - worldY * nextZoom,
          zoom: nextZoom,
        })
        scheduleCameraSave()
      }

      const onCanvasPointerDown = (event) => {
        if (event.button !== 0 && event.button !== 1) return
        if (event.target.closest && (event.target.closest('.sf-node') || event.target.closest('.sf-edge-hit'))) return
        event.preventDefault()
        const current = cameraRef.current
        panRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          originX: current.x,
          originY: current.y,
          moved: false,
        }
        setPanning(true)
        setSelectedNode(null)
        setSelectedEdge(null)
        setWireFrom(null)
        if (event.currentTarget.setPointerCapture) {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }

      const onCanvasPointerMove = (event) => {
        const pan = panRef.current
        if (!pan) return
        const dx = event.clientX - pan.startX
        const dy = event.clientY - pan.startY
        if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true
        setCameraValue({
          x: pan.originX + dx,
          y: pan.originY + dy,
          zoom: cameraRef.current.zoom,
        })
      }

      const onCanvasPointerUp = (event) => {
        const pan = panRef.current
        if (!pan) return
        panRef.current = null
        setPanning(false)
        if (event.currentTarget.releasePointerCapture) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        if (pan.moved) scheduleCameraSave()
      }

      const onResetCamera = () => {
        setCameraValue({ x: 30, y: 30, zoom: 1 })
        scheduleCameraSave()
      }

      const onCanvasClick = () => {
        setSelectedNode(null)
        setSelectedEdge(null)
        setWireFrom(null)
      }

      const selectedEdgeValue = selectedEdge
        ? graph.edges.find((edge) => edge.id === selectedEdge) || null
        : null
      const selectedEdgeDuplicate = Boolean(
        selectedEdgeValue &&
        (selectedEdgeValue.instruction || '').includes('{{input-x}}') &&
        (nodeMap.get(selectedEdgeValue.to.nodeId)?.prompt || '').includes('{{input-x}}')
      )
      const selectedNodeValue = selectedNode
        ? graph.nodes.find((node) => node.id === selectedNode) || null
        : null
      const selectedSkillRefs = Array.isArray(selectedNodeValue?.skillRefs) ? selectedNodeValue.skillRefs : []
      const skillRefInfo = (ref) => {
        const base = String(ref || '').split('@')[0]
        const slash = base.indexOf('/')
        return slash > 0
          ? { provider: base.slice(0, slash), name: base.slice(slash + 1) }
          : { provider: '', name: base }
      }
      const skillName = (ref) => skillRefInfo(ref).name
      const skillRefMatches = (skill, ref) => {
        const info = skillRefInfo(ref)
        return info.name === skill.name && (!info.provider || info.provider === skill.provider)
      }
      const missingSkillRefs = (node) => {
        if (!skillsLoaded) return []
        return (Array.isArray(node?.skillRefs) ? node.skillRefs : [])
          .filter((ref) => !skills.some((skill) => skillRefMatches(skill, ref)))
      }
      const missingSelectedSkills = selectedNodeValue && !skillsLoading
        ? selectedSkillRefs.filter((ref) => !skills.some((skill) => skillRefMatches(skill, ref)))
        : []
      const filteredSkills = skills.filter((skill) => {
        const needle = skillQuery.trim().toLowerCase()
        if (!needle) return true
        return `${skill.name} ${skill.description} ${skill.source} ${skill.provider}`.toLowerCase().includes(needle)
      })

      const updateNodePrompt = (nodeId, value) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => (
            node.id === nodeId ? { ...node, prompt: value } : node
          )),
        }
        setGraphValue(next)
      }

      const commitNodePrompt = () => {
        void saveGraph(graphRef.current)
      }

      const bindNodeSession = (nodeId, sessionId) => {
        const session = sessions.find((item) => item.id === sessionId)
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => (
            node.id === nodeId && session
              ? { ...node, sessionId: session.id, title: labelForSession(session), cwd: session.cwd || '' }
              : node
          )),
        }
        void saveGraph(next)
      }

      const unbindNodeSession = (nodeId) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => (
            node.id === nodeId ? { ...node, sessionId: '' } : node
          )),
        }
        void saveGraph(next)
      }

      const toggleNodeSkill = (nodeId, ref) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => {
            if (node.id !== nodeId) return node
            const current = Array.isArray(node.skillRefs) ? node.skillRefs : []
            const skillRefs = current.includes(ref)
              ? current.filter((item) => item !== ref)
              : [...current, ref]
            return { ...node, skillRefs }
          }),
        }
        void saveGraph(next)
      }

      const selectAllNodeSkills = (nodeId) => {
        const keys = filteredSkills.map((skill) => skill.id || skill.name)
        const current = selectedSkillRefs
        const allSelected = keys.length > 0 && keys.every((key) => current.includes(key))
        const nextRefs = allSelected
          ? current.filter((ref) => !keys.includes(ref))
          : [...new Set([...current, ...keys])]
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => (
            node.id === nodeId ? { ...node, skillRefs: nextRefs } : node
          )),
        }
        void saveGraph(next)
      }

      const addNodePort = (nodeId, direction) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => {
            if (node.id !== nodeId) return node
            const key = direction === 'in' ? 'inputPorts' : 'outputPorts'
            const ports = [...(node[key] || defaultPorts(direction))]
            if (ports.length >= 3) return node
            let number = 1
            while (ports.some((port) => port.id === `${direction === 'in' ? 'in' : 'out'}_${number}`)) number += 1
            ports.push({
              id: `${direction === 'in' ? 'in' : 'out'}_${number}`,
              label: `${direction === 'in' ? 'IN' : 'OUT'}${number}`,
              policy: direction === 'in' ? 'each' : 'all',
            })
            return { ...node, [key]: ports }
          }),
        }
        setGraphValue(next)
        void saveGraph(next)
      }

      const removeNodePort = (nodeId, direction, portId) => {
        const used = graphRef.current.edges.some((edge) => (
          (edge.from.nodeId === nodeId && edge.from.portId === portId) ||
          (edge.to.nodeId === nodeId && edge.to.portId === portId)
        ))
        if (used) {
          setStatus(t('portInUse'))
          return
        }
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => {
            if (node.id !== nodeId) return node
            const key = direction === 'in' ? 'inputPorts' : 'outputPorts'
            const ports = node[key] || defaultPorts(direction)
            if (ports.length <= 1) return node
            const remaining = ports.filter((port) => port.id !== portId)
            const next = { ...node, [key]: remaining }
            if (direction === 'out' && defaultOutputPortOf(node) === portId) {
              next.defaultOutputPortId = remaining[0].id
            }
            return next
          }),
        }
        setGraphValue(next)
        void saveGraph(next)
      }

      const updateNodePortPolicy = (nodeId, direction, portId, policy) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => {
            if (node.id !== nodeId) return node
            const key = direction === 'in' ? 'inputPorts' : 'outputPorts'
            const ports = node[key] || defaultPorts(direction)
            return {
              ...node,
              [key]: ports.map((port) => (port.id === portId ? { ...port, policy } : port)),
            }
          }),
        }
        setGraphValue(next)
        void saveGraph(next)
      }

      const updateNodeOutputSpec = (nodeId, patch) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => {
            if (node.id !== nodeId) return node
            return { ...node, outputSpec: { ...outputSpecOf(node), ...patch } }
          }),
        }
        setGraphValue(next)
        void saveGraph(next)
      }

      const updateNodeDefaultOutputPort = (nodeId, portId) => {
        const next = {
          ...graphRef.current,
          nodes: graphRef.current.nodes.map((node) => (
            node.id === nodeId ? { ...node, defaultOutputPortId: portId } : node
          )),
        }
        setGraphValue(next)
        void saveGraph(next)
      }

      const updateEdgeInstruction = (edgeId, value) => {
        const next = {
          ...graphRef.current,
          edges: graphRef.current.edges.map((edge) => (
            edge.id === edgeId ? { ...edge, instruction: value } : edge
          )),
        }
        setGraphValue(next)
      }

      const commitEdgeInstruction = () => {
        void saveGraph(graphRef.current)
      }

      const renderOutputSpecEditor = (node) => {
        const spec = outputSpecOf(node)
        return h('div', { className: 'sf-output-spec' },
          h('label', { className: 'sf-label' }, t('outputFormat')),
          h('select', {
            className: 'sf-select',
            value: spec.mode,
            onChange: (event) => updateNodeOutputSpec(node.id, { mode: event.target.value }),
          },
            h('option', { value: 'text' }, t('outputText')),
            h('option', { value: 'json' }, t('outputJson'))
          ),
          h('label', { className: 'sf-label' }, t('defaultOutputPort')),
          h('select', {
            className: 'sf-select',
            value: defaultOutputPortOf(node),
            onChange: (event) => updateNodeDefaultOutputPort(node.id, event.target.value),
          },
            ...outputPortsOf(node).map((port) => h('option', { key: port.id, value: port.id }, port.label))
          ),
          h('div', { className: 'sf-hint' }, t('defaultOutputHint')),
          spec.mode === 'json'
            ? h('div', null,
              h('div', { className: 'sf-port-row' },
                h('span', { className: 'sf-port-name' }, t('maxResults')),
                h('input', {
                  className: 'sf-input sf-number',
                  type: 'number',
                  min: 1,
                  max: 10,
                  value: spec.maxResults,
                  onChange: (event) => updateNodeOutputSpec(node.id, {
                    maxResults: Math.min(10, Math.max(1, Number(event.target.value) || 1)),
                  }),
                })
              ),
              h('div', { className: 'sf-field-row' },
                ['x', 'y', 'z'].map((field) => h('label', { key: field, className: 'sf-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: spec.fields.includes(field),
                    disabled: field === 'x',
                    onChange: (event) => {
                      const fields = event.target.checked
                        ? [...new Set([...spec.fields, field])].slice(0, 3)
                        : spec.fields.filter((item) => item !== field)
                      updateNodeOutputSpec(node.id, { fields: fields.includes('x') ? fields : ['x', ...fields] })
                    },
                  }),
                  field
                ))
              )
            )
            : null
        )
      }

      const renderPortsEditor = (node) => {
        const groups = [
          { direction: 'in', key: 'inputPorts', title: t('inputPorts') },
          { direction: 'out', key: 'outputPorts', title: t('outputPorts') },
        ]
        return h('div', { className: 'sf-ports-editor' },
          ...groups.map((group) => {
            const ports = node[group.key] || defaultPorts(group.direction)
            return h('div', { key: group.direction, className: 'sf-port-group' },
              h('label', { className: 'sf-label' }, group.title),
              ...ports.map((port) => h('div', { key: port.id, className: 'sf-port-row' },
                h('span', { className: 'sf-port-name' }, port.label),
                h('select', {
                  className: 'sf-select sf-port-policy',
                  value: port.policy,
                  onChange: (event) => updateNodePortPolicy(node.id, group.direction, port.id, event.target.value),
                },
                  group.direction === 'in'
                    ? [
                      h('option', { key: 'each', value: 'each' }, t('inputEach')),
                      h('option', { key: 'all', value: 'all' }, t('inputAll')),
                    ]
                    : [
                      h('option', { key: 'all', value: 'all' }, t('outputAll')),
                      h('option', { key: 'roundRobin', value: 'roundRobin' }, t('outputRoundRobin')),
                    ]
                ),
                h('button', {
                  className: 'sf-port-remove',
                  type: 'button',
                  disabled: ports.length <= 1,
                  title: t('removePort'),
                  onClick: () => removeNodePort(node.id, group.direction, port.id),
                }, '−')
              )),
              h('button', {
                className: 'sf-btn sf-add-port',
                type: 'button',
                disabled: ports.length >= 3,
                onClick: () => addNodePort(node.id, group.direction),
              }, `+ ${group.title}`)
            )
          })
        )
      }

      const executeRun = async () => {
        if (!startNodeId) {
          setRunError(t('selectStartNode'))
          return
        }
        setRunBusy(true)
        setRunError('')
        try {
          const response = await fetch(API_RUN, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              graph: graphRef.current,
              input: runInput,
              startNodeId,
              flowId: flowMeta?.flowId || '',
              flowVersion: flowMeta?.version || '',
            }),
          })
          const value = await readJson(response)
          setRun(value.run || null)
          void loadRunHistory()
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      const startRun = () => {
        if (!startNodeId) {
          setRunError(t('selectStartNode'))
          return
        }
        const warnings = duplicateInputWarnings(graphRef.current)
        if (warnings.length) {
          setRunWarning(warnings)
          return
        }
        setRunWarning(null)
        void executeRun()
      }

      const stopRun = async () => {
        setRunBusy(true)
        setRunError('')
        try {
          const response = await fetch(API_RUN_STOP, { method: 'POST' })
          const value = await readJson(response)
          if (value.run) setRun(value.run)
          void loadRunHistory()
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      const renderImportPreview = () => {
        if (!importPreview) return null
        const errors = (importPreview.checks || []).filter((item) => item.status === 'error')
        const skillIssues = (importPreview.skillStatus || []).filter((item) => item.status !== 'pass')
        return h('div', {
          className: 'sf-modal-backdrop',
          onClick: () => { if (!importBusy) setImportPreview(null) },
        },
          h('div', { className: 'sf-modal', onClick: (event) => event.stopPropagation() },
            h('div', { className: 'sf-modal-title' }, t('importPreview')),
            h('div', { className: 'sf-hint' },
              `${importPreview.summary.title || importPreview.summary.flowId || '-'} · ` +
              `${importPreview.summary.flowId || '-'}@${importPreview.summary.flowVersion || '-'} · ` +
              `${importPreview.summary.nodeCount || 0} ${t('nodes')} · ${importPreview.summary.skillCount || 0} Skill`),
            errors.length
              ? h('div', { className: 'sf-warning' }, `${t('importErrors')}: ${errors.length}`)
              : h('div', { className: 'sf-hint' }, t('importChecksPass')),
            h('div', { className: 'sf-import-checks' },
              ...(importPreview.checks || []).filter((item) => item.status !== 'pass').slice(0, 12).map((item) => (
                h('div', { key: item.id, className: item.status === 'error' ? 'sf-warning' : 'sf-hint' },
                  `${item.status}: ${item.id}`)
              )),
              ...skillIssues.slice(0, 12).map((item) => h('div', {
                key: `skill-${item.id}`,
                className: item.status === 'error' ? 'sf-warning' : 'sf-hint',
              }, `${item.status}: ${item.id}`))
            ),
            h('div', { className: 'sf-mode-row' },
              h('button', {
                className: 'sf-btn',
                type: 'button',
                disabled: importBusy,
                onClick: () => setImportPreview(null),
              }, t('cancel')),
              h('button', {
                className: 'sf-btn sf-btn-primary',
                type: 'button',
                disabled: importBusy || errors.length > 0,
                onClick: confirmImport,
              }, importBusy ? t('saving') : t('confirmImport'))
            )
          )
        )
      }

      if (view === 'library') {
        return h('div', {
          className: `sf-root sf-theme-${theme}`,
          style: { display: 'block', overflow: 'auto' },
        },
          h('style', null, CSS),
          h('div', { className: 'sf-library' },
            h('div', { className: 'sf-library-head' },
              h('h1', null, t('library')),
              h('div', { className: 'sf-hint' }, t('libraryHint'))
            ),
            h('div', { className: 'sf-library-actions' },
              h('input', {
                type: 'text',
                value: newFlowTitle,
                placeholder: t('flowName'),
                onInput: (event) => setNewFlowTitle(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void createFlow()
                },
              }),
              h('button', { className: 'sf-btn sf-primary', type: 'button', onClick: createFlow },
                t('newFlow')),
              h('button', { className: 'sf-btn', type: 'button', onClick: loadFlows },
                t('refresh')),
              h('button', {
                className: 'sf-btn',
                type: 'button',
                onClick: () => fileInputRef.current?.click?.(),
              }, t('importFlow')),
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: '.json,.interflow.json,application/json',
                style: { display: 'none' },
                onChange: importPackageFile,
              }),
              h('div', { className: 'sf-lang-row' },
                h('button', {
                  className: `sf-lang ${language === 'zh' ? 'is-active' : ''}`,
                  type: 'button',
                  onClick: () => onLanguageChange('zh'),
                }, '中文'),
                h('button', {
                  className: `sf-lang ${language === 'en' ? 'is-active' : ''}`,
                  type: 'button',
                  onClick: () => onLanguageChange('en'),
                }, 'EN')
              )
            ),
            libraryError ? h('div', { className: 'sf-error' }, libraryError) : null,
            status ? h('div', { className: 'sf-status' }, status) : null,
            flowsLoading
              ? h('div', { className: 'sf-library-empty' }, t('loading'))
              : flows.length
                ? h('div', { className: 'sf-library-list' },
                  ...flows.map((line) => h('div', {
                    key: line.flowId,
                    className: 'sf-flow-card',
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => {
                      setMenuFlowId(null)
                      void openFlow(line.flowId)
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') void openFlow(line.flowId)
                    },
                  },
                    h('div', { className: 'sf-flow-card-main' },
                      h('div', { className: 'sf-flow-card-title' }, line.title || line.flowId),
                      h('div', { className: 'sf-flow-card-meta' },
                        `${t('flowVersion')} ${line.version} · ${line.nodeCount} ${t('nodes')} · ${line.edgeCount} ${t('edges')}`),
                      line.description ? h('div', { className: 'sf-flow-card-meta' }, line.description) : null
                    ),
                    h('div', { className: 'sf-flow-card-badge' },
                      line.boundCount ? `${line.boundCount}/${line.nodeCount} ${t('bound')}` : t('unbound')),
                    h('div', { className: 'sf-flow-card-badge' }, line.flowId),
                    h('div', { className: 'sf-flow-actions' },
                      h('button', {
                        className: 'sf-flow-gear',
                        type: 'button',
                        title: t('moreActions'),
                        'aria-label': t('moreActions'),
                        'aria-haspopup': 'menu',
                        'aria-expanded': menuFlowId === line.flowId ? 'true' : 'false',
                        onClick: (event) => {
                          event.stopPropagation()
                          setMenuFlowId((current) => current === line.flowId ? null : line.flowId)
                        },
                      }, '⚙'),
                      menuFlowId === line.flowId ? h('div', {
                        className: 'sf-flow-menu',
                        role: 'menu',
                        onClick: (event) => event.stopPropagation(),
                      },
                        h('button', {
                          className: 'sf-flow-menu-item',
                          type: 'button',
                          role: 'menuitem',
                          onClick: () => {
                            setMenuFlowId(null)
                            void renameFlow(line.flowId, line.title)
                          },
                        }, t('renameFlow')),
                        h('button', {
                          className: 'sf-flow-menu-item',
                          type: 'button',
                          role: 'menuitem',
                          onClick: () => {
                            setMenuFlowId(null)
                            void exportFlowById(line.flowId, line.version)
                          },
                        }, t('exportFlow')),
                        h('button', {
                          className: 'sf-flow-menu-item sf-flow-menu-danger',
                          type: 'button',
                          role: 'menuitem',
                          onClick: () => {
                            setMenuFlowId(null)
                            void deleteFlow(line.flowId)
                          },
                        }, t('deleteFlow'))
                      ) : null
                    )
                  ))
                )
                : h('div', { className: 'sf-library-empty' }, t('noFlows'))
          ),
          renderImportPreview()
        )
      }

      return h('div', { className: `sf-root sf-theme-${theme}` },
        h('style', null, CSS),
        h('aside', { className: 'sf-side' },
          flowMeta ? h('button', {
            className: 'sf-side-btn sf-side-btn-primary sf-back-top',
            type: 'button',
            onClick: () => {
              setView('library')
              void loadFlows()
            },
          }, `← ${t('backToLibrary')}`) : null,
          h('div', { className: 'sf-brand' },
            h('div', { className: 'sf-brand-title' }, flowMeta?.title || t('title')),
            h('div', { className: 'sf-brand-sub' }, flowMeta ? `${t('flowVersion')} ${flowMeta.version}` : t('positionHint')),
            flowMeta ? h('div', { className: 'sf-brand-actions' },
              h('button', {
                className: 'sf-side-btn',
                type: 'button',
                onClick: () => void runPreflight(),
              }, t('preflight')),
              h('button', {
                className: 'sf-side-btn',
                type: 'button',
                onClick: () => void renameFlow(flowMeta.flowId, flowMeta.title),
              }, t('renameFlow')),
              h('button', {
                className: 'sf-side-btn',
                type: 'button',
                onClick: exportFlow,
              }, `${t('exportFlow')} .interflow.json`)
            ) : null
          ),
          h('section', { className: 'sf-theme-picker' },
            h('label', { className: 'sf-label' }, t('theme')),
            h('div', { className: 'sf-theme-row' },
              ...THEMES.map((id) => h('button', {
                key: id,
                className: `sf-swatch sf-swatch-${id} ${theme === id ? 'is-active' : ''}`,
                type: 'button',
                title: t(`theme_${id}`),
                'aria-label': t(`theme_${id}`),
                onClick: () => setTheme(id),
              }))
            ),
            h('div', { className: 'sf-lang-row' },
              h('button', {
                className: `sf-lang ${language === 'zh' ? 'is-active' : ''}`,
                type: 'button',
                onClick: () => onLanguageChange('zh'),
              }, '中文'),
              h('button', {
                className: `sf-lang ${language === 'en' ? 'is-active' : ''}`,
                type: 'button',
                onClick: () => onLanguageChange('en'),
              }, 'EN')
            )
          ),
          h('section', { className: 'sf-section' },
            h('div', { className: 'sf-mode-row' },
              h('button', {
                className: `sf-mode ${mode === 'node' ? 'is-active' : ''}`,
                type: 'button',
                onClick: () => { setMode('node'); setWireFrom(null) },
              }, t('nodeMode')),
              h('button', {
                className: `sf-mode ${mode === 'wire' ? 'is-active' : ''}`,
                type: 'button',
                onClick: () => { setMode('wire'); setWireFrom(null) },
              }, t('wireMode')),
              h('button', {
                className: `sf-mode ${mode === 'run' ? 'is-active' : ''}`,
                type: 'button',
                onClick: () => { setMode('run'); setWireFrom(null) },
              }, t('runMode'))
            ),
            h('div', { className: 'sf-hint' }, mode === 'wire' ? t('wireHint') : mode === 'run' ? t('runModeHint') : t('positionHint'))
          ),
          mode === 'node'
            ? h('section', { className: 'sf-section' },
              h('label', { className: 'sf-label' }, t('addNode')),
              h('input', {
                className: 'sf-input',
                value: sessionFilter,
                placeholder: t('searchSessions'),
                onChange: (event) => setSessionFilter(event.target.value),
              }),
              h('select', {
                className: 'sf-select',
                value: sessionChoice,
                onChange: (event) => setSessionChoice(event.target.value),
              },
                h('option', { value: '' }, t('selectSession')),
                ...visibleSessions.map((session) => h('option', { key: session.id, value: session.id }, labelForSession(session)))
              ),
              h('div', { className: 'sf-hint' }, loading ? t('loadingSessions') : `${visibleSessions.length} / ${sessions.length} ${t('sessions')}`),
              sessionsError
                ? h('div', { className: 'sf-error-row' },
                  h('span', { className: 'sf-error' }, `${t('loadSessionsError')}: ${sessionsError}`),
                  h('button', {
                    className: 'sf-btn',
                    type: 'button',
                    onClick: () => setSessionReload((value) => value + 1),
                  }, t('retry'))
                )
                : null,
              h('button', {
                className: 'sf-btn sf-btn-primary',
                type: 'button',
                disabled: saving,
                onClick: addNode,
              }, t('add'))
            )
            : mode === 'wire'
              ? h('section', { className: 'sf-section' },
              h('label', { className: 'sf-label' }, t('edgeType')),
              h('div', { className: 'sf-mode-row' },
                h('button', {
                  className: `sf-mode ${edgeKind === 'hard' ? 'is-active' : ''}`,
                  type: 'button',
                  onClick: () => setEdgeKind('hard'),
                }, t('hardEdge')),
                h('button', {
                  className: `sf-mode ${edgeKind === 'returnable' ? 'is-active' : ''}`,
                  type: 'button',
                  onClick: () => setEdgeKind('returnable'),
                }, t('returnableEdge'))
              ),
              h('div', { className: 'sf-hint' }, t('edgeTypeHint'))
            )
              : null,
          h('section', { className: 'sf-section sf-stats' },
            h('span', null, `${t('nodes')} ${graph.nodes.length}`),
            h('span', null, `${t('edges')} ${graph.edges.length}`),
            h('span', { className: 'sf-zoom-value' }, `${Math.round(camera.zoom * 100)}%`),
            h('button', {
              className: 'sf-btn sf-zoom-btn',
              type: 'button',
              onClick: onResetCamera,
              title: t('resetView'),
            }, t('resetView'))
          ),
          mode === 'run'
            ? h('section', { className: 'sf-section sf-run-box' },
            h('label', { className: 'sf-label' }, t('startNode')),
            h('select', {
              className: 'sf-select',
              value: startNodeId,
              disabled: !graph.nodes.length,
              onChange: (event) => {
                setStartNodeId(event.target.value)
                setStartTouched(true)
              },
            },
              graph.nodes.length === 0
                ? h('option', { value: '' }, t('noNodesShort'))
                : graph.nodes.map((node) => h('option', { key: node.id, value: node.id }, node.title || node.sessionId.slice(-8)))
            ),
            h('div', { className: 'sf-hint' }, t('startNodeHint')),
            h('label', { className: 'sf-label' }, t('runInput')),
            h('textarea', {
              className: 'sf-textarea',
              value: runInput,
              placeholder: t('runInputHint'),
              onChange: (event) => setRunInput(event.target.value),
            }),
            h('div', { className: 'sf-mode-row' },
              h('button', {
                className: 'sf-btn sf-btn-primary',
                type: 'button',
                disabled: runBusy || !graph.nodes.length || (run && (run.status === 'running' || run.status === 'stopping')),
                onClick: startRun,
              }, t('run')),
              run && (run.status === 'running' || run.status === 'stopping')
                ? h('button', { className: 'sf-btn sf-danger', type: 'button', disabled: runBusy, onClick: stopRun }, t('stop'))
                : null
            ),
            runError ? h('div', { className: 'sf-error' }, runError) : null,
            run
              ? h('div', { className: 'sf-run-status' },
                h('div', { className: `sf-run-title sf-run-${run.status}` }, `${t('runStatus')}: ${statusText(run.status)}`),
                run.error ? h('div', { className: 'sf-error' }, run.error) : null,
                ...Object.values(run.nodes || {}).map((nodeRun) => h('div', { key: nodeRun.jobId || `${nodeRun.nodeId}-${nodeRun.startedAt}`, className: 'sf-run-node-block' },
                  h('div', { className: 'sf-run-node' },
                    h('span', null, `${nodeRun.title || nodeRun.nodeId}${nodeRun.inputPortId ? ` · ${nodeRun.inputPortId}` : ''}`),
                    h('span', { className: `sf-run-node-status sf-run-${nodeRun.status}` }, statusText(nodeRun.status))
                  ),
                  (nodeRun.status === 'error' || nodeRun.status === 'stopped')
                    ? h('button', {
                      className: 'sf-btn',
                      type: 'button',
                      disabled: runBusy,
                      onClick: () => {
                        if (window.confirm(t('retryConfirm'))) void retryRunNode(nodeRun.jobId)
                      },
                    }, t('retryNode'))
                    : null,
                  nodeRun.output
                    ? h('div', { className: 'sf-run-output' }, nodeRun.output.length > 240 ? `${nodeRun.output.slice(0, 240)}…` : nodeRun.output)
                    : null
                ))
              )
              : null,
            h('label', { className: 'sf-label' }, t('runHistory')),
            runHistory.length
              ? h('div', { className: 'sf-run-history' },
                ...runHistory.slice(0, 6).map((item) => h('div', {
                  key: item.id,
                  className: 'sf-run-history-item',
                },
                  h('button', {
                    className: 'sf-run-history-open',
                    type: 'button',
                    onClick: () => void openRunHistory(item.id),
                  },
                    h('span', null, `${item.flowId || item.id} · ${statusText(item.status)}`),
                    h('span', { className: 'sf-hint' }, new Date(item.startedAt).toLocaleString())
                  ),
                  h('div', { className: 'sf-run-history-actions' },
                    item.resumable || item.status === 'running' || item.status === 'interrupted'
                      ? h('button', {
                        className: 'sf-btn',
                        type: 'button',
                        disabled: runBusy,
                        onClick: () => void resumeRun(item.id),
                      }, t('resumeRun'))
                      : null,
                    item.status === 'running' || item.status === 'interrupted' || item.status === 'stopped' || item.status === 'error'
                      ? h('button', {
                        className: 'sf-btn',
                        type: 'button',
                        onClick: () => void reconcileRun(item.id),
                      }, t('checkActive'))
                      : null
                  )
                ))
              )
              : h('div', { className: 'sf-hint' }, t('noRunHistory'))
          )
            : null,
          mode !== 'run'
            ? h('section', { className: 'sf-section sf-inspector' },
            selectedNodeValue
              ? h('div', null,
                h('div', { className: 'sf-inspector-title' }, selectedNodeValue.title || t('boundSession')),
                h('label', { className: 'sf-label' }, t('bindSession')),
                h('select', {
                  className: 'sf-select',
                  value: selectedNodeValue.sessionId || '',
                  onChange: (event) => {
                    if (event.target.value) bindNodeSession(selectedNodeValue.id, event.target.value)
                    else unbindNodeSession(selectedNodeValue.id)
                  },
                },
                  h('option', { value: '' }, t('unbound')),
                  ...visibleSessions.map((session) => h('option', {
                    key: session.id,
                    value: session.id,
                  }, labelForSession(session)))
                ),
                selectedNodeValue.sessionId
                  ? h('button', {
                    className: 'sf-btn',
                    type: 'button',
                    onClick: () => unbindNodeSession(selectedNodeValue.id),
                  }, t('unbindSession'))
                  : null,
                h('div', { className: 'sf-skill-head' },
                  h('button', {
                    className: 'sf-skill-toggle',
                    type: 'button',
                    onClick: () => setSkillsOpen((value) => !value),
                  }, `${t('skills')} (${selectedSkillRefs.length}) ${skillsOpen ? '▴' : '▾'}`),
                  h('button', {
                    className: 'sf-btn sf-skill-all',
                    type: 'button',
                    onClick: () => selectAllNodeSkills(selectedNodeValue.id),
                  }, t('selectAllSkills'))
                ),
                selectedSkillRefs.length
                  ? h('div', { className: 'sf-skill-chips' },
                    ...selectedSkillRefs.map((ref) => h('button', {
                      key: ref,
                      className: 'sf-skill-chip',
                      type: 'button',
                      title: t('removeSkill'),
                      onClick: () => toggleNodeSkill(selectedNodeValue.id, ref),
                    }, `${missingSelectedSkills.includes(ref) ? '! ' : ''}${ref} ×`))
                  )
                  : h('div', { className: 'sf-hint' }, t('noSkillsSelected')),
                missingSelectedSkills.length
                  ? h('div', { className: 'sf-warning' }, `${t('missingSkill')}: ${missingSelectedSkills.join(', ')}`)
                  : null,
                skillsOpen
                  ? h('div', { className: 'sf-skill-panel' },
                    h('input', {
                      className: 'sf-input',
                      type: 'text',
                      value: skillQuery,
                      placeholder: t('searchSkills'),
                      onChange: (event) => setSkillQuery(event.target.value),
                    }),
                    skillsLoading
                      ? h('div', { className: 'sf-hint' }, t('detectingSkills'))
                      : h('div', { className: 'sf-skill-list' },
                        ...filteredSkills.slice(0, 40).map((skill) => h('label', {
                          key: `${skill.provider}:${skill.name}`,
                          className: 'sf-skill-option',
                        },
                          h('input', {
                            type: 'checkbox',
                            checked: selectedSkillRefs.some((ref) => skillRefMatches(skill, ref)),
                            onChange: () => toggleNodeSkill(selectedNodeValue.id, skill.id || skill.name),
                          }),
                          h('span', { className: 'sf-skill-option-name' }, skill.name),
                          h('span', { className: 'sf-skill-option-scope' }, skill.scope)
                        )),
                        filteredSkills.length ? null : h('div', { className: 'sf-hint' }, t('noSkillsFound'))
                      )
                  )
                  : null,
                h('label', { className: 'sf-label' }, t('nodePrompt')),
                h('textarea', {
                  className: 'sf-textarea',
                  value: selectedNodeValue.prompt || '',
                  placeholder: t('nodePromptHint'),
                  onChange: (event) => updateNodePrompt(selectedNodeValue.id, event.target.value),
                  onBlur: commitNodePrompt,
                }),
                renderOutputSpecEditor(selectedNodeValue),
                renderPortsEditor(selectedNodeValue),
                h('div', { className: 'sf-hint' }, t('boundSession')),
                h('button', { className: 'sf-btn sf-danger', type: 'button', onClick: () => deleteNode(selectedNodeValue.id) }, t('deleteNode'))
              )
              : selectedEdgeValue
                ? h('div', null,
                  h('div', { className: 'sf-inspector-title' }, t('edgeType')),
                  h('div', { className: 'sf-hint' }, selectedEdgeValue.mode === 'returnable' ? t('returnableEdge') : t('hardEdge')),
                  h('label', { className: 'sf-label' }, t('edgeInstruction')),
                  h('textarea', {
                    className: 'sf-textarea',
                    value: selectedEdgeValue.instruction || '',
                    placeholder: t('edgeInstructionHint'),
                    onChange: (event) => updateEdgeInstruction(selectedEdgeValue.id, event.target.value),
                    onBlur: commitEdgeInstruction,
                  }),
                  selectedEdgeDuplicate
                    ? h('div', { className: 'sf-warning' }, t('duplicateInputWarning'))
                    : null,
                  h('button', { className: 'sf-btn sf-danger', type: 'button', onClick: () => deleteEdge(selectedEdgeValue.id) }, t('deleteEdge'))
                )
                : h('div', { className: 'sf-hint' }, t('noSelection'))
          )
            : null,
          h('div', { className: 'sf-status' }, status || (saving ? t('saving') : t('saved')))
        ),
        h('main', { className: 'sf-main' },
          h('div', {
            ref: viewportRef,
            className: `sf-viewport ${panning ? 'is-panning' : ''}`,
            onWheel: onCanvasWheel,
            onPointerDown: onCanvasPointerDown,
            onPointerMove: onCanvasPointerMove,
            onPointerUp: onCanvasPointerUp,
            onPointerCancel: onCanvasPointerUp,
            onClick: onCanvasClick,
          },
            h('div', {
              className: 'sf-canvas',
              style: {
                width: CANVAS_W,
                height: CANVAS_H,
                transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
              },
            },
            h('svg', {
              ref: svgRef,
              className: 'sf-edges',
              width: CANVAS_W,
              height: CANVAS_H,
              viewBox: `0 0 ${CANVAS_W} ${CANVAS_H}`,
            },
              h('defs', null,
                h('marker', { id: 'sf-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
                  h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-brand-primary)' })
                )
              ),
              wireFrom && wirePointer && nodeMap.get(wireFrom.nodeId)
                ? h('path', {
                  className: 'sf-wire-preview',
                  d: pathOf(
                    portPoint(nodeMap.get(wireFrom.nodeId), wireFrom.portId, 'out'),
                    wirePointer
                  ),
                })
                : null,
              ...graph.edges.map((edge) => {
                const fromNode = nodeMap.get(edge.from.nodeId)
                const toNode = nodeMap.get(edge.to.nodeId)
                if (!fromNode || !toNode) return null
                const d = pathOf(
                  portPoint(fromNode, edge.from.portId, 'out'),
                  portPoint(toNode, edge.to.portId, 'in')
                )
                const selected = selectedEdge === edge.id
                return h('g', { key: edge.id },
                  h('path', {
                    className: `sf-edge-line ${edge.mode === 'returnable' ? 'sf-edge-returnable' : ''}`,
                    d,
                    markerEnd: 'url(#sf-arrow)',
                  }),
                  h('path', {
                    className: `sf-edge-hit ${selected ? 'is-selected' : ''}`,
                    d,
                    onClick: (event) => {
                      event.stopPropagation()
                      setSelectedEdge(edge.id)
                      setSelectedNode(null)
                    },
                  })
                )
              }),
              wireFrom && nodeMap.get(wireFrom.nodeId)
                ? (() => {
                  const sourceNode = nodeMap.get(wireFrom.nodeId)
                  const point = portPoint(sourceNode, wireFrom.portId, 'out')
                  return h('circle', { cx: point.x, cy: point.y, r: 5, className: 'sf-wire-dot' })
                })()
                : null
            ),
            ...graph.nodes.map((node) => h('div', {
              key: node.id,
              className: `sf-node ${selectedNode === node.id ? 'is-selected' : ''} ${wireFrom?.nodeId === node.id ? 'is-wire-source' : ''}`,
              style: { left: node.x, top: node.y, width: NODE_W, height: NODE_H },
              onPointerDown: (event) => onNodePointerDown(event, node),
              onPointerMove: onNodePointerMove,
              onPointerUp: onNodePointerUp,
              onClick: (event) => onNodeClick(event, node),
            },
              h('div', { className: 'sf-node-kicker' }, t('boundSession')),
              h('div', { className: 'sf-node-title' }, node.title || (node.sessionId || '').slice(-8) || t('unbound')),
              h('div', { className: 'sf-node-flags' },
                !node.sessionId ? h('span', { className: 'sf-node-flag sf-node-flag-warn' }, `! ${t('unbound')}`) : null,
                missingSkillRefs(node).length
                  ? h('span', { className: 'sf-node-flag sf-node-flag-warn' }, `! Skill ${missingSkillRefs(node).length}`)
                  : null,
                Array.isArray(node.skillRefs) && node.skillRefs.length
                  ? h('span', { className: 'sf-node-flag sf-node-flag-skill' }, `Skill ${node.skillRefs.length}`)
                  : null
              ),
              ...inputPortsOf(node).map((port, index) => h('div', {
                key: port.id,
                className: 'sf-port sf-port-in',
                'data-node-id': node.id,
                'data-port-id': port.id,
                style: { top: `${((index + 1) / (inputPortsOf(node).length + 1)) * 100}%` },
                title: `${port.label} · ${port.policy}`,
                onPointerDown: (event) => event.stopPropagation(),
                onClick: (event) => onPortClick(event, node, port, 'in'),
              })),
              ...outputPortsOf(node).map((port, index) => h('div', {
                key: port.id,
                className: `sf-port sf-port-out ${wireFrom?.nodeId === node.id && wireFrom.portId === port.id ? 'is-wire-source' : ''}`,
                'data-node-id': node.id,
                'data-port-id': port.id,
                style: { top: `${((index + 1) / (outputPortsOf(node).length + 1)) * 100}%` },
                title: `${port.label} · ${port.policy}`,
                onPointerDown: (event) => event.stopPropagation(),
                onClick: (event) => onPortClick(event, node, port, 'out'),
              }))
            )),
            graph.nodes.length === 0
              ? h('div', { className: 'sf-empty' }, t('noNodes'))
              : null
          )
        )
      ),
        runWarning
          ? h('div', {
            className: 'sf-modal-backdrop',
            onClick: () => setRunWarning(null),
          },
            h('div', {
              className: 'sf-modal',
              onClick: (event) => event.stopPropagation(),
            },
              h('div', { className: 'sf-modal-title' }, t('duplicateWarningTitle')),
              h('div', { className: 'sf-modal-text' }, t('duplicateInputWarning')),
              ...runWarning.map((warning) => h('div', {
                key: warning.edgeId,
                className: 'sf-warning',
              }, `${warning.from} → ${warning.to}`)),
              h('div', { className: 'sf-mode-row' },
                h('button', {
                  className: 'sf-btn',
                  type: 'button',
                  onClick: () => setRunWarning(null),
                }, t('cancel')),
                h('button', {
                  className: 'sf-btn sf-btn-primary',
                  type: 'button',
                  onClick: () => {
                    setRunWarning(null)
                    void executeRun()
                  },
                }, t('runAnyway'))
              )
            )
          )
          : null,
        preflightResult
          ? h('div', {
            className: 'sf-modal-backdrop',
            onClick: () => setPreflightResult(null),
          },
            h('div', { className: 'sf-modal', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'sf-modal-title' }, `${t('preflight')}: ${preflightResult.ok ? 'PASS' : 'FAIL'}`),
              ...(preflightResult.checks || []).slice(0, 24).map((item) => h('div', {
                key: item.id,
                className: item.status === 'error' ? 'sf-warning' : 'sf-hint',
              }, `${item.status.toUpperCase()} ${item.id}: ${item.message}`)),
              h('div', { className: 'sf-mode-row' },
                h('button', { className: 'sf-btn', type: 'button', onClick: () => setPreflightResult(null) }, t('cancel'))
              )
            )
          )
          : null,
        reconcileResult
          ? h('div', {
            className: 'sf-modal-backdrop',
            onClick: () => setReconcileResult(null),
          },
            h('div', { className: 'sf-modal', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'sf-modal-title' }, `${t('checkActive')}: ${reconcileResult.runId}`),
              reconcileResult.rows.length
                ? reconcileResult.rows.map((row) => {
                  const canAct = run?.id === reconcileResult.runId
                  return h('div', {
                    key: row.jobId,
                    className: row.state === 'sent-no-output' ? 'sf-warning' : 'sf-hint',
                  },
                    h('div', null, `${row.nodeId}/${row.jobId}: ${row.state}${row.sentSeq ? ` · sent #${row.sentSeq}` : ''}`),
                    row.output
                      ? h('pre', { className: 'sf-run-output' }, row.output)
                      : null,
                    canAct
                      ? h('div', { className: 'sf-mode-row' },
                        row.output
                          ? h('button', {
                            className: 'sf-btn sf-btn-primary',
                            type: 'button',
                            disabled: runBusy,
                            onClick: () => void adoptRunNode(row.jobId, reconcileResult.runId),
                          }, t('adoptOutput'))
                          : null,
                        row.state !== 'not-sent'
                          ? h('button', {
                            className: 'sf-btn',
                            type: 'button',
                            disabled: runBusy,
                            onClick: () => {
                              setReconcileResult(null)
                              if (window.confirm(t('retryConfirm'))) void retryRunNode(row.jobId)
                            },
                          }, t('retryNode'))
                          : null,
                        h('button', {
                          className: 'sf-btn',
                          type: 'button',
                          disabled: runBusy,
                          onClick: () => {
                            if (window.confirm(t('abandonConfirm'))) void abandonRunNode(row.jobId, reconcileResult.runId)
                          },
                        }, t('abandonBranch'))
                      )
                      : h('div', { className: 'sf-hint' }, t('currentRunRequired'))
                  )
                })
                : h('div', { className: 'sf-hint' }, t('noActiveJobs')),
              h('div', { className: 'sf-mode-row' },
                h('button', { className: 'sf-btn', type: 'button', onClick: () => setReconcileResult(null) }, t('cancel'))
              )
            )
          )
          : null
    )
    }

    function FlowIcon({ size = 18, active = false }) {      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.85 },
      },
        h('rect', { x: 2, y: 8, width: 7, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('rect', { x: 15, y: 3, width: 7, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('rect', { x: 15, y: 15, width: 7, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M9 11h2.5c2 0 2.5-2 3.5-2', stroke: 'currentColor', strokeWidth: 1.5, strokeFlowcap: 'round' }),
        h('path', { d: 'M9 11h2.5c2 0 2.5 2 3.5 2', stroke: 'currentColor', strokeWidth: 1.5, strokeFlowcap: 'round' })
      )
    }

    const CSS = `
      .sf-root{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-0);color:var(--dsw-alias-label-primary);font:13px/1.45 system-ui,sans-serif}
      .sf-theme-graphite{--dsw-alias-bg-layer-0:#15181d;--dsw-alias-bg-layer-1:#1b1f26;--dsw-alias-bg-layer-2:#232934;--dsw-alias-label-primary:#e7ebf2;--dsw-alias-label-secondary:#9aa4b2;--dsw-alias-border-l1:#2b323d;--dsw-alias-border-l2:#3b4552;--dsw-alias-brand-primary:#7aa7ff;--dsw-alias-state-error-primary:#ff7373;--dsw-alias-state-warning-primary:#e7b45b;--sf-on-accent:#10151c;color-scheme:dark}
      .sf-theme-mist{--dsw-alias-bg-layer-0:#0f1720;--dsw-alias-bg-layer-1:#152230;--dsw-alias-bg-layer-2:#1d2e40;--dsw-alias-label-primary:#e4f1f8;--dsw-alias-label-secondary:#9cb3c4;--dsw-alias-border-l1:#2b4257;--dsw-alias-border-l2:#3d5a72;--dsw-alias-brand-primary:#6bc9e8;--dsw-alias-state-error-primary:#ff8080;--dsw-alias-state-warning-primary:#e5bd66;--sf-on-accent:#07151c;color-scheme:dark}
      .sf-theme-pine{--dsw-alias-bg-layer-0:#121914;--dsw-alias-bg-layer-1:#18231b;--dsw-alias-bg-layer-2:#223126;--dsw-alias-label-primary:#e6f3ea;--dsw-alias-label-secondary:#9db4a5;--dsw-alias-border-l1:#304437;--dsw-alias-border-l2:#435b4b;--dsw-alias-brand-primary:#6fce9b;--dsw-alias-state-error-primary:#ff7d7d;--dsw-alias-state-warning-primary:#e0b968;--sf-on-accent:#07150d;color-scheme:dark}
      .sf-theme-amber{--dsw-alias-bg-layer-0:#1b1610;--dsw-alias-bg-layer-1:#241e15;--dsw-alias-bg-layer-2:#30281b;--dsw-alias-label-primary:#f4ead9;--dsw-alias-label-secondary:#c0ae92;--dsw-alias-border-l1:#493d2a;--dsw-alias-border-l2:#655339;--dsw-alias-brand-primary:#e6ad62;--dsw-alias-state-error-primary:#ff7b6e;--dsw-alias-state-warning-primary:#f0c56e;--sf-on-accent:#1b1206;color-scheme:dark}
      .sf-theme-violet{--dsw-alias-bg-layer-0:#17131f;--dsw-alias-bg-layer-1:#1f192b;--dsw-alias-bg-layer-2:#2a2139;--dsw-alias-label-primary:#eee8fa;--dsw-alias-label-secondary:#b1a5c6;--dsw-alias-border-l1:#3b2f4f;--dsw-alias-border-l2:#544368;--dsw-alias-brand-primary:#b99cff;--dsw-alias-state-error-primary:#ff7f9f;--dsw-alias-state-warning-primary:#e6bd77;--sf-on-accent:#120a24;color-scheme:dark}
      .sf-theme-paper{--dsw-alias-bg-layer-0:#f4f6f9;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#eef2f7;--dsw-alias-label-primary:#1b2430;--dsw-alias-label-secondary:#5f6c7c;--dsw-alias-border-l1:#d4dce6;--dsw-alias-border-l2:#b8c4d2;--dsw-alias-brand-primary:#2f66c9;--dsw-alias-state-error-primary:#c33b3b;--dsw-alias-state-warning-primary:#a66a00;--sf-on-accent:#ffffff;color-scheme:light}
      .sf-theme-picker{display:flex;flex-direction:column;gap:6px}
      .sf-theme-row{display:flex;gap:6px;flex-wrap:wrap}
      .sf-swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;padding:0;cursor:pointer;background:linear-gradient(135deg,#1b1f26 0 52%,#7aa7ff 52% 100%)}
      .sf-swatch.is-active{border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-0)}
      .sf-swatch-graphite{background:linear-gradient(135deg,#1b1f26 0 52%,#7aa7ff 52% 100%)}
      .sf-swatch-mist{background:linear-gradient(135deg,#152230 0 52%,#6bc9e8 52% 100%)}
      .sf-swatch-pine{background:linear-gradient(135deg,#18231b 0 52%,#6fce9b 52% 100%)}
      .sf-swatch-amber{background:linear-gradient(135deg,#241e15 0 52%,#e6ad62 52% 100%)}
      .sf-swatch-violet{background:linear-gradient(135deg,#1f192b 0 52%,#b99cff 52% 100%)}
      .sf-swatch-paper{background:linear-gradient(135deg,#ffffff 0 52%,#2f66c9 52% 100%)}
      .sf-lang-row{display:flex;gap:5px;margin-top:2px}
      .sf-lang{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 9px;font:inherit;font-size:10px;cursor:pointer}
      .sf-lang.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .sf-side{width:270px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);padding:18px 16px;display:flex;flex-direction:column;gap:16px;overflow:auto;box-sizing:border-box}
      .sf-main{flex:1;min-width:0;min-height:0;overflow:hidden;position:relative;background:var(--dsw-alias-bg-layer-0)}
      .sf-viewport{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none}
      .sf-viewport.is-panning{cursor:grabbing}
      .sf-canvas{position:absolute;left:0;top:0;transform-origin:0 0;background:radial-gradient(circle at 1px 1px,var(--dsw-alias-border-l1) 1px,transparent 0) 0 0/22px 22px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);will-change:transform}
      .sf-brand-title{font-size:16px;font-weight:650;letter-spacing:.01em}
      .sf-brand{display:flex;flex-direction:column;gap:6px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .sf-brand-actions{display:flex;flex-direction:column;gap:7px;margin-top:8px}
      .sf-side-btn{display:block;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 10px;text-align:left;cursor:pointer}
      .sf-side-btn:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
      .sf-side-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1))}
      .sf-back-top{margin-bottom:10px;text-align:center}
      .sf-library{width:min(1050px,100%);margin:0 auto;padding:34px 32px;display:flex;flex-direction:column;gap:20px}
      .sf-library-head{display:flex;flex-direction:column;gap:5px}
      .sf-library-head h1{font-size:22px;margin:0;font-weight:700}
      .sf-library-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .sf-library-actions input{flex:1;min-width:220px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit}
      .sf-library-list{display:flex;flex-direction:column;gap:8px}
      .sf-flow-card{position:relative;display:flex;align-items:center;gap:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;cursor:pointer;text-align:left}
      .sf-flow-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
      .sf-flow-card-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
      .sf-flow-card-title{font-size:14px;font-weight:650}
      .sf-flow-card-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
      .sf-flow-card-badge{font-size:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 8px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .sf-flow-actions{position:relative;flex:none;display:flex;align-items:center}
      .sf-flow-gear{width:28px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;cursor:pointer;padding:0}
      .sf-flow-gear:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
      .sf-flow-gear[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .sf-flow-menu{position:absolute;right:0;top:36px;z-index:30;min-width:132px;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:3px}
      .sf-flow-menu-item{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 10px;text-align:left;cursor:pointer;white-space:nowrap}
      .sf-flow-menu-item:hover{background:var(--dsw-alias-bg-layer-1)}
      .sf-flow-menu-danger{color:var(--dsw-alias-state-error-primary)}
      .sf-flow-menu-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
      .sf-library-empty{padding:34px 0;color:var(--dsw-alias-label-secondary);font-size:12px}
      .sf-back{background:transparent;border:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;padding:0;text-align:left}
      .sf-back:hover{color:var(--dsw-alias-label-primary)}
      .sf-brand-sub,.sf-hint,.sf-status{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
      .sf-section{display:flex;flex-direction:column;gap:7px}
      .sf-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .sf-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px}
      .sf-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 8px;font:inherit;font-size:12px}
      .sf-textarea{width:100%;box-sizing:border-box;min-height:58px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px;line-height:1.5}
      .sf-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer}
      .sf-btn:hover{border-color:var(--dsw-alias-brand-primary)}
      .sf-btn:disabled{opacity:.45;cursor:default}
      .sf-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--sf-on-accent,#fff)}
      .sf-danger{color:var(--dsw-alias-state-error-primary)}
      .sf-mode-row{display:flex;gap:6px;flex-wrap:wrap}
      .sf-mode{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 10px;font:inherit;font-size:11px;cursor:pointer}
      .sf-mode.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
      .sf-stats{flex-direction:row;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 0}
      .sf-zoom-value{font-size:10px;font-variant-numeric:tabular-nums}
      .sf-zoom-btn{padding:2px 7px;font-size:10px;min-width:48px}
      .sf-inspector{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
      .sf-skill-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
      .sf-skill-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:6px}
      .sf-skill-toggle{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;text-align:left;padding:4px 0;cursor:pointer}
      .sf-skill-all{font-size:10px;padding:3px 7px}
      .sf-skill-panel{display:flex;flex-direction:column;gap:4px;margin-top:3px}
      .sf-skill-chip{border:1px solid var(--dsw-alias-brand-primary);border-radius:999px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:10px;padding:2px 7px;cursor:pointer}
      .sf-skill-list{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:4px}
      .sf-skill-option{display:flex;align-items:center;gap:5px;font-size:11px;padding:3px 4px;border-radius:5px;cursor:pointer}
      .sf-skill-option:hover{background:var(--dsw-alias-bg-layer-2)}
      .sf-skill-option-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sf-skill-option-scope{font-size:9px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 5px}
      .sf-inspector-title{font-weight:600;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sf-inspector-path{font-size:10px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin-bottom:8px}
      .sf-status{margin-top:auto;padding-top:8px;min-height:16px}
      .sf-canvas{position:relative;flex:none;margin:30px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
      .sf-edges{position:absolute;inset:0;overflow:visible;pointer-events:none}
      .sf-edge-line{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:2;pointer-events:none}
      .sf-edge-line.sf-edge-returnable{stroke:var(--dsw-alias-brand-primary);stroke-dasharray:8 5}
      .sf-edge-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:pointer}
      .sf-edge-hit.is-selected{stroke:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
      .sf-wire-dot{fill:var(--dsw-alias-brand-primary);pointer-events:none}
      .sf-wire-preview{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:2;stroke-dasharray:6 5;pointer-events:none}
      .sf-node{position:absolute;box-sizing:border-box;padding:9px 12px;background:var(--dsw-alias-bg-layer-2);border:2px solid var(--dsw-alias-border-l2);border-radius:10px;cursor:grab;touch-action:none;box-shadow:0 3px 10px rgba(0,0,0,.08);user-select:none}
      .sf-node:hover{border-color:var(--dsw-alias-brand-primary)}
      .sf-node.is-selected{border-color:var(--dsw-alias-brand-primary);border-width:3px;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
      .sf-node.is-wire-source{border-style:dashed;border-color:var(--dsw-alias-brand-primary)}
      .sf-node-kicker{font-size:9px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
      .sf-node-title{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;padding-right:38px}
      .sf-node-flags{position:absolute;top:6px;right:6px;display:flex;align-items:center;gap:3px;z-index:2;pointer-events:none}
      .sf-node-flag{font-size:9px;line-height:1.2;border-radius:999px;padding:2px 5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .sf-node-flag-warn{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .sf-node-flag-skill{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .sf-port{position:absolute;width:22px;height:22px;margin-top:-11px;display:flex;align-items:center;justify-content:center;cursor:crosshair;z-index:3;background:transparent}
      .sf-port::after{content:"";width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-bg-layer-0);border:2px solid var(--dsw-alias-border-l2);box-sizing:border-box}
      .sf-port:hover::after{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
      .sf-port-in{left:-11px}
      .sf-port-out{right:-11px}
      .sf-port-out::after{border-color:var(--dsw-alias-brand-primary)}
      .sf-port-out.is-wire-source::after{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent)}
      .sf-empty{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;max-width:300px;line-height:1.6}
      .sf-footer-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:7px;padding:5px 8px;font:inherit;font-size:12px;cursor:pointer}
      .sf-footer-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
      .sf-error-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .sf-error{color:var(--dsw-alias-state-error-primary);font-size:10px;line-height:1.4;word-break:break-all;flex:1;min-width:120px}
      .sf-run-box{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
      .sf-run-history{display:flex;flex-direction:column;gap:3px;max-height:180px;overflow:auto}
      .sf-run-history-item{display:flex;align-items:stretch;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px}
      .sf-run-history-open{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:4px;text-align:left;cursor:pointer}
      .sf-run-history-open:hover{background:var(--dsw-alias-bg-layer-2)}
      .sf-run-history-actions{display:flex;flex-direction:column;gap:2px;justify-content:center}
      .sf-run-history-actions .sf-btn{font-size:9px;padding:3px 5px}
      .sf-run-status{display:flex;flex-direction:column;gap:4px;max-height:150px;overflow:auto}
      .sf-run-title{font-size:11px;font-weight:600}
      .sf-run-line,.sf-run-node{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary)}
      .sf-run-node-block{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:4px}
      .sf-run-output{font-size:10px;line-height:1.45;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin-top:2px;max-height:54px;overflow:hidden}
      .sf-run-running{color:var(--dsw-alias-brand-primary)}
      .sf-run-done{color:var(--dsw-alias-state-success-primary)}
      .sf-run-error,.sf-run-stopped{color:var(--dsw-alias-state-error-primary)}
      .sf-warning{color:var(--dsw-alias-state-warning-primary);font-size:10px;line-height:1.45;margin:2px 0}
      .sf-modal-backdrop{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:24px}
      .sf-modal{width:min(440px,100%);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:10px}
      .sf-modal-title{font-size:14px;font-weight:650}
      .sf-modal-text{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
      .sf-ports-editor{display:flex;flex-direction:column;gap:8px;margin:8px 0}
      .sf-port-group{display:flex;flex-direction:column;gap:5px}
      .sf-port-row{display:flex;align-items:center;gap:5px}
      .sf-port-name{width:38px;font-size:10px;color:var(--dsw-alias-label-secondary)}
      .sf-port-policy{flex:1;padding:3px 5px;font-size:10px}
      .sf-port-remove{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:5px;width:22px;height:22px;cursor:pointer;font:inherit;font-size:12px;line-height:1}
      .sf-port-remove:disabled{opacity:.35;cursor:default}
      .sf-add-port{font-size:10px;padding:3px 8px;margin-top:2px}
      .sf-output-spec{display:flex;flex-direction:column;gap:5px;margin:8px 0;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
      .sf-number{width:64px;padding:3px 5px;font-size:10px}
      .sf-field-row{display:flex;gap:10px;margin-top:2px}
      .sf-check{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-secondary)}
      @media (max-width:760px){.sf-side{width:230px}.sf-canvas{margin:18px}}
    `

    return {
      inject: ['slots'],
      apply(ctx) {
        const dictionaries = {
          zh: {
            title: '会话间流程', addNode: '添加会话节点', selectSession: '选择已有会话', add: '添加',
            library: '流程图库', libraryHint: '新建、打开或导入一条可复制的流程图',
            newFlow: '新建流程图', flowName: '流程图名称', untitledFlow: '未命名流程图',
            noFlows: '还没有流程图。先新建一条，或从模板开始。',
            refresh: '刷新', loading: '读取中…', flowVersion: '版本', bound: '已绑定', unbound: '未绑定',
            backToLibrary: '流程图库', importFlow: '导入流程图包', exportFlow: '导出',
            deleteFlow: '删除', deleteFlowConfirm: '确定删除这张流程图？会移到回收目录，不直接抹掉。', deleted: '已删除',
            renameFlow: '重命名', renamePrompt: '输入新的流程图名称', renamed: '已重命名', moreActions: '更多操作',
            searchSessions: '搜索会话', sessions: '会话',
            loadSessionsError: '会话列表读取失败', retry: '重试', loadingSessions: '正在读取会话…',
            moveMode: '移动模式', nodeMode: '节点模式', wireMode: '连线模式', runMode: '运行模式',
            runModeHint: '选择起始节点、输入内容并运行整条流程',
            theme: '颜色风格',
            theme_graphite: '石墨灰',
            theme_mist: '雾蓝',
            theme_pine: '松绿',
            theme_amber: '琥珀',
            theme_violet: '紫罗兰',
            theme_paper: '纸白',
            edgeType: '画线种类', edgeTypeHint: '先选类型，再点起点和目标节点',
            hardEdge: '硬性输出线', returnableEdge: '可回退输出线',
            inputPorts: '输入口', outputPorts: '输出口',
            inputEach: '每条线一次', inputAll: '全部到齐', outputAll: '全部输出', outputRoundRobin: '轮询输出',
            outputFormat: '输出格式', outputText: '文本', outputJson: 'JSON results', maxResults: '最多结果',
            defaultOutputPort: '默认输出口', defaultOutputHint: '结果带 target 时按 target 走，否则走这里',
            removePort: '移除端口', portInUse: '端口仍被连线使用，先删除相关连线。',
            wireNeedOutput: '连线模式先点一个输出口。',
            save: '保存', saved: '已保存', saving: '保存中…', saveError: '保存失败', loadError: '读取失败',
            nodes: '节点', edges: '连接', noNodes: '还没有节点。从左侧选择一个已有会话添加。',
            noSessions: '没有可用会话。', emptyGraph: '画布为空。',
            wireHint: '连线模式：先点输出口，再点目标输入口。', wireStarted: '已选择起点：',
            deleteNode: '删除节点', deleteEdge: '删除连接', edgeType: '连接类型',
            cannotConnect: '不能这样连接', duplicateSession: '这个会话已经在流程里了。',
            duplicateEdge: '两个节点之间已经有连接了。', cycle: '不能创建环。',
            selfEdge: '不能连接到自己。', canvas: '流程画布', boundSession: '绑定会话',
            bindSession: '会话绑定', unbindSession: '解绑会话',
            skills: 'Skills', noSkillsSelected: '未选择 Skill', removeSkill: '移除 Skill',
            newWorkstation: '新工位', selectAllSkills: '全选可用 Skill',
            missingSkill: '未找到 Skill', searchSkills: '搜索 Skill', detectingSkills: '正在检测 Skill…',
            noSkillsFound: '没有检测到可用 Skill',
            importPreview: '导入预览', importChecksPass: '结构检查通过，可以导入。',
            importErrors: '导入前有问题', confirmImport: '确认导入', importedRenamed: '已导入副本',
            runHistory: '历史运行', noRunHistory: '还没有历史运行', retryNode: '重试并继续下游',
            retryConfirm: '重试会重新运行该节点并继续下游；如果下游已收到旧结果，可能产生重复。继续？',
            resumeRun: '恢复运行', checkActive: '检查中断节点', noActiveJobs: '没有需要人工确认的运行节点',
            adoptOutput: '采纳并继续', abandonBranch: '放弃分支',
            abandonConfirm: '放弃该分支后该节点不会继续；确定？',
            currentRunRequired: '该历史运行已不在当前进程，不能直接操作；可查看输出或恢复运行。', preflight: '预检',
            positionHint: '节点模式：拖动节点，点击节点编辑属性。', noSelection: '选中节点或连接以查看属性。',
            resetView: '重置视图',
            startNode: '起始节点', noNodesShort: '没有节点', startNodeHint: '默认从没有上游连接的根节点开始', runInput: '运行输入', runInputHint: '发给起始节点的话',
            run: '运行', stop: '停止', runStatus: '运行状态',
            status_running: '运行中', status_stopping: '停止中', status_done: '完成', status_error: '错误', status_stopped: '已停止',
            selectStartNode: '请先选择起始节点', nodePrompt: '节点提示词',
            nodePromptHint: '支持 {{input-x}}；留空则直接发送上一步输出',
            edgeInstruction: '边指令',
            edgeInstructionHint: '使用 {{input-x}} 引用上游输出，例如：请把 {{input-x}} 加上 5',
            duplicateWarningTitle: '占位符重复',
            duplicateInputWarning: '边指令和目标节点提示词都使用了 {{input-x}}，上游输出会被插入两次。',
            cancel: '取消',
            runAnyway: '仍然运行',
          },
          en: {
            title: 'Inter-session flow', addNode: 'Add session node', selectSession: 'Select an existing session', add: 'Add',
            library: 'Flow library', libraryHint: 'Create, open, or import a reusable flow',
            newFlow: 'New flow', flowName: 'Flow name', untitledFlow: 'Untitled flow',
            noFlows: 'No flows yet. Create one or start from a template.',
            refresh: 'Refresh', loading: 'Loading…', flowVersion: 'Version', bound: 'bound', unbound: 'unbound',
            backToLibrary: 'Flow library', importFlow: 'Import flow package', exportFlow: 'Export',
            deleteFlow: 'Delete', deleteFlowConfirm: 'Delete this flow? It will be moved to the trash directory, not erased.', deleted: 'Deleted',
            renameFlow: 'Rename', renamePrompt: 'Enter a new flow name', renamed: 'Renamed', moreActions: 'More actions',
            searchSessions: 'Search sessions', sessions: 'sessions',
            loadSessionsError: 'Could not load sessions', retry: 'Retry', loadingSessions: 'Loading sessions…',
            moveMode: 'Move mode', nodeMode: 'Node mode', wireMode: 'Wire mode', runMode: 'Run mode',
            runModeHint: 'Choose a start node, enter input, and run the flow',
            theme: 'Color style',
            theme_graphite: 'Graphite',
            theme_mist: 'Mist blue',
            theme_pine: 'Pine',
            theme_amber: 'Amber',
            theme_violet: 'Violet',
            theme_paper: 'Paper',
            hardEdge: 'Hard output line', returnableEdge: 'Returnable output line',
            edgeType: 'Edge type', edgeTypeHint: 'Pick a type first, then click source and target',
            inputPorts: 'Inputs', outputPorts: 'Outputs',
            inputEach: 'Per line', inputAll: 'Wait for all', outputAll: 'All flows', outputRoundRobin: 'Round-robin',
            outputFormat: 'Output format', outputText: 'Text', outputJson: 'JSON results', maxResults: 'Max results',
            defaultOutputPort: 'Default output', defaultOutputHint: 'A result target overrides this; otherwise output goes here',
            removePort: 'Remove port', portInUse: 'This port is still connected; delete its edges first.',
            wireNeedOutput: 'In wire mode, click an output port first.',
            save: 'Save', saved: 'Saved', saving: 'Saving…', saveError: 'Save failed', loadError: 'Load failed',
            nodes: 'Nodes', edges: 'Connections', noNodes: 'No nodes yet. Pick an existing session on the left.',
            noSessions: 'No sessions available.', emptyGraph: 'The canvas is empty.',
            wireHint: 'Wire mode: click an output port, then a target input port.', wireStarted: 'Source selected: ',
            deleteNode: 'Delete node', deleteEdge: 'Delete connection', edgeType: 'Connection type',
            cannotConnect: 'Cannot connect these nodes', duplicateSession: 'That session is already in the flow.',
            duplicateEdge: 'A connection already exists between these nodes.', cycle: 'Cycles are not allowed.',
            selfEdge: 'A node cannot connect to itself.', canvas: 'Flow canvas', boundSession: 'Bound session',
            bindSession: 'Session binding', unbindSession: 'Unbind session',
            skills: 'Skills', noSkillsSelected: 'No skill selected', removeSkill: 'Remove skill',
            newWorkstation: 'New workstation', selectAllSkills: 'Select all available',
            missingSkill: 'Skill not found', searchSkills: 'Search skills', detectingSkills: 'Detecting skills…',
            noSkillsFound: 'No available skills detected',
            importPreview: 'Import preview', importChecksPass: 'Structure checks passed. Ready to import.',
            importErrors: 'Problems before import', confirmImport: 'Import', importedRenamed: 'Imported as a copy',
            runHistory: 'Run history', noRunHistory: 'No run history yet', retryNode: 'Retry with downstream',
            retryConfirm: 'This reruns the node and continues downstream. If downstream already received the old result, duplicates may occur. Continue?',
            resumeRun: 'Resume run', checkActive: 'Check interrupted nodes', noActiveJobs: 'No active jobs need review',
            adoptOutput: 'Adopt and continue', abandonBranch: 'Abandon branch',
            abandonConfirm: 'Abandon this branch? The node will not continue.',
            currentRunRequired: 'This historical run is no longer in the current process; view its output or resume it.', preflight: 'Preflight',
            positionHint: 'In node mode, drag nodes and click one to edit it.', noSelection: 'Select a node or connection to inspect it.',
            resetView: 'Reset view',
            startNode: 'Start node', noNodesShort: 'No nodes', startNodeHint: 'Defaults to a root node with no incoming edge', runInput: 'Run input', runInputHint: 'Message sent to the start node',
            run: 'Run', stop: 'Stop', runStatus: 'Run status',
            status_running: 'running', status_stopping: 'stopping', status_done: 'done', status_error: 'error', status_stopped: 'stopped',
            selectStartNode: 'Select a start node first', nodePrompt: 'Node prompt',
            nodePromptHint: 'Supports {{input-x}}; empty sends the previous output as-is',
            edgeInstruction: 'Edge instruction',
            edgeInstructionHint: 'Use {{input-x}} for the upstream output, e.g. add 5 to {{input-x}}',
            duplicateWarningTitle: 'Duplicate placeholder',
            duplicateInputWarning: 'Both the edge instruction and the target node prompt use {{input-x}}; the upstream output will be inserted twice.',
            cancel: 'Cancel',
            runAnyway: 'Run anyway',
          },
        }

        function Panel() {
          const [language, setLanguage] = useState(() => {
            try {
              const stored = localStorage.getItem('inter-session-flow-lang') ||
                localStorage.getItem('session-flow-lang')
              if (stored === 'zh' || stored === 'en') return stored
            } catch {
              // Fall through to the default.
            }
            return 'zh'
          })
          useEffect(() => {
            try {
              localStorage.setItem('inter-session-flow-lang', language)
            } catch {
              // Language persistence is optional.
            }
          }, [language])
          const translate = (key) => (
            dictionaries[language]?.[key] ??
            dictionaries.zh?.[key] ??
            key
          )
          return h(FlowPanel, { t: translate, language, onLanguageChange: setLanguage })
        }
        function Icon(props) {
          return h(FlowIcon, props)
        }

        function FooterButton(props) {
          return h('button', {
            type: 'button',
            className: 'sf-footer-btn',
            title: t('title'),
            onClick: () => ctx.get('layout')?.selectPanel('inter-session-flow'),
          },
            h(FlowIcon, { size: 16 }),
            props.wide ? h('span', null, t('title')) : null
          )
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'inter-session-flow',
        }, Panel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'inter-session-flow',
          order: 35,
          label: () => '会话间流程 / Flow',
        }, Icon))
      },
    }
  },
})

