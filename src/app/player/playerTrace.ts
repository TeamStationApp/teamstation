/** Numeric playback diagnostics only: never addresses, identities or errors. */
export interface PlayerTraceRecord {
  at: number
  event: string
  values: Record<string, number | boolean | null>
}

/** A diagnostic build or browser debugger may install a sink. Off by default. */
type TraceGlobal = typeof globalThis & {
  __TS_PLAYER_TRACE__?: (record: PlayerTraceRecord) => void
}

export function playerTrace(
  event: string,
  values: PlayerTraceRecord['values']
): void {
  const sink = (globalThis as TraceGlobal).__TS_PLAYER_TRACE__
  if (sink == null) return
  try {
    // Native provides this clock at runtime without declaring its DOM type.
    const clock = (globalThis as { performance?: { now: () => number } })
      .performance
    sink({ at: clock?.now() ?? Date.now(), event, values })
  } catch {
    // Collecting evidence must never interrupt playback.
  }
}
