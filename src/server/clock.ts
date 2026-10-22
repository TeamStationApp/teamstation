/** An explicit clock anchor lets integration tests exercise season and cutoff boundaries. */
export function now(): number {
  const value = process.env.TS_UMPIRE_NOW
  if (value == null) return Date.now()
  const instant = Date.parse(value)
  if (!Number.isFinite(instant))
    throw new Error('TS_UMPIRE_NOW must be an ISO instant')
  return instant
}
