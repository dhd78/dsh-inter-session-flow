function check(id, ok, message, okMessage = 'ok') {
  return {
    id,
    status: ok ? 'pass' : 'error',
    message: ok ? okMessage : message,
  }
}

export function preflightFlow(line, binding) {
  const checks = []
  if (!line || !Array.isArray(line.nodes) || !Array.isArray(line.edges)) {
    return { ok: false, checks: [check('line-shape', false, 'line nodes/edges missing')] }
  }
  const nodeIds = line.nodes.map((node) => node.nodeId)
  const nodeSet = new Set(nodeIds)
  checks.push(check('nodes-present', nodeIds.length > 0, 'line has no nodes'))

  for (const node of line.nodes) {
    const label = `node ${node.nodeId}`
    checks.push(check(`${node.nodeId}:kind`, node.kind === 'session', `${label}: only kind=session is supported in v2.0`))
    const outputIds = new Set((node.outputPorts || []).map((port) => port.id))
    checks.push(check(
      `${node.nodeId}:default-output`,
      outputIds.has(node.defaultOutputPortId),
      `${label}: defaultOutputPortId is not an output port`,
    ))
    if (node.outputSpec?.targetField) {
      const field = node.outputSpec.targetField
      const inFields = Array.isArray(node.outputSpec.fields) && node.outputSpec.fields.includes(field)
      checks.push(check(`${node.nodeId}:target-field`, inFields, `${label}: targetField is not in outputSpec.fields`))
      const schema = node.outputSchema && typeof node.outputSchema === 'object' ? node.outputSchema : {}
      const inSchema = schema.required?.includes?.(field) ||
        (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, field))
      checks.push(check(`${node.nodeId}:target-schema`, Boolean(inSchema), `${label}: targetField is not in outputSchema`))
    }
    for (const port of node.inputPorts || []) {
      if (port.policy !== 'all') continue
      const incoming = line.edges.filter((edge) => edge.to.nodeId === node.nodeId && edge.to.portId === port.id)
      checks.push(check(
        `${node.nodeId}:${port.id}:all-input`,
        incoming.length > 0,
        `${label}: all input port ${port.id} has no incoming edge`,
      ))
    }
  }

  const bound = binding?.nodes && typeof binding.nodes === 'object' ? binding.nodes : {}
  const boundKeys = Object.keys(bound)
  const missing = nodeIds.filter((id) => !boundKeys.includes(id))
  const extra = boundKeys.filter((id) => !nodeSet.has(id))
  checks.push(check('binding-keys', missing.length === 0 && extra.length === 0, `binding keys mismatch; missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`))
  const seenSessions = new Map()
  for (const [nodeId, value] of Object.entries(bound)) {
    if (!value || typeof value.sessionId !== 'string' || !value.sessionId) {
      checks.push(check(`binding:${nodeId}`, false, `binding ${nodeId}: sessionId is required`))
      continue
    }
    if (seenSessions.has(value.sessionId)) {
      checks.push(check(
        `binding:${nodeId}:duplicate-session`,
        false,
        `session ${value.sessionId} is bound to both ${seenSessions.get(value.sessionId)} and ${nodeId}`,
      ))
    } else {
      seenSessions.set(value.sessionId, nodeId)
    }
  }

  const errors = checks.filter((item) => item.status === 'error')
  return { ok: errors.length === 0, checks }
}
