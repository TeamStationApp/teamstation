import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  actionFingerprint,
  actionKey,
  CHAIN_SEED,
  chainOf,
  createActionChain,
  fnvMix,
  stateFingerprint
} from './actionChain'
import type { ScoringAction } from './actions'

const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const single: ScoringAction = { type: 'result', eventType: 'single' }

/** A deterministic generator, so a failing seed can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const pool: ScoringAction[] = [
  ball,
  strike,
  { type: 'pitch', call: 'S' },
  { type: 'pitch', call: 'F' },
  single,
  { type: 'gameFlow', kind: 'closePlay' },
  { type: 'ballInPlay', contact: 'swing' }
]
function firstDifference(a: readonly string[], b: readonly string[]): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

describe('action chain', () => {
  it('keys an action canonically whatever its property order', () => {
    const reordered = JSON.parse('{"call":"B","type":"pitch"}') as ScoringAction
    expect(actionFingerprint(reordered)).equals(actionFingerprint(ball))
    expect(chainOf([reordered, strike])).deep.equals(chainOf([ball, strike]))
  })
  it('gives the same action by another author a different key and chain', () => {
    expect(actionKey(ball, 'ann')).not.equals(actionKey(ball, 'bob'))
    expect(actionKey(ball, null)).equals(actionKey(ball))
    expect(chainOf([ball], ['ann'])[1]).not.equals(chainOf([ball], ['bob'])[1])
  })
  it('memoises the key of an unchanged action and its author', () => {
    const action: ScoringAction = { type: 'pitch', call: 'B' }
    expect(actionKey(action, 'ann')).equals(actionKey(action, 'ann'))
    expect(actionKey(action, 'bob')).contains('bob')
  })
  it('memoises a state fingerprint per object', () => {
    const state = { a: 1, b: [2, 3] }
    expect(stateFingerprint(state)).equals(stateFingerprint(state))
    expect(stateFingerprint({ b: [2, 3], a: 1 })).equals(
      stateFingerprint(state)
    )
  })
  it('mixes two 32-bit lanes into 16 hex digits', () => {
    const mixed = fnvMix(CHAIN_SEED, 'x')
    expect(mixed).match(/^[0-9a-f]{16}$/)
    expect(mixed.slice(0, 8)).not.equals(mixed.slice(8))
    expect(fnvMix(CHAIN_SEED, 'y')).not.equals(mixed)
  })
  it('extends an append-only log by mixing only its new tail', () => {
    let mixes = 0
    const chain = createActionChain({
      mix: (previous, key) => {
        mixes++
        return fnvMix(previous, key)
      }
    })
    const first = chain.extend([ball, strike])
    expect(first.diverge).equals(0)
    expect(first.chain).lengthOf(3)
    expect(first.chain[0]).equals(CHAIN_SEED)
    mixes = 0
    const second = chain.extend([ball, strike, single])
    expect(second.diverge).equals(2)
    expect(mixes).equals(1)
    expect(second.chain.slice(0, 3)).deep.equals(first.chain)
  })
  it('finds a divergence at the start, the middle and the end', () => {
    const chain = createActionChain()
    chain.extend([ball, strike, single])
    expect(chain.extend([strike, strike, single]).diverge).equals(0)
    chain.extend([ball, strike, single])
    expect(chain.extend([ball, ball, single]).diverge).equals(1)
    chain.extend([ball, strike, single])
    expect(chain.extend([ball, strike, ball]).diverge).equals(2)
    expect(chain.extend([ball, strike]).diverge).equals(2)
  })
  it('handles an empty log and a shrink to nothing', () => {
    const chain = createActionChain()
    expect(chain.extend([])).deep.equals({ chain: [CHAIN_SEED], diverge: 0 })
    chain.extend([ball])
    expect(chain.extend([])).deep.equals({ chain: [CHAIN_SEED], diverge: 0 })
  })
  it('reports a re-credit as a divergence at that action', () => {
    const chain = createActionChain()
    chain.extend([ball, strike], ['ann', 'ann'])
    const recredit = chain.extend([ball, strike], ['ann', 'bob'])
    expect(recredit.diverge).equals(1)
  })
  it('agrees with a direct comparison over 1,000 seeded logs', () => {
    const next = random(7)
    const chain = createActionChain()
    let previous: ScoringAction[] = []
    let previousKeys: string[] = []
    for (let step = 0; step < 1000; step++) {
      const keep = Math.floor(next() * (previous.length + 1))
      const log = previous.slice(0, keep)
      const grow = Math.floor(next() * 4)
      for (let i = 0; i < grow; i++)
        log.push(pool[Math.floor(next() * pool.length)])
      const authors = log.map(() => (next() < 0.1 ? 'bob' : 'ann'))
      const keys = log.map((action, i) => actionKey(action, authors[i]))
      const { chain: hashes, diverge } = chain.extend(log, authors)
      expect(diverge).equals(firstDifference(previousKeys, keys))
      expect(hashes).deep.equals(chainOf(log, authors))
      previous = log
      previousKeys = keys
    }
  })
  it('lets a test force every chain to collide', () => {
    const chain = createActionChain({ mix: () => 'same' })
    const a = chain.extend([ball]).chain
    const b = createActionChain({ mix: () => 'same' }).extend([strike]).chain
    expect(a).deep.equals(b)
  })
})
