import type { ScoringAction } from './actions'
import { scoringFingerprintInput } from './scoringMutation'

/**
 * A prefix hash chain over a scoring log, like Git's commit ids: entry `i`
 * identifies the whole history before action `i`, authors included. Two logs
 * share `chain[n]` only when they share their first `n` actions and authors.
 */
export type ChainMix = (previous: string, key: string) => string

export const CHAIN_SEED = '0000000000000000'

const fingerprints = new WeakMap<object, string>()
const keys = new WeakMap<object, { author: string; key: string }>()

/** Canonical: an action rebuilt with its properties in another order matches. */
export function actionFingerprint(action: ScoringAction): string {
  let fingerprint = fingerprints.get(action)
  if (fingerprint == null) {
    fingerprint = scoringFingerprintInput(action)
    fingerprints.set(action, fingerprint)
  }
  return fingerprint
}

const states = new WeakMap<object, string>()

/** A game's canonical fingerprint, memoised per object. */
export function stateFingerprint(state: object): string {
  let fingerprint = states.get(state)
  if (fingerprint == null) {
    fingerprint = scoringFingerprintInput(state)
    states.set(state, fingerprint)
  }
  return fingerprint
}

/** The fingerprint with its author: a re-credit is a different history. */
export function actionKey(
  action: ScoringAction,
  author?: string | null
): string {
  const by = author ?? ''
  const known = keys.get(action)
  if (known?.author === by) return known.key
  const key = actionFingerprint(action) + '\u0001' + by
  keys.set(action, { author: by, key })
  return key
}

function fnv1a(text: string, basis: number): number {
  let hash = basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Two independent 32-bit FNV-1a lanes, 64 bits in all. */
export const fnvMix: ChainMix = (previous, key) => {
  const text = previous + '\u0000' + key
  return (
    fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0') +
    fnv1a(text, 0x050c5d1f).toString(16).padStart(8, '0')
  )
}

export interface ChainExtension {
  /** `chain.length === actions.length + 1`; `chain[0]` is the seed. */
  chain: readonly string[]
  /** The first index whose key changed, or the previous length on growth. */
  diverge: number
}

export interface ActionChain {
  extend: (
    actions: readonly ScoringAction[],
    authors?: ReadonlyArray<string | null | undefined>
  ) => ChainExtension
}

/** Keeps the last log's keys and chain; only a changed tail is re-mixed. */
export function createActionChain(
  options: { mix?: ChainMix } = {}
): ActionChain {
  const mix = options.mix ?? fnvMix
  let previous: string[] = []
  let chain: string[] = [CHAIN_SEED]
  return {
    extend(actions, authors) {
      const next = actions.map((action, index) =>
        actionKey(action, authors?.[index])
      )
      const shared = Math.min(next.length, previous.length)
      let diverge = 0
      while (diverge < shared && next[diverge] === previous[diverge]) diverge++
      const extended = chain.slice(0, diverge + 1)
      for (let i = diverge; i < next.length; i++)
        extended.push(mix(extended[i], next[i]))
      previous = next
      chain = extended
      return { chain: extended, diverge }
    }
  }
}

/** A one-off chain for a log with no previous state to extend. */
export function chainOf(
  actions: readonly ScoringAction[],
  authors?: ReadonlyArray<string | null | undefined>
): readonly string[] {
  return createActionChain().extend(actions, authors).chain
}
