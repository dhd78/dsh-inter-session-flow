export function snapshotState({ ready, active, joins, cursors }) {
  return {
    stateVersion: 1,
    ready: (ready || []).map((job) => ({ ...job })),
    active: [...(active || [])],
    joins: [...(joins || new Map()).entries()].map(([key, value]) => ({
      key,
      expected: [...(value.expected || [])],
      queues: [...(value.queues || new Map()).entries()].map(([edgeId, queue]) => ({
        edgeId,
        queue: [...(queue || [])],
      })),
    })),
    cursors: Object.fromEntries(cursors || new Map()),
  }
}

export function restoreState(state) {
  const ready = Array.isArray(state?.ready) ? state.ready.map((job) => ({ ...job })) : []
  const active = Array.isArray(state?.active) ? [...state.active] : []
  const joins = new Map()
  for (const item of Array.isArray(state?.joins) ? state.joins : []) {
    joins.set(item.key, {
      expected: new Set(Array.isArray(item.expected) ? item.expected : []),
      queues: new Map((Array.isArray(item.queues) ? item.queues : []).map((entry) => [
        entry.edgeId,
        Array.isArray(entry.queue) ? [...entry.queue] : [],
      ])),
    })
  }
  const cursors = new Map(Object.entries(state?.cursors || {}))
  return { ready, active, joins, cursors }
}
