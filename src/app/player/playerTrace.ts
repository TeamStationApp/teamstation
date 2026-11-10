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
    sink({ at: performance.now(), event, values })
  } catch {
    // Collecting evidence must never interrupt playback.
  }
}
