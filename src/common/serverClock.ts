/** One reading of the server's clock against this device's. */
export interface ClockSample {
  /** What to add to this device's clock to read the server's, in ms. */
  offsetMs: number
  /** How long the reading took to come back, in ms. */
  roundTripMs: number
}

/**
 * Measures how far the server's clock is from this device's: asks for the
 * server's time `samples` times and keeps the reading that came back
 * quickest, taking the server to have read its clock halfway through it, so
 * the offset is wrong by at most half that round trip. A reading that fails
 * is skipped; when every one does, the last failure is thrown.
 */
export async function measureOffset(
  fetchTime: () => Promise<number>,
  samples = 5,
  local: () => number = Date.now
): Promise<ClockSample> {
  let best: ClockSample | undefined
  let failure: unknown
  for (let i = 0; i < samples; i++) {
    const t0 = local()
    let now: number
    try {
      now = await fetchTime()
    } catch (error) {
      failure = error
      continue
    }
    const t1 = local()
    const sample = { offsetMs: now - (t0 + t1) / 2, roundTripMs: t1 - t0 }
    if (best == null || sample.roundTripMs < best.roundTripMs) best = sample
  }
  if (best == null) throw failure
  return best
}
