import { asNumber, asObject, asString } from 'cleaners'

/** JavaScript's last representable date, below the integer overflow boundary. */
export const MAX_SCORING_TIME = 8.64e15

/** Original user authorship; automatic completion keeps at/id and advances revision. */
export interface ScoringMutation {
  at: number
  id: string
  revision: number
  frontier: number
}
const shape = asObject({
  at: asNumber,
  id: asString,
  revision: asNumber,
  frontier: asNumber
})
export function asScoringMutation(raw: unknown): ScoringMutation {
  const value = shape(raw)
  if (value.at > MAX_SCORING_TIME)
    throw new TypeError(
      'Scoring mutation time exceeds the supported date range'
    )
  if (
    !Number.isSafeInteger(value.at) ||
    value.at < 0 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.frontier) ||
    value.frontier < 0
  )
    throw new TypeError('Invalid scoring mutation')
  return value
}
export function compareScoringMutations(
  a: ScoringMutation,
  b: ScoringMutation
): number {
  const time = a.at - b.at
  return time !== 0
    ? time
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : a.revision - b.revision
}

/** Whether two writes observed the same accepted scoring version. */
export function sameScoringMutation(
  a: ScoringMutation | null | undefined,
  b: ScoringMutation | null | undefined
): boolean {
  return a == null
    ? b == null
    : b != null && compareScoringMutations(a, b) === 0
}
/** Stable across property order, so retries cannot reuse an identity for different data. */
export function scoringFingerprintInput(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(scoringFingerprintInput).join(',') + ']'
  if (value != null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(object)
        .filter(key => object[key] !== undefined)
        .sort()
        .map(
          key =>
            JSON.stringify(key) + ':' + scoringFingerprintInput(object[key])
        )
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value) ?? 'null'
}

let serial = 0
export function authoredScoringMutation(at: number): ScoringMutation {
  const bytes = new Uint8Array(16)
  // Native targets do not include DOM globals and may not provide Web Crypto.
  const { crypto } = globalThis as {
    crypto?: { getRandomValues: (bytes: Uint8Array) => Uint8Array }
  }
  if (crypto?.getRandomValues != null) crypto.getRandomValues(bytes)
  else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256)
  return {
    at,
    id:
      String(++serial).padStart(16, '0') +
      '-' +
      [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    revision: 0,
    frontier: 0
  }
}
