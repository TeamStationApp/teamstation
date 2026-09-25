import { expect } from 'chai'
import { describe, it } from 'mocha'

import { describePlay, DID_BY_TYPE } from './describePlay'
import { GUMBO_EVENT_TYPES } from './gumboEventTypes'

const credit = (
  eventType: string,
  label: string,
  name: string,
  role = 'batter',
  position: string | null = null
): {
  eventType: string
  label: string
  credit: { name: string; role: string; position: string | null }
} => ({ eventType, label, credit: { name, role, position } })

describe('a play in GameStation’s own words', function () {
  it('says who did what, in which half, and the score after', function () {
    expect(
      describePlay({
        eventType: 'double',
        inning: 4,
        halfInning: 'bottom',
        awayScore: 3,
        homeScore: 5,
        credits: [
          credit('double', 'Double: Palmer A', 'Palmer A'),
          credit('run', 'Run: Chase T', 'Chase T', 'runner')
        ]
      })
    ).equals('Bottom 4th: Palmer A doubles. Chase T scores. 3–5')
  })

  it('reads a fielding credit off the engine’s own label', function () {
    expect(
      describePlay({
        eventType: 'field_out',
        inning: 1,
        halfInning: 'top',
        credits: [
          credit(
            'field_out',
            'Ground out: Jordan P (SS) to Casey B (1B)',
            'Jordan P',
            'fielder',
            'SS'
          ),
          credit('field_out', 'Fly out', 'Luke T', 'fielder')
        ]
      })
    ).equals(
      'Top 1st: Ground out, Jordan P (SS) to Casey B (1B). Fly out by Luke T.'
    )
  })

  it('gives a strikeout to the pitcher, or the catcher’s dropped third strike', function () {
    expect(
      describePlay({
        eventType: 'strikeout',
        inning: 2,
        halfInning: 'top',
        credits: [
          credit('strikeout', 'Strikeout: Colton N', 'Colton N', 'pitcher')
        ]
      })
    ).equals('Top 2nd: Colton N strikes out the batter.')
    expect(
      describePlay({
        eventType: 'strikeout',
        credits: [
          credit(
            'strikeout',
            'Dropped third strike: Dylan L',
            'Dylan L',
            'catcher'
          )
        ]
      })
    ).equals('Dylan L picks up a dropped third strike.')
  })

  it('names the play by its type when nobody is credited', function () {
    expect(
      describePlay({
        eventType: 'wild_pitch',
        inning: 3,
        halfInning: 'bottom',
        awayScore: 0,
        homeScore: 1,
        credits: []
      })
    ).equals('Bottom 3rd: Wild pitch. 0–1')
    expect(describePlay({ eventType: null, credits: [] })).equals('Play.')
  })

  it('falls back to the label when a credit has no name', function () {
    expect(
      describePlay({
        eventType: 'single',
        credits: [
          { eventType: 'single', label: 'Single: somebody', credit: null },
          { eventType: 'x', label: '', credit: null }
        ]
      })
    ).equals('Single. Play.')
  })

  it('writes the ordinal an inning is read as', function () {
    const nth = (inning: number): string =>
      describePlay({
        eventType: 'walk',
        inning,
        halfInning: 'top',
        credits: []
      })
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(nth)).deep.equals([
      'Top 1st: Walk.',
      'Top 2nd: Walk.',
      'Top 3rd: Walk.',
      'Top 4th: Walk.',
      'Top 11th: Walk.',
      'Top 12th: Walk.',
      'Top 13th: Walk.',
      'Top 21st: Walk.',
      'Top 22nd: Walk.',
      'Top 23rd: Walk.'
    ])
  })
})

describe('clauses by event type', function () {
  it('has an entry for every stored event type', function () {
    expect(Object.keys(DID_BY_TYPE).sort()).deep.equals(
      [...GUMBO_EVENT_TYPES].sort()
    )
    for (const eventType of GUMBO_EVENT_TYPES) {
      const text = describePlay({
        eventType,
        credits: [credit(eventType, 'Head: detail', 'Kai L')]
      })
      const did = DID_BY_TYPE[eventType]
      const expected =
        eventType === 'strikeout' || eventType === 'strikeout_double_play'
          ? 'Kai L picks up a dropped third strike.'
          : did != null
            ? `Kai L ${did}.`
            : 'Head, detail.'
      expect(text, eventType).equals(expected)
    }
  })

  it('says a pitcher struck out the batter on a strikeout double play', function () {
    expect(
      describePlay({
        eventType: 'strikeout_double_play',
        credits: [
          credit('strikeout_double_play', '', 'Ace P', 'pitcher'),
          credit('run', 'Run: Tom', 'Tom')
        ]
      })
    ).equals('Ace P strikes out the batter. Tom scores.')
  })
})
