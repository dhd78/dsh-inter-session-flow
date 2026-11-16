import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashSkillPackage } from '../lib/skill-package.js'

async function makeSkill(root) {
  await fs.mkdir(path.join(root, 'references'), { recursive: true })
  await fs.writeFile(path.join(root, 'SKILL.md'), '# Demo\n\nhello\n', 'utf8')
  await fs.writeFile(path.join(root, 'references', 'a.txt'), 'a\n', 'utf8')
  await fs.writeFile(path.join(root, 'SHA256SUMS.txt'), 'ignored\n', 'utf8')
  await fs.writeFile(path.join(root, 'MANIFEST.md'), 'ignored\n', 'utf8')
}

test('packageHash is stable across mtimes and excluded files', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-skill-a-'))
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-skill-b-'))
  await makeSkill(a)
  await makeSkill(b)
  const future = new Date('2030-01-02T03:04:05Z')
  await fs.utimes(path.join(b, 'SKILL.md'), future, future)
  await fs.writeFile(path.join(b, 'SHA256SUMS.txt'), 'changed but excluded\n', 'utf8')
  const ha = await hashSkillPackage(a)
  const hb = await hashSkillPackage(b)
  assert.equal(ha.packageHash, hb.packageHash)
  assert.deepEqual(ha.files, ['SKILL.md', 'references/a.txt'])
  assert.match(ha.packageHash, /^sha256:[a-f0-9]{64}$/)
})

test('packageHash changes when a distributable file changes', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'isf-skill-c-'))
  await makeSkill(a)
  const before = await hashSkillPackage(a)
  await fs.writeFile(path.join(a, 'references', 'a.txt'), 'changed\n', 'utf8')
  const after = await hashSkillPackage(a)
  assert.notEqual(before.packageHash, after.packageHash)
})
