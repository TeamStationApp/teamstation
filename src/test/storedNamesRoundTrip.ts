import { expect } from 'chai'

import { namesIn, withNames, withoutNames } from '../common/scoring/storedNames'

/**
 * The play without the first and last names its setups' players carry. The
 * named form puts back `fullName` only: the halves are read for the scorer
 * from the accounts, and only where he may correct them.
 */
export function withoutHalves<T>(document: T): T {
  return JSON.parse(
    JSON.stringify(document, (key, value: unknown) =>
      key === 'firstName' || key === 'lastName' ? undefined : value
    )
  ) as T
}

/**
 * Whether the document gives some id two names: a player renamed part way
 * through a play, whose setup before it names him as he was. One name per id
 * is what the accounts give back, so only the new name is read.
 */
function renamedWithin(document: unknown): boolean {
  const seen = new Map<number, string>()
  let twice = false
  JSON.stringify(document, (_key, value: unknown) => {
    const ref = value as { id?: unknown; fullName?: unknown } | null
    if (
      ref != null &&
      typeof ref === 'object' &&
      typeof ref.id === 'number' &&
      typeof ref.fullName === 'string'
    ) {
      const was = seen.get(ref.id)
      if (was != null && was !== ref.fullName) twice = true
      seen.set(ref.id, ref.fullName)
    }
    return value
  })
  return twice
}

/**
 * Checks the guarantee `storedNames.ts` makes for a document the engine
 * built: its stored form holds none of the names it carries, and naming the
 * stored form with those names gives the document back, as it is sent. A
 * document that names one player two ways, renamed within it, is named back
 * with one of them, and only the first half is checked.
 */
export function expectNamesRoundTrip(built: unknown, what = 'play'): void {
  if (built == null) return
  // As it is sent: the cleaners leave keys set to `undefined` in memory.
  const document = JSON.parse(JSON.stringify(built)) as unknown
  const names = namesIn(document)
  const stored = withoutNames(document)
  const text = JSON.stringify(stored)
  for (const name of names.values())
    if (name !== '')
      expect(text, `${what} stores the name ${name}`).not.include(name)
  if (renamedWithin(document)) return
  expect(withNames(stored, names), what).deep.equals(withoutHalves(document))
}
