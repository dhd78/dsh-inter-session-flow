import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkSkillLocks, readSkillLocks, resolveSkillLocks, writeSkillLocks } from '../lib/skill-locks.js'

test('resolveSkillLocks builds locks and reports missing skills', async () => {
  const skills = {
    get: async (name) => name === 'writer'
      ? { name: 'writer', description: 'write', content: '# Writer', source: 'local:test' }
      : null,
  }
  const result = await resolveSkillLocks(skills, [
    { skillRefs: ['writer', 'missing'] },
    { skillRefs: ['writer'] },
  ])
  assert.equal(result.locks.length, 2)
  assert.equal(result.missing[0], 'missing')
  assert.match(result.locks[0].contentHash, /^sha256:/)
  assert.equal(result.locks[1].license, 'TBD')
})

test('skill lock files round-trip and check missing skill', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-skill-locks-'))
  await writeSkillLocks(root, 'demo', '1.0.0', [{ name: 'writer', required: true, contentHash: null }])
  const value = await readSkillLocks(root, 'demo')
  assert.equal(value.locks[0].name, 'writer')
  const checks = await checkSkillLocks([], value.locks)
  assert.equal(checks[0].status, 'error')
})

test('provider-qualified ref resolves to the right provider', async () => {
  const skills = {
    list: async () => [
      { name: 'review', provider: 'alpha', source: 'local:alpha' },
      { name: 'review', provider: 'beta', source: 'local:beta' },
    ],
    get: async () => ({ name: 'review', provider: 'beta', content: '# beta', source: 'local:beta' }),
  }
  const result = await resolveSkillLocks(skills, [{ skillRefs: ['beta/review'] }])
  assert.equal(result.locks[0].provider, 'beta')
  assert.match(result.locks[0].contentHash, /^sha256:/)
})

test('checkSkillLocks detects contentHash mismatch', async () => {
  const definition = { name: 'review', provider: 'alpha', content: '# alpha', source: 'local' }
  const skills = {
    list: async () => [definition],
    get: async () => definition,
  }
  const checks = await checkSkillLocks([definition], [{
    name: 'review',
    provider: 'alpha',
    required: true,
    contentHash: 'sha256:' + '0'.repeat(64),
  }], skills)
  assert.ok(checks.some((item) => item.id === 'skill:review:contentHash' && item.status === 'error'))
})

