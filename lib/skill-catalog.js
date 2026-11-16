function normalize(skill, scope) {
  return {
    name: skill?.name || '',
    description: skill?.description || '',
    whenToUse: skill?.whenToUse || '',
    source: skill?.source || '',
    provider: skill?.provider || '',
    path: skill?.path || '',
    scope,
    ref: skill?.provider ? `${skill.provider}/${skill.name}` : skill?.name || '',
    id: skill?.provider ? `${skill.provider}/${skill.name}` : skill?.name || '',
  }
}

function key(skill) {
  return `${skill.provider || ''}\u0000${skill.name}`
}

export async function listSkills({ skills, sessionCatalog, sessionId } = {}) {
  const out = []
  const seen = new Set()
  if (sessionId && sessionCatalog && typeof sessionCatalog.list === 'function') {
    try {
      const entries = await sessionCatalog.list({ sessionId })
      for (const entry of Array.isArray(entries) ? entries : []) {
        const value = normalize(entry, 'session')
        if (!value.name) continue
        seen.add(key(value))
        out.push(value)
      }
    } catch {
      // Session catalog is optional; fall back to global.
    }
  }
  if (skills && typeof skills.list === 'function') {
    try {
      const entries = await skills.list({})
      for (const entry of Array.isArray(entries) ? entries : []) {
        const value = normalize(entry, 'global')
        if (!value.name || seen.has(key(value))) continue
        seen.add(key(value))
        out.push(value)
      }
    } catch {
      // Skill registry may be unavailable during boot.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
