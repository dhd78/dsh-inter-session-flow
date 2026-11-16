import { listFlows } from './flow-store.js'

const MAX_FLOW_ID = 64
const MAX_TITLE = 120

function withSuffix(base, suffix, max) {
  const tail = `-${suffix}`
  const room = Math.max(1, max - tail.length)
  return `${base.slice(0, room)}${tail}`
}

function withTitleSuffix(base, suffix) {
  const tail = ` (${suffix})`
  const room = Math.max(1, MAX_TITLE - tail.length)
  return `${base.slice(0, room).trimEnd()}${tail}`
}

/**
 * Import/rename helper: keep the requested id when free; otherwise append
 * -2, -3, ... and add a matching visible title suffix.
 */
export async function uniqueFlowIdentity(root, desiredFlowId, desiredTitle) {
  const rows = await listFlows(root)
  const ids = new Set(rows.map((row) => row.flowId))
  const titles = new Set(rows.map((row) => row.title))
  let flowId = desiredFlowId
  let suffix = 2
  let idRenamed = false
  while (ids.has(flowId)) {
    flowId = withSuffix(desiredFlowId, suffix, MAX_FLOW_ID)
    suffix += 1
    idRenamed = true
  }
  let title = desiredTitle
  let titleSuffix = idRenamed ? suffix - 1 : 2
  if (idRenamed) title = withTitleSuffix(desiredTitle, titleSuffix)
  while (titles.has(title)) {
    title = withTitleSuffix(desiredTitle, titleSuffix)
    titleSuffix += 1
  }
  return {
    flowId,
    title,
    renamed: flowId !== desiredFlowId || title !== desiredTitle,
    idRenamed,
  }
}
