import { hashValue } from './hash.js'
import { normalizeFlowContent } from './flow-schema.js'

const LICENSE_DRAFT = (value) => !value || value === 'TBD' || /^LicenseRef-/i.test(value)
const SAFE_PATH = /^(?![A-Za-z]:)(?!\/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function unique(values) {
  return [...new Set(values)]
}

function flowContent(line) {
  return {
    schemaVersion: 3,
    nodes: line.nodes,
    edges: line.edges,
    inputSchema: line.inputSchema || {},
    outputSchema: line.outputSchema || {},
    requirements: line.requirements || {},
  }
}

export function buildPackage(line, binding, options = {}) {
  const nodes = line.nodes || []
  const manifest = {
    flowId: line.flowId,
    flowVersion: line.version,
    title: line.title,
    description: line.description || '',
    author: '',
    license: 'TBD',
    createdAt: line.createdAt || new Date().toISOString(),
    pluginVersion: '2.0.0',
    templateSpecVersion: 1,
    skillLocks: Array.isArray(options.skillLocks) ? options.skillLocks : [],
  }
  const packageBody = {
    packageVersion: 2,
    manifest,
    flow: flowContent(line),
    bindingsTemplate: {
      schemaVersion: 1,
      bindings: Object.fromEntries(nodes.map((node) => [node.nodeId, null])),
    },
    examples: [],
    tests: [
      {
        name: 'package-import-shape',
        mode: 'manual',
        expect: 'line content parses; bindings keys equal node ids',
      },
      {
        name: 'reject-session-id-leak',
        mode: 'import',
        expect: 'no sessionId/cwd/sessionTitle keys',
      },
    ],
    readme: `# ${line.title}\n\nExported from 会话间流程. Skill locks are empty until the line declares them.\n`,
  }
  const flowHash = hashValue(packageBody)
  return {
    ...packageBody,
    integrity: {
      algorithm: 'sha256',
      specVersion: 1,
      flowHash,
      archiveHash: null,
    },
  }
}

function check(id, ok, message, okMessage = 'ok') {
  return { id, status: ok ? 'pass' : 'error', message: ok ? okMessage : message }
}

function hasForbiddenKeys(value, path = '') {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = hasForbiddenKeys(value[i], `${path}/${i}`)
      if (found) return found
    }
    return null
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sessionId' || key === 'cwd' || key === 'sessionTitle') return `${path}/${key}`
    const found = hasForbiddenKeys(child, `${path}/${key}`)
    if (found) return found
  }
  return null
}

export function preflightPackage(input, options = {}) {
  const mode = options.mode === 'publish' ? 'publish' : 'import'
  const checks = []
  if (!input || typeof input !== 'object') {
    return { ok: false, checks: [check('package-shape', false, 'package must be an object')] }
  }
  const versionMessage = input.packageVersion === 1
    ? 'v1 package not supported; migrate to v2'
    : 'packageVersion must be 2'
  checks.push(check('package-version', input.packageVersion === 2, versionMessage))
  const manifest = input.manifest && typeof input.manifest === 'object' ? input.manifest : {}
  for (const field of ['flowId', 'flowVersion', 'title', 'pluginVersion', 'templateSpecVersion']) {
    checks.push(check(`manifest:${field}`, Boolean(manifest[field]), `manifest.${field} is required`))
  }
  const content = normalizeFlowContent(input.flow)
  checks.push(check('flow-content', !content.error, content.error || 'flow content valid'))
  if (!content.error) {
    checks.push(check(
      'flow-id',
      content.flow && manifest.flowId && manifest.flowVersion,
      'manifest flow identity is required',
    ))
    const nodeIds = content.flow.nodes.map((node) => node.nodeId)
    const template = input.bindingsTemplate
    checks.push(check(
      'bindings-template',
      template?.schemaVersion === 1 && template?.bindings && typeof template.bindings === 'object' &&
        JSON.stringify(Object.keys(template.bindings).sort()) === JSON.stringify([...nodeIds].sort()) &&
        Object.values(template.bindings).every((value) => value === null),
      'bindings template keys must equal node ids and values must be null',
    ))
    for (const node of content.flow.nodes) {
      for (const ref of node.skillRefs || []) {
        const refParts = String(ref).split('@')
        const refBase = refParts[0]
        const slash = refBase.indexOf('/')
        const refProvider = slash > 0 ? refBase.slice(0, slash) : ''
        const name = slash > 0 ? refBase.slice(slash + 1) : refBase
        const version = refParts.length > 1 ? refParts[1] : null
        const lock = Array.isArray(manifest.skillLocks)
          ? manifest.skillLocks.find((item) => item.name === name &&
            (!refProvider || !item.provider || item.provider === refProvider) &&
            (!version || !item.version || item.version === version))
          : null
        checks.push(check(
          `skill:${ref}`,
          Boolean(lock),
          `missing skill lock for ${ref}`,
        ))
        if (lock?.license && !LICENSE_DRAFT(lock.license)) {
          checks.push(check(`skill:${ref}:license-file`, Boolean(lock.licenseFile), `${ref}: licenseFile required`))
          if (lock.licenseFile?.path) {
            checks.push(check(
              `skill:${ref}:license-path`,
              SAFE_PATH.test(lock.licenseFile.path),
              `${ref}: licenseFile path must be a safe relative path`,
            ))
          }
        }
        if (lock?.source && /\b(main|latest)\b/i.test(lock.source)) {
          checks.push(check(`skill:${ref}:source`, false, `${ref}: source must pin a commit/tag, not main/latest`))
        }
      }
      if (node.outputSpec?.targetField) {
        const field = node.outputSpec.targetField
        checks.push(check(
          `node:${node.nodeId}:target-field`,
          node.outputSpec.fields.includes(field),
          `${node.nodeId}: targetField must be in outputSpec.fields`,
        ))
        const schema = node.outputSchema || {}
        checks.push(check(
          `node:${node.nodeId}:target-schema`,
          Boolean(schema.required?.includes?.(field) || schema.properties?.[field]),
          `${node.nodeId}: targetField must be in outputSchema`,
        ))
      }
    }
    const lockKeys = new Set()
    for (const lock of Array.isArray(manifest.skillLocks) ? manifest.skillLocks : []) {
      const key = `${lock.name}@${lock.version}`
      checks.push(check(`skill-lock:${key}`, !lockKeys.has(key), `duplicate skill lock ${key}`))
      lockKeys.add(key)
    }
    const leak = hasForbiddenKeys(input)
    checks.push(check('no-session-keys', !leak, leak ? `forbidden key ${leak}` : 'no session keys'))
    if (mode === 'publish') {
      checks.push(check(
        'license:publish',
        !LICENSE_DRAFT(manifest.license),
        'publish requires a real license (not TBD/LicenseRef-*)',
      ))
    }
    const integrity = input.integrity && typeof input.integrity === 'object' ? input.integrity : {}
    if (integrity.flowHash) {
      const copy = { ...input }
      delete copy.integrity
      checks.push(check('integrity:flowHash', hashValue(copy) === integrity.flowHash, 'flowHash check'))
    } else {
      checks.push(check('integrity:flowHash', mode !== 'publish', 'flowHash is required for publish'))
    }
    checks.push(check('integrity:algorithm', integrity.algorithm === 'sha256', 'integrity.algorithm must be sha256'))
    checks.push(check('integrity:specVersion', integrity.specVersion === 1, 'integrity.specVersion must be 1'))
  }
  return {
    ok: checks.every((item) => item.status === 'pass'),
    checks,
  }
}

export function packageToFlow(input) {
  const content = normalizeFlowContent(input.flow)
  if (content.error) throw new Error(content.error)
  const manifest = input.manifest
  return {
    schemaVersion: 3,
    flowId: manifest.flowId,
    version: manifest.flowVersion,
    title: manifest.title,
    description: manifest.description || '',
    ...content.flow,
    createdAt: manifest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
