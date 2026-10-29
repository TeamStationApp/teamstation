import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import { withHalfOuts } from '../../common/scoring/linescore'
import { storedGumbo } from './eventWrite'

const play: GumboPlay = {
  about: { atBatIndex: 0 },
  result: { eventType: 'single', description: 'Robin singles to left' },
  playEvents: [{ type: 'pitch', description: 'Ball 1' }, 'odd', null],
  source: { system: 'acme', play: {} }
}

describe('what is stored of a posted play', function () {
  it('keeps no sentence an outside scorer wrote, in the result or a play event', function () {
    const stored = storedGumbo(play, 'external')
    expect(stored.result).deep.equals({ eventType: 'single' })
    expect(stored.playEvents).deep.equals([{ type: 'pitch' }, 'odd', null])
    expect(stored).not.to.have.property('source')
  })

  it('stores each credit with its structure and no name its id gives', function () {
    const credit = {
      eventType: 'strikeout',
      label: 'Strikeout: Max Fried pitching',
      teamId: 'home',
      creditUserId: 4,
      credit: { name: 'Max Fried', role: 'pitcher', position: null }
    }
    // A typed opponent, with no id, keeps the name typed for him.
    const typed = {
      eventType: 'home_run',
      label: 'Home run: Babe Ruth',
      teamId: 'away',
      creditUserId: null,
      credit: { name: 'Babe Ruth', role: 'batter', position: null }
    }
    for (const source of ['external', 'manual', 'teamstation'] as const) {
      const stored = storedGumbo({ ...play, credits: [credit, typed] }, source)
      expect(stored.credits, source).deep.equals([
        {
          eventType: 'strikeout',
          teamId: 'home',
          creditUserId: 4,
          credit: { role: 'pitcher', position: null },
          head: 'Strikeout',
          suffix: ' pitching'
        },
        {
          eventType: 'home_run',
          teamId: 'away',
          creditUserId: null,
          credit: { name: 'Babe Ruth', role: 'batter', position: null },
          head: 'Home run'
        }
      ])
    }
  })

  it('stores no name of a player with an id, from any source, and keeps a typed one', function () {
    const named: GumboPlay = {
      about: { atBatIndex: 1 },
      result: { eventType: 'strikeout' },
      matchup: {
        batter: { id: 7, fullName: 'Aaron Judge' },
        pitcher: { id: null, fullName: 'Babe Ruth' }
      },
      runners: [
        {
          movement: { start: null, end: null, isOut: true },
          details: { runner: { id: 7, fullName: 'Aaron Judge' } },
          credits: [
            { player: { id: 8, fullName: 'Jose Trevino' }, credit: 'f_putout' }
          ]
        }
      ],
      playEvents: [
        { type: 'pitch', player: { id: 7, fullName: 'Aaron Judge' } }
      ]
    } as unknown as GumboPlay
    for (const source of ['external', 'manual', 'teamstation'] as const) {
      const text = JSON.stringify(storedGumbo(named, source))
      expect(text, source).not.include('Aaron Judge')
      expect(text, source).not.include('Jose Trevino')
      expect(text, source).include('Babe Ruth')
    }
  })

  it('keeps the Gumbo descriptions of a play TeamStation wrote itself', function () {
    const stored = storedGumbo(play, 'teamstation')
    expect(stored.result).deep.equals(play.result)
    expect(stored.playEvents).deep.equals(play.playEvents)
    expect(stored).not.to.have.property('source')
  })
})

describe('the outs a half ended on', function () {
  const half = (playEvents: unknown[]): GumboPlay[] => [
    {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'single' },
      count: { outs: 1 },
      playEvents
    }
  ]

  it('reads an Inning Ended marker by its type', function () {
    const [last] = withHalfOuts(half([{ type: 'inning_ended', outs: 3 }]))
    expect(last.about.halfOuts).equals(3)
    const [counted] = withHalfOuts(
      half([{ type: 'Inning Ended', count: { outs: 2 } }])
    )
    expect(counted.about.halfOuts).equals(2)
  })

  it('never reads a sentence as a marker', function () {
    const [last] = withHalfOuts(
      half([{ description: 'Inning Ended', outs: 3 }])
    )
    // Falls back to the play's own count.
    expect(last.about.halfOuts).equals(1)
  })
})
