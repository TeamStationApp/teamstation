import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { FieldSize } from '../../common/venues'
import { type Holding, type RuleContext, ruleProblem } from './rules'

const MINUTE = 60 * 1000
const at = (time: string): number => Date.parse(`2027-03-06T${time}:00Z`)

const context = (others: Holding[]): RuleContext => ({
  fields: new Map([
    [
      'fld_one',
      {
        name: 'Field 1',
        venueName: 'Demo Park',
        sizes: ['50/70'],
        availability: {
          startsOn: null,
          endsOn: null,
          // 2027-03-06 is a Saturday, open all day.
          hours: [{ weekday: 6, start: '00:00', end: '24:00' }],
          blackouts: [],
          timezone: 'UTC'
        },
        switchMs: 0
      }
    ]
  ]),
  seasons: new Map([
    ['sea_a', { bufferMinutes: 30, doubleheaders: 'allowed', timezone: 'UTC' }],
    ['sea_b', { bufferMinutes: 0, doubleheaders: 'allowed', timezone: 'UTC' }]
  ]),
  others
})

const game = (
  key: string,
  seasonId: string,
  start: string,
  end: string,
  teamIds: string[]
): Holding & { fieldId: string; size: FieldSize; seasonId: string } => ({
  key,
  fieldId: 'fld_one',
  size: '50/70',
  teamIds,
  seasonId,
  start: at(start),
  end: at(end)
})

/** The rule's answer on field spacing alone, open hours aside. */
const tooClose = (
  checked: ReturnType<typeof game>,
  other: Holding
): boolean => {
  const problem = ruleProblem(checked, context([other]))
  return problem?.startsWith('Another game on') === true
}

describe('the scheduler’s hard rules', () => {
  it('spaces games of two seasons on one field by the later game’s buffer, as the engine does', () => {
    // Season A asks 30 minutes between games, season B none.
    const a = game('a', 'sea_a', '10:30', '12:00', ['tem_one', 'tem_two'])
    const bRightAfter = game('b', 'sea_b', '12:00', '13:30', [
      'tem_three',
      'tem_four'
    ])
    // B comes later and asks nothing: both checks agree it fits.
    expect(tooClose(a, bRightAfter)).equals(false)
    expect(tooClose(bRightAfter, a)).equals(false)
    // A comes later, 10 minutes after B: its 30 minutes are not kept.
    const bBefore = game('b', 'sea_b', '08:30', '10:20', [
      'tem_three',
      'tem_four'
    ])
    expect(tooClose(a, bBefore)).equals(true)
    expect(tooClose(bBefore, a)).equals(true)
    // 30 minutes after B, it fits either way round.
    const bEarlier = { ...bBefore, end: a.start - 30 * MINUTE }
    expect(tooClose(a, bEarlier)).equals(false)
    expect(tooClose(bEarlier, a)).equals(false)
  })

  it('takes the checked game’s buffer for a booking outside the run', () => {
    const a = game('a', 'sea_a', '10:30', '12:00', ['tem_one', 'tem_two'])
    const outside: Holding = {
      key: 'bkg_outside',
      fieldId: 'fld_one',
      size: '50/70',
      teamIds: [],
      seasonId: null,
      start: at('12:20'),
      end: at('13:30')
    }
    expect(tooClose(a, outside)).equals(true)
    expect(tooClose(a, { ...outside, start: at('12:30') })).equals(false)
  })
})
