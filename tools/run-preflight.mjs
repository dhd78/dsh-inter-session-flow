#!/usr/bin/env node
import fs from 'node:fs/promises'
import { preflightPackage } from '../lib/package.js'

const file = process.argv[2]
const mode = process.argv[3] === 'publish' ? 'publish' : 'import'
if (!file) {
  console.error('usage: node tests/run-preflight.mjs <package.interflow.json> [preflight|publish]')
  process.exit(2)
}

try {
  const raw = await fs.readFile(file, 'utf8')
  const pkg = JSON.parse(raw)
  const result = preflightPackage(pkg, { mode })
  for (const item of result.checks) {
    console.log(`${item.status.toUpperCase().padEnd(7)} ${item.id.padEnd(32)} ${item.message}`)
  }
  console.log(`\n${result.ok ? 'PASS' : 'FAIL'} mode=${mode} checks=${result.checks.length}`)
  process.exit(result.ok ? 0 : 1)
} catch (error) {
  console.error(`ERROR ${String(error?.message || error)}`)
  process.exit(1)
}
