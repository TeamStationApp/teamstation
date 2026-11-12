import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from './actions'
import {
  alignAuthors,
  asScoringAuthorship,
  authorshipForWire,
  emptyAuthorship,
  isEmptyAuthorship,
  SCORING_REMOVAL_LIMIT,
  stampAuthorship,
  type StoredAuthorship,
  storedAuthorship
} from './authorship'

const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const single: ScoringAction = { type: 'result', eventType: 'single' }
const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }

let ids = 0
const newId = (): string => `r${++ids}`
const at = (
  ...entries: Array<[number, ScoringAction[]]>
): Map<number, ScoringAction[]> => new Map(entries)
/** The author ids per at-bat, as a reader sees them. */
const authors = (stored: StoredAuthorship): Record<string, unknown[]> =>
  Object.fromEntries(
    Object.entries(stored.plays).map(([index, list]) => [
      index,
      list.map(author => (author == null ? null : stored.users[author]))
    ])
  )

describe('scoring authorship', () => {
  it('stamps only the new tail of an append', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball]]),
      'ann',
      newId
    )
    const second = stampAuthorship(
      first,
      at([0, [ball]]),
      at([0, [ball, strike]]),
      'bob',
      newId
    )
    expect(authors(second)).deep.equals({ 0: ['ann', 'bob'] })
    expect(second.removals).deep.equals([])
  })
  it('records an Undo of the last action as a removal by its scorer', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball, strike]]),
      'ann',
      newId
    )
    const undone = stampAuthorship(
      first,
      at([0, [ball, strike]]),
      at([0, [ball]]),
      'bob',
      newId
    )
    expect(authors(undone)).deep.equals({ 0: ['ann'] })
    expect(undone.removals).lengthOf(1)
    const [removal] = undone.removals
    expect(undone.users[removal.user]).equals('bob')
    expect(removal.atBatIndex).equals(0)
    expect(removal.actions).deep.equals([strike])
    expect(removal.sequence).equals(1)
  })
  it('keeps the prefix authors of a correction and stamps its new suffix', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball, strike, strike]]),
      'ann',
      newId
    )
    const corrected = stampAuthorship(
      first,
      at([0, [ball, strike, strike]]),
      at([0, [ball, ball, strike]]),
      'bob',
      newId
    )
    expect(authors(corrected)).deep.equals({ 0: ['ann', 'bob', 'bob'] })
    expect(corrected.removals[0].actions).deep.equals([strike, strike])
  })
  it('records every action of a deleted at-bat as removed', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [single, close]], [1, [ball]]),
      'ann',
      newId
    )
    const deleted = stampAuthorship(
      first,
      at([0, [single, close]], [1, [ball]]),
      at([0, [single, close]]),
      'ann',
      newId
    )
    expect(authors(deleted)).deep.equals({ 0: ['ann', 'ann'] })
    expect(deleted.removals).lengthOf(1)
    expect(deleted.removals[0]).include({ atBatIndex: 1 })
    expect(deleted.removals[0].actions).deep.equals([ball])
  })
  it('compares a reopened at-bat with its own earlier actions', () => {
    // `before` maps the at-bat from its retained row; `after` from the
    // current play the Undo reopened, which overrides it.
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball, single]]),
      'ann',
      newId
    )
    const reopened = stampAuthorship(
      first,
      at([0, [ball, single]]),
      at([0, [ball]]),
      'bob',
      newId
    )
    expect(authors(reopened)).deep.equals({ 0: ['ann'] })
    expect(reopened.removals[0].actions).deep.equals([single])
  })
  it('keeps alignment for a write no scorer made and records no removal', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball, strike]]),
      'ann',
      newId
    )
    const lineup: ScoringAction = { type: 'lineup', kind: 'roster' }
    const coach = stampAuthorship(
      first,
      at([0, [ball, strike]]),
      at([0, [ball, lineup]]),
      undefined,
      newId
    )
    expect(authors(coach)).deep.equals({ 0: ['ann', null] })
    expect(coach.removals).deep.equals([])
  })
  it('keeps the stamp of an action rebuilt with its properties reordered', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball]]),
      'ann',
      newId
    )
    const reordered = JSON.parse('{"call":"B","type":"pitch"}') as ScoringAction
    const again = stampAuthorship(
      first,
      at([0, [ball]]),
      at([0, [reordered, strike]]),
      'bob',
      newId
    )
    expect(authors(again)).deep.equals({ 0: ['ann', 'bob'] })
  })
  it(`keeps only the latest ${SCORING_REMOVAL_LIMIT} removals`, () => {
    let stored = emptyAuthorship()
    for (let i = 0; i < SCORING_REMOVAL_LIMIT + 5; i++) {
      stored = stampAuthorship(stored, at(), at([0, [ball]]), 'ann', newId)
      stored = stampAuthorship(stored, at([0, [ball]]), at(), 'bob', newId)
    }
    expect(stored.removals).lengthOf(SCORING_REMOVAL_LIMIT)
    expect(stored.removals.at(-1)!.sequence).equals(SCORING_REMOVAL_LIMIT + 5)
    expect(stored.removals[0].sequence).equals(6)
  })
  it('drops interned users nothing names any longer', () => {
    const first = stampAuthorship(
      emptyAuthorship(),
      at(),
      at([0, [ball]]),
      'ann',
      newId
    )
    const replaced = stampAuthorship(
      { ...first, removals: [] },
      at([0, [ball]]),
      at([0, [strike]]),
      undefined,
      newId
    )
    expect(replaced.users).deep.equals([])
    expect(isEmptyAuthorship(replaced)).equals(true)
  })
  it('stays aligned with every record over 300 seeded writes', () => {
    let seed = 3
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const pool = [ball, strike, single, close]
    let records = new Map<number, ScoringAction[]>()
    let stored = emptyAuthorship()
    for (let step = 0; step < 300; step++) {
      const after = new Map<number, ScoringAction[]>()
      for (const [index, actions] of records)
        if (next() > 0.1)
          after.set(
            index,
            next() < 0.3
              ? actions.slice(0, Math.floor(next() * actions.length))
              : actions
          )
      const index = Math.floor(next() * 6)
      after.set(index, [
        ...(after.get(index) ?? []),
        pool[Math.floor(next() * pool.length)]
      ])
      const user = next() < 0.2 ? undefined : next() < 0.5 ? 'ann' : 'bob'
      stored = stampAuthorship(stored, records, after, user, newId)
      for (const [atBat, actions] of after)
        expect(stored.plays[String(atBat)], `step ${step}`).lengthOf(
          actions.length
        )
      for (const author of Object.values(stored.plays).flat())
        if (author != null) expect(author).lessThan(stored.users.length)
      records = after
    }
  })
  it('reads only well-formed stored authorship', () => {
    expect(storedAuthorship(null)).deep.equals(emptyAuthorship())
    expect(storedAuthorship({ users: ['a', 3] })).deep.equals(emptyAuthorship())
    // A stale update stream from the text stream's development builds is not
    // authorship, and is ignored.
    expect(storedAuthorship({ updates: [{ lines: ['Ball'] }] })).deep.equals(
      emptyAuthorship()
    )
    expect(
      storedAuthorship({
        users: ['ann'],
        plays: { 0: [0, 5, null], x: [0], 1: 'no' },
        removals: [
          { id: 'r', sequence: 1, user: 0, atBatIndex: 0, actions: [ball] },
          { id: 'bad', sequence: 2, user: 9, atBatIndex: 0, actions: [] }
        ]
      })
    ).deep.equals({
      users: ['ann'],
      plays: { 0: [0, null, null] },
      removals: [
        { id: 'r', sequence: 1, user: 0, atBatIndex: 0, actions: [ball] }
      ]
    })
  })
  it('maps survivors and names for the wire, and reads the wire back', () => {
    const stored: StoredAuthorship = {
      users: ['old', 'bob'],
      plays: { 0: [0, 1, null] },
      removals: [
        { id: 'r', sequence: 1, user: 1, atBatIndex: 0, actions: [strike] }
      ]
    }
    const wire = authorshipForWire(
      stored,
      id => (id === 'old' ? 'ann' : id),
      new Map([['ann', 'Ann A.']])
    )
    expect(wire).deep.equals({
      plays: { 0: ['ann', 'bob', null] },
      removals: [
        {
          id: 'r',
          sequence: 1,
          userId: 'bob',
          atBatIndex: 0,
          actions: [strike]
        }
      ],
      names: { ann: 'Ann A.', bob: '' }
    })
    expect(asScoringAuthorship(JSON.parse(JSON.stringify(wire)))).deep.equals(
      wire
    )
    expect(() => asScoringAuthorship('nope')).throws(TypeError)
    expect(
      asScoringAuthorship({
        plays: { 0: ['a', 3], y: ['b'] },
        removals: [{ id: 1 }],
        names: { a: 'A', b: 2 }
      })
    ).deep.equals({
      plays: { 0: ['a', null] },
      removals: [],
      names: { a: 'A' }
    })
  })
  it('aligns one author per log action, none past the stored segments', () => {
    expect(
      alignAuthors(
        [
          { atBatIndex: 0, count: 2 },
          { atBatIndex: 1, count: 2 }
        ],
        { 0: ['ann', 'bob'], 1: ['bob'] },
        5
      )
    ).deep.equals(['ann', 'bob', 'bob', null, null])
    expect(
      alignAuthors([{ atBatIndex: 0, count: 3 }], undefined, 2)
    ).deep.equals([null, null])
  })
})
