import { asBoolean, asNumber, asObject, asOptional } from 'cleaners'

/** Missing source detail is unknown, including rows awaiting a rebuild. */
export function asStatCount(raw: unknown): number | null {
  if (raw == null) return null
  const value = asNumber(raw)
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Expected a nonnegative statistic')
  return value
}

export const asStatExtras = asObject({
  firstPa: asStatCount,
  roe: asStatCount,
  fc: asStatCount,
  pik: asStatCount,
  appeared: asOptional(asBoolean, false),
  gs: asStatCount,
  pitches: asStatCount,
  kl: asStatCount,
  pitchAb: asStatCount,
  lob: asStatCount,
  bk: asStatCount,
  pitchPik: asStatCount,
  pitchCs: asStatCount,
  pitchSb: asStatCount,
  wp: asStatCount
})
export type StatExtras = ReturnType<typeof asStatExtras>

export function emptyStatExtras(): StatExtras {
  return {
    firstPa: null,
    roe: 0,
    fc: 0,
    pik: 0,
    appeared: false,
    gs: null,
    pitches: 0,
    kl: 0,
    pitchAb: 0,
    lob: 0,
    bk: 0,
    pitchPik: 0,
    pitchCs: 0,
    pitchSb: 0,
    wp: 0
  }
}

export function addStatCount(
  a: number | null,
  b: number | null | undefined
): number | null {
  return a == null || b == null ? null : a + b
}

/** `5.2`, the way an innings-pitched column is always written. */
export function inningsPitched(outs: number): string {
  return `${Math.floor(outs / 3)}.${outs % 3}`
}
