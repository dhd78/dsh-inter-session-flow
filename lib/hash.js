import { createHash } from 'node:crypto'

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
  return out
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function hashValue(value) {
  return `sha256:${sha256(stableStringify(value))}`
}

export function shortHash(value) {
  return sha256(value).slice(0, 12)
}
