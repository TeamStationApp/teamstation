/**
 * A request body that is an object holding only `keys`. An array, anything
 * that is not an object, or a key not listed is refused: with
 * `Expected <shape>`, or `<only>, not <the extra keys>`.
 */
export function strictBody(
  raw: unknown,
  keys: readonly string[],
  shape: string,
  only: string
): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`Expected ${shape}`)
  }
  const extra = Object.keys(raw).filter(key => !keys.includes(key))
  if (extra.length > 0) {
    throw new TypeError(`${only}, not ${extra.join(', ')}`)
  }
  return raw as Record<string, unknown>
}
