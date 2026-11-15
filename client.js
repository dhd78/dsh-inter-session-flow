window.__ModuleLoader__.load({
  id: 'dsh-inter-session-flow',
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
      const [runBusy, setRunBusy] = useState(false)
      const [runError, setRunError] = useState('')
      const [runWarning, setRunWarning] = useState(null)
      const graphRef = useRef(emptyGraph())
      const dragRef = useRef(null)
      const suppressClickRef = useRef(false)
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

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const graphResponse = await fetch(API_GRAPH, { cache: 'no-store' })
            const graphValue = await readJson(graphResponse)
            if (alive) {
              const loaded = graphValue.graph || emptyGraph()
              setGraphValue(loaded)
              const viewport = loaded.viewport
              if (viewport && Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.zoom)) {
                setCameraValue({ x: viewport.x, y: viewport.y, zoom: clamp(viewport.zoom, 0.35, 2.5) })
              }
            }
          } catch (error) {
            if (alive) setStatus(`${t('loadError')}: ${error.message}`)
          }
        }
        load()
        return () => { alive = false }
      }, [])

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

      const saveGraph = async (next, successMessage = t('saved')) => {
        setGraphValue(next)
        setSaving(true)
        setStatus(t('saving'))
        try {
          const response = await fetch(API_GRAPH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const value = await readJson(response)
          if (value.graph) setGraphValue(value.graph)
          setStatus(successMessage)
        } catch (error) {
          setStatus(`${t('saveError')}: ${error.message}`)
        } finally {
          setSaving(false)
        }
      }

      const addNode = () => {
        const session = sessions.find((item) => item.id === sessionChoice)
        if (!session) return
        if (graph.nodes.some((node) => node.sessionId === session.id)) {
          setStatus(t('duplicateSession'))
          return
        }
        const index = graph.nodes.length
        const node = {
          id: uid('n_'),
          sessionId: session.id,
          title: labelForSession(session),
          cwd: session.cwd || '',
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
            }),
          })
          const value = await readJson(response)
          setRun(value.run || null)
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
        } catch (error) {
          setRunError(String(error.message || error))
        } finally {
          setRunBusy(false)
        }
      }

      return h('div', { className: `sf-root sf-theme-${theme}` },
        h('style', null, CSS),
        h('aside', { className: 'sf-side' },
          h('div', { className: 'sf-brand' },
            h('div', { className: 'sf-brand-title' }, t('title')),
            h('div', { className: 'sf-brand-sub' }, t('positionHint'))
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
                disabled: !sessionChoice || saving,
                onClick: addNode,
              }, t('add'))
            )
            : mode === 'wire'
              ? h('section', { className: 'sf-section' },
              h('label', { className: 'sf-label' }, t('lineType')),
              h('div', { className: 'sf-mode-row' },
                h('button', {
                  className: `sf-mode ${edgeKind === 'hard' ? 'is-active' : ''}`,
                  type: 'button',
                  onClick: () => setEdgeKind('hard'),
                }, t('hardLine')),
                h('button', {
                  className: `sf-mode ${edgeKind === 'returnable' ? 'is-active' : ''}`,
                  type: 'button',
                  onClick: () => setEdgeKind('returnable'),
                }, t('returnableLine'))
              ),
              h('div', { className: 'sf-hint' }, t('lineTypeHint'))
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
                  nodeRun.output
                    ? h('div', { className: 'sf-run-output' }, nodeRun.output.length > 240 ? `${nodeRun.output.slice(0, 240)}…` : nodeRun.output)
                    : null
                ))
              )
              : null
          )
            : null,
          mode !== 'run'
            ? h('section', { className: 'sf-section sf-inspector' },
            selectedNodeValue
              ? h('div', null,
                h('div', { className: 'sf-inspector-title' }, selectedNodeValue.title || t('boundSession')),
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
                  h('div', { className: 'sf-hint' }, selectedEdgeValue.mode === 'returnable' ? t('returnableLine') : t('hardLine')),
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
              h('div', { className: 'sf-node-title' }, node.title || node.sessionId.slice(-8)),
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
        h('path', { d: 'M9 11h2.5c2 0 2.5-2 3.5-2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M9 11h2.5c2 0 2.5 2 3.5 2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })
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
      .sf-node-title{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
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
            lineType: '画线种类', lineTypeHint: '先选类型，再点起点和目标节点',
            hardLine: '硬性输出线', returnableLine: '可回退输出线',
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
            hardLine: 'Hard output line', returnableLine: 'Returnable output line',
            lineType: 'Line type', lineTypeHint: 'Pick a type first, then click source and target',
            inputPorts: 'Inputs', outputPorts: 'Outputs',
            inputEach: 'Per line', inputAll: 'Wait for all', outputAll: 'All lines', outputRoundRobin: 'Round-robin',
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

