import { expect } from 'chai'
import { describe, it } from 'mocha'

import { wallInstant } from '../fieldAvailability'
import {
  blockingCause,
  capacityCause,
  fieldCapacity,
  requestedTargets,
  seasonMatchups,
  teamCapacity
} from './capacity'
import { buildContext } from './context'
import { field, fixedGame, hoursOn, input, season, ZONE } from './fixtures.test'
import { buildOptions } from './index'
import { dayNumber } from './slots'
import type { EngineBooking, EngineInput } from './types'

const SATURDAYS = hoursOn([6], '08:00', '18:00')

/** Saturdays only, the field open the hours given. */
function saturdays(
  settings: Parameters<typeof season>[0] = {},
  fieldChanges: Partial<ReturnType<typeof field>['availability']> = {},
  changes: Partial<EngineInput> = {}
): EngineInput {
  return input({
    seasons: [
      season({
        endsOn: '2027-03-31',
        windows: [{ from: '2027-03-01', hours: SATURDAYS }],
        ...settings
      })
    ],
    fields: [
      field({
        availability: {
          ...field().availability,
          hours: SATURDAYS,
          ...fieldChanges
        }
      })
    ],
    ...changes
  })
}

const at = (date: string, time: string): number => wallInstant(date, time, ZONE)

function hawksBooked(date: string): EngineBooking {
  return {
    key: `bkg_${date}`,
    fieldId: null,
    size: null,
    teamIds: ['tem_hawks'],
    start: at(date, '07:00'),
    end: at(date, '19:00')
  }
}

describe('capacityCause', () => {
  it('phrases a lowered target’s cause against the requested count', () => {
    const { options, blocking } = buildOptions(saturdays({ regularGames: 8 }))
    expect(blocking).equals(null)
    expect(options[0].unmet).deep.equals([
      {
        seasonId: 'sea_demo',
        message: 'every team gets 4 of the 8 requested regular-season games',
        cause: 'not enough 50/70 field time to give every team 8 games'
      }
    ])
  }).timeout(30_000)

  it('names T-ball by its label', () => {
    const context = buildContext(
      saturdays({ fieldSize: '46/60', regularGames: 8 })
    )
    expect(capacityCause(context, context.seasons[0], 'regular', 8)).equals(
      'not enough T-ball 46/60 field time to give every team 8 games'
    )
    expect(capacityCause(context, context.seasons[0], 'regular', 1)).equals(
      'not enough T-ball 46/60 field time to give every team 1 game'
    )
  }).timeout(30_000)

  it('names a team whose own games leave it too few open dates', () => {
    const run = saturdays(
      { doubleheaders: 'never', regularGames: 4, exhibitionGames: 0 },
      {},
      {
        bookings: ['2027-03-06', '2027-03-13'].map(hawksBooked)
      }
    )
    const context = buildContext(run)
    expect(capacityCause(context, context.seasons[0], 'regular', 4)).equals(
      'Demo Hawks’s existing games leave too few open dates'
    )
    const { options } = buildOptions(run)
    expect(options[0].unmet[0]).deep.equals({
      seasonId: 'sea_demo',
      message: 'every team gets 2 of the 4 requested regular-season games',
      cause: 'Demo Hawks’s existing games leave too few open dates'
    })
  }).timeout(30_000)

  it('falls back to field time when no team is held back by its own games', () => {
    const context = buildContext(
      saturdays({ doubleheaders: 'never', regularGames: 6, exhibitionGames: 0 })
    )
    // Four Saturdays, one game a day each: field time enough, dates not.
    expect(capacityCause(context, context.seasons[0], 'regular', 6)).equals(
      'not enough 50/70 field time to give every team 6 games'
    )
  }).timeout(30_000)
})

describe('blockingCause', () => {
  // E10's last step: one Saturday, open 08:00–09:00, shorter than a game.
  const noSlot = (changes: Partial<EngineInput> = {}): EngineInput =>
    saturdays(
      { regularGames: 30 },
      {
        startsOn: '2027-03-06',
        endsOn: '2027-03-06',
        hours: hoursOn([6], '08:00', '09:00')
      },
      changes
    )

  it('blocks when no new game fits, even with fixed games and pending proposals', () => {
    const result = buildOptions(
      noSlot({
        fixed: [
          // A played game, and a proposal still waiting for consent.
          fixedGame(
            'g1',
            'tem_hawks',
            'tem_owls',
            '2027-03-06T14:00:00.000Z',
            60
          ),
          fixedGame(
            'g2',
            'tem_foxes',
            'tem_bears',
            '2027-03-07T15:00:00.000Z',
            90,
            {
              fieldId: null
            }
          )
        ]
      })
    )
    expect(result).deep.equals({
      options: [],
      blocking: 'not enough 50/70 field time to give every team 30 games'
    })
  }).timeout(30_000)

  it('gives an option, not a block, when one game fits', () => {
    const oneSlot = (fixed: EngineInput['fixed']): EngineInput =>
      saturdays(
        { regularGames: 30 },
        {
          startsOn: '2027-03-06',
          endsOn: '2027-03-06',
          hours: hoursOn([6], '08:00', '09:30')
        },
        { fixed }
      )
    // The Hawks and Owls already have a game, so the floor is one: the one
    // slot goes to two other teams and the totals are uneven.
    const result = buildOptions(
      oneSlot([
        fixedGame(
          'g1',
          'tem_hawks',
          'tem_owls',
          '2027-03-07T15:00:00.000Z',
          90,
          {
            fieldId: null
          }
        )
      ])
    )
    expect(result.blocking).equals(null)
    expect(result.options).length(1)
    expect(result.options[0].games).length(1)
    expect(result.options[0].unmet).length(2)
    expect(result.options[0].unmet[1].message).equals(
      'every team gets 0 of the 1 requested exhibition game'
    )
    expect(result.options[0].unmet[0].message).match(
      /^Demo \w+ gets 0 of 30 regular-season games; .*the others get 1 of 30$/
    )
    expect(result.options[0].unmet[0].cause).equals(
      'not enough 50/70 field time to give every team 30 games'
    )
    // With no fixed games the floor is zero, and equal counts give none.
    const none = buildOptions(oneSlot([]))
    expect(none.blocking).equals(null)
    expect(none.options).length(1)
    expect(none.options[0].games).length(0)
    expect(none.options[0].unmet[0].message).equals(
      'every team gets 0 of the 30 requested regular-season games'
    )
  }).timeout(30_000)

  it('does not block a run that needs nothing, and names exhibition counts', () => {
    const none = buildContext(noSlot({}))
    none.seasons[0].season.settings.regularGames = 0
    none.seasons[0].season.settings.exhibitionGames = 0
    expect(blockingCause(none)).equals(null)
    const exhibitionOnly = buildContext(noSlot({}))
    exhibitionOnly.seasons[0].season.settings.regularGames = 0
    expect(blockingCause(exhibitionOnly)).equals(
      'not enough 50/70 field time to give every team 1 exhibition game'
    )
  }).timeout(30_000)
})

describe('capacity helpers', () => {
  it('counts the games the field time holds around what is already there', () => {
    const one = (changes: Partial<EngineInput> = {}): number => {
      const context = buildContext(
        saturdays({ endsOn: '2027-03-06' }, {}, changes)
      )
      return fieldCapacity(context, context.seasons[0])
    }
    expect(one()).equals(6)
    expect(
      one({
        bookings: [
          {
            key: 'bkg_noon',
            fieldId: 'fld_one',
            size: '50/70',
            teamIds: [],
            start: at('2027-03-06', '12:00'),
            end: at('2027-03-06', '13:00')
          },
          {
            key: 'bkg_elsewhere',
            fieldId: 'fld_other',
            size: '50/70',
            teamIds: [],
            start: at('2027-03-06', '08:00'),
            end: at('2027-03-06', '18:00')
          }
        ]
      })
    ).equals(5)
    expect(
      one({
        fixed: [
          fixedGame(
            'g1',
            'tem_hawks',
            'tem_owls',
            new Date(at('2027-03-06', '07:00')).toISOString(),
            660
          )
        ]
      })
    ).equals(0)
  }).timeout(30_000)

  it('counts a field’s time in its own zone, wherever the field is', () => {
    // Saturdays 08:00–18:00 in Tokyo: the season's window is read there
    // too, so the field holds the same six games as one in Chicago.
    const tokyo = buildContext(
      saturdays({ endsOn: '2027-03-06' }, { timezone: 'Asia/Tokyo' })
    )
    const [demo] = tokyo.seasons
    expect(fieldCapacity(tokyo, demo)).equals(6)
    expect(
      demo.windows.map(window => new Date(window.start).toISOString())
    ).deep.equals(['2027-03-05T23:00:00.000Z'])
  }).timeout(30_000)

  it('reads a fixed game’s day in its field’s zone, or the run’s for a field outside it', () => {
    const run = (fields: EngineInput['fields']): EngineInput =>
      input({
        fields,
        notBefore: Date.parse('2027-03-02T03:00:00Z'),
        fixed: [
          // 01:00Z on March 7 is Saturday evening in Chicago.
          fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-03-07T01:00:00Z'),
          fixedGame(
            'g2',
            'tem_hawks',
            'tem_foxes',
            '2027-03-07T01:00:00Z',
            90,
            { fieldId: 'fld_elsewhere' }
          ),
          // And Sunday morning in Tokyo.
          fixedGame('g3', 'tem_owls', 'tem_foxes', '2027-03-07T01:00:00Z', 90, {
            fieldId: 'fld_tokyo'
          })
        ]
      })
    const tokyo = field({
      id: 'fld_tokyo',
      availability: { ...field().availability, timezone: 'Asia/Tokyo' }
    })
    const [demo] = buildContext(run([field(), tokyo])).seasons
    expect(demo.zoneOf('fld_tokyo')).equals('Asia/Tokyo')
    expect(demo.zoneOf('fld_elsewhere')).equals(ZONE)
    expect(demo.zoneOf(null)).equals(ZONE)
    expect(demo.fixed.map(entry => entry.point.date)).deep.equals([
      '2027-03-06',
      '2027-03-06',
      '2027-03-07'
    ])
    // Late on March 1 in Chicago it is already March 2 in Tokyo, so the
    // season can still get games from Chicago's March 1.
    expect(demo.firstDay).equals(dayNumber('2027-03-01'))
    // A season with no field of its size reads the run's first field.
    const [big] = buildContext(
      run([field({ sizes: ['60/90'], availability: tokyo.availability })])
    ).seasons
    expect(big.zoneOf(null)).equals('Asia/Tokyo')
    expect(big.firstDay).equals(dayNumber('2027-03-02'))
    expect(buildContext(run([])).seasons[0].zoneOf(null)).equals('UTC')
  }).timeout(30_000)

  it('counts the games a team could play with and without its own commitments', () => {
    const context = buildContext(
      saturdays(
        { endsOn: '2027-03-13', doubleheaders: 'never' },
        {},
        { bookings: [hawksBooked('2027-03-06')] }
      )
    )
    const [demo] = context.seasons
    expect(teamCapacity(demo, 'tem_hawks', true)).equals(1)
    expect(teamCapacity(demo, 'tem_hawks', false)).equals(2)
    demo.season.settings.doubleheaders = 'allowed'
    expect(teamCapacity(demo, 'tem_owls', true)).equals(12)
  }).timeout(30_000)

  it('reads the requested counts and builds the matchups for them', () => {
    const context = buildContext(saturdays())
    const [demo] = context.seasons
    expect(requestedTargets(demo)).deep.equals({ regular: 4, exhibition: 1 })
    expect(seasonMatchups(context, demo, requestedTargets(demo), 1)).length(21)
  }).timeout(30_000)
})
