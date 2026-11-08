import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PlayEditsData } from './gameSocket'
import {
  asCurrentPlay,
  asGumboPlay,
  type CurrentPlay,
  type GumboPlay
} from './gumboPlay'
import { applyPlayEdits, type HeldPlays } from './playEdits'

const play = (index: number, eventType = 'single'): GumboPlay =>
  asGumboPlay({
    about: {
      atBatIndex: index,
      inning: 1,
      halfInning: 'top',
      startTime: null,
      endTime: null
    },
    result: { eventType, awayScore: null, homeScore: null, rbi: null }
  })

const atBat = (index: number): CurrentPlay =>
  asCurrentPlay({
    about: {
      atBatIndex: index,
      inning: 1,
      halfInning: 'top',
      isComplete: false
    },
    playEvents: [{ isPitch: true }]
  })

const row = (
  gumbo: GumboPlay
): { id: string; gameId: string; gumbo: unknown } => ({
  id: `evt_${gumbo.about.atBatIndex}`,
  gameId: 'gam_1',
  gumbo
})

describe('applying play edits to a held game', function () {
  const held: HeldPlays & { modelNames: Record<string, string> } = {
    plays: [play(0), play(1, 'double'), play(2)],
    currentPlay: atBat(3),
    playsDigest: 'd1',
    namesDigest: 'n1',
    generation: 4,
    modelNames: { '7': 'Seven' }
  }
  const change = (fields: Partial<PlayEditsData>): PlayEditsData => ({
    generation: 4,
    fromDigest: 'd1',
    digest: 'd2',
    namesDigest: 'n1',
    edits: [],
    currentPlay: atBat(3),
    ...fields
  })

  it('puts a play at its index, in place of the one there, and keeps the rest', function () {
    const next = applyPlayEdits(
      held,
      change({ edits: [{ op: 'put', play: row(play(1, 'single')) }] })
    )!
    expect(next.plays.map(each => each.result?.eventType)).deep.equals([
      'single',
      'single',
      'single'
    ])
    expect(next.playsDigest).equals('d2')
    expect(next.namesDigest).equals('n1')
    expect(next.generation).equals(4)
    // What else the holder keeps of the game is left as it was.
    expect(next.modelNames).deep.equals({ '7': 'Seven' })
    // The held game itself is not changed.
    expect(held.plays[1].result?.eventType).equals('double')
  })

  it('puts a new play in index order, removes one and replaces the at-bat', function () {
    const next = applyPlayEdits(
      held,
      change({
        edits: [
          { op: 'put', play: row(play(5)) },
          { op: 'put', play: row(play(3, 'strikeout')) },
          { op: 'remove', atBatIndex: 0 }
        ],
        currentPlay: atBat(6)
      })
    )!
    expect(next.plays.map(each => each.about.atBatIndex)).deep.equals([
      1, 2, 3, 5
    ])
    expect(next.currentPlay?.about.atBatIndex).equals(6)
  })

  it('takes an at-bat of none, and a change with no digest leaves none held', function () {
    const next = applyPlayEdits(
      held,
      change({ currentPlay: undefined, digest: null })
    )!
    expect(next.currentPlay).equals(null)
    expect(next).not.to.have.property('playsDigest')
    // So the next change, whatever its base, has the game read again.
    expect(applyPlayEdits(next, change({}))).equals(null)
  })

  it('has the game read again when the change does not apply to it', function () {
    // It says only that the plays changed.
    expect(applyPlayEdits(held, change({ edits: null }))).equals(null)
    // A post's re-read form names the digest it left; still nothing to apply.
    expect(
      applyPlayEdits(
        held,
        change({ fromDigest: null, digest: 'd2', edits: null })
      )
    ).equals(null)
    // It was made after a reset, or before one.
    expect(applyPlayEdits(held, change({ generation: 5 }))).equals(null)
    // It starts from other plays than these: a change between was missed.
    expect(applyPlayEdits(held, change({ fromDigest: 'd0' }))).equals(null)
    expect(applyPlayEdits(held, change({ fromDigest: null }))).equals(null)
    // It was named from another book: a lapsed hold, or a roster add, can
    // rename a player on plays it does not carry.
    expect(applyPlayEdits(held, change({ namesDigest: 'n2' }))).equals(null)
    expect(applyPlayEdits(held, change({ namesDigest: null }))).equals(null)
    const { namesDigest: _names, ...unnamed } = held
    expect(applyPlayEdits(unnamed, change({}))).equals(null)
    // A holder that keeps no digest or generation cannot tell.
    expect(applyPlayEdits({ plays: [], currentPlay: null }, change({}))).equals(
      null
    )
    // A play that does not read.
    expect(
      applyPlayEdits(
        held,
        change({
          edits: [{ op: 'put', play: { id: 'x', gameId: 'g', gumbo: 7 } }]
        })
      )
    ).equals(null)
  })
})
