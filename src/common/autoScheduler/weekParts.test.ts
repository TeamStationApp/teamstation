import { expect } from 'chai'
import { describe, it } from 'mocha'

import { wallInstant } from '../fieldAvailability'
import { gameWeekPart, weekPartMaximum } from '../gameWeekPart'
import {
  asScheduleSettings,
  defaultScheduleSettings
} from '../seasonScheduling'
import { teamCapacity } from './capacity'
import { buildContext, type RunContext } from './context'
import { Occupancy } from './feasibility'
import {
  field,
  fixedGame,
  hoursOn,
  input,
  present,
  season,
  ZONE
} from './fixtures.test'
import { buildOptions } from './index'
import { compareScores, PREFERENCE, SeasonLedger } from './score'
import { dayNumber, type Slot } from './slots'

const hours = hoursOn([0, 1, 2, 3, 4, 5, 6], '08:00', '20:00')
function world(
  changes: Parameters<typeof season>[0] = {},
  fixed: Array<ReturnType<typeof fixedGame>> = []
): RunContext {
  return buildContext(
    input({
      seasons: [
        season({
          startsOn: '2027-03-01',
          endsOn: '2027-03-21',
          windows: [{ from: '2027-03-01', hours }],
          maxGamesOnWeekdays: 1,
          maxGamesOnWeekend: 1,
          ...changes
        })
      ],
      fields: [field({ availability: { ...field().availability, hours } })],
      fixed
    })
  )
}
const slotAt = (
  context: ReturnType<typeof world>,
  date: string,
  time = '08:00'
): Slot =>
  present(
    context.seasons[0].slots.find(
      slot => slot.start === wallInstant(date, time, ZONE)
    )
  )

describe('weekly game portions', () => {
  it('groups local dates into Monday–Friday and Saturday–Sunday, across years and DST', () => {
    for (const [a, b] of [
      ['2027-03-01', '2027-03-05'],
      ['2027-03-13', '2027-03-14'],
      ['2026-12-28', '2027-01-01'],
      ['1969-12-27', '1969-12-28']
    ])
      expect(gameWeekPart(dayNumber(a)).key).equals(
        gameWeekPart(dayNumber(b)).key
      )
    expect(gameWeekPart(dayNumber('2027-03-07')).key).not.equals(
      gameWeekPart(dayNumber('2027-03-08')).key
    )
    expect(weekPartMaximum({}, 'weekdays')).equals(1)
    expect(weekPartMaximum({}, 'weekend')).equals(1)
  })
  it('defaults to 1/1/weekend and rejects malformed maximums and preferences', () => {
    const defaults = defaultScheduleSettings({
      year: 2027,
      startsOn: null,
      endsOn: null
    })
    expect(defaults).includes({
      maxGamesOnWeekdays: 1,
      maxGamesOnWeekend: 1,
      preferGameOn: 'weekend'
    })
    for (const key of ['maxGamesOnWeekdays', 'maxGamesOnWeekend']) {
      for (const value of [null, -1, 0.5, 201, '1'])
        expect(() => asScheduleSettings({ ...defaults, [key]: value })).throws()
      expect(
        asScheduleSettings({ ...defaults, [key]: undefined })[
          key as 'maxGamesOnWeekdays'
        ]
      ).equals(1)
    }
    expect(
      asScheduleSettings({ ...defaults, preferGameOn: undefined }).preferGameOn
    ).equals('weekend')
    for (const preferGameOn of [null, 'daily', 1])
      expect(() => asScheduleSettings({ ...defaults, preferGameOn })).throws()
  })
  it('counts each team across its portion, releases unplaced games, and resets next week', () => {
    const context = world()
    const s = context.seasons[0]
    const o = new Occupancy(context)
    const mon = slotAt(context, '2027-03-01')
    const fri = slotAt(context, '2027-03-05')
    const sat = slotAt(context, '2027-03-06')
    const sun = slotAt(context, '2027-03-07')
    o.place(0, s, 'a', 'b', mon)
    expect(o.teamFits(s, 'a', fri)).equals(false)
    expect(o.teamFits(s, 'b', fri)).equals(false)
    expect(o.teamFits(s, 'other', fri)).equals(true)
    expect(o.teamFits(s, 'a', sat)).equals(true)
    o.place(1, s, 'a', 'exhibition', sat)
    expect(o.teamFits(s, 'a', sun)).equals(false)
    expect(o.teamFits(s, 'exhibition', sun)).equals(false)
    expect(o.teamFits(s, 'a', slotAt(context, '2027-03-08'))).equals(true)
    o.unplace(0, s, 'a', 'b', mon)
    expect(o.teamFits(s, 'a', fri)).equals(true)
  })
  it('counts fixed games even without a run field and keeps doubleheaders independent', () => {
    const fixed = fixedGame(
      'fixed',
      'tem_hawks',
      'tem_owls',
      new Date(wallInstant('2027-03-06', '08:00', ZONE)).toISOString(),
      90,
      { fieldId: null }
    )
    for (const doubleheaders of ['never', 'ifNecessary', 'allowed'] as const) {
      const context = world({ maxGamesOnWeekend: 2, doubleheaders }, [fixed])
      const s = context.seasons[0]
      const o = new Occupancy(context)
      expect(
        o.teamFits(s, fixed.homeTeamId, slotAt(context, '2027-03-06', '11:00'))
      ).equals(doubleheaders !== 'never')
      expect(
        o.teamFits(s, fixed.homeTeamId, slotAt(context, '2027-03-07'))
      ).equals(true)
    }
    const context = world({}, [fixed])
    const o = new Occupancy(context)
    expect(
      o.teamFits(
        context.seasons[0],
        fixed.homeTeamId,
        slotAt(context, '2027-03-07')
      )
    ).equals(false)
    expect(teamCapacity(context.seasons[0], fixed.homeTeamId, true)).equals(5)
    expect(teamCapacity(context.seasons[0], fixed.homeTeamId, false)).equals(6)
  })
  it('uses live weekly holdings without double-counting the scheduled game a proposal changes', () => {
    const original = fixedGame(
      'original',
      'tem_hawks',
      'tem_owls',
      new Date(wallInstant('2027-03-06', '08:00', ZONE)).toISOString(),
      90
    )
    const run = world({}, [original]).input
    const teamIds = [original.homeTeamId, original.awayTeamId]
    run.weeklyGames = [
      {
        seasonId: run.seasons[0].id,
        fieldId: original.fieldId,
        teamIds,
        start: wallInstant('2027-03-01', '08:00', ZONE)
      }
    ]
    const context = buildContext(run)
    const s = context.seasons[0]
    const occupancy = new Occupancy(context)
    expect(
      occupancy.teamFits(s, teamIds[0], slotAt(context, '2027-03-05'))
    ).equals(false)
    expect(
      occupancy.teamFits(s, teamIds[0], slotAt(context, '2027-03-06', '11:00'))
    ).equals(true)
    expect(occupancy.gamesOn(s, teamIds[0], dayNumber('2027-03-06'))).equals(1)
    expect(teamCapacity(s, teamIds[0], true)).equals(5)
    const sat = slotAt(context, '2027-03-06', '11:00')
    occupancy.place(0, s, teamIds[0], teamIds[1], sat)
    expect(
      occupancy.teamFits(s, teamIds[0], slotAt(context, '2027-03-07'))
    ).equals(false)
    occupancy.unplace(0, s, teamIds[0], teamIds[1], sat)
    expect(
      occupancy.teamFits(s, teamIds[0], slotAt(context, '2027-03-07'))
    ).equals(true)
  })

  it('allows zero, and capacity never exceeds the remaining portion allowance', () => {
    const context = world({ maxGamesOnWeekdays: 0, maxGamesOnWeekend: 2 })
    const s = context.seasons[0]
    const o = new Occupancy(context)
    expect(o.teamFits(s, 'a', slotAt(context, '2027-03-01'))).equals(false)
    expect(o.teamFits(s, 'a', slotAt(context, '2027-03-06'))).equals(true)
    expect(teamCapacity(s, 'a', false)).equals(6)
  })
  it('names binding weekly maximums for shortages and blocked recalculations, while retaining field shortages', () => {
    const context = world({
      endsOn: '2027-03-07',
      regularGames: 4,
      exhibitionGames: 0
    })
    const result = buildOptions(context.input)
    expect(result.options[0].unmet[0].cause).includes(
      'weekday/weekend game maximums'
    )
    const exhibitionLimited = structuredClone(context.input)
    exhibitionLimited.seasons[0].settings.regularGames = 0
    exhibitionLimited.seasons[0].settings.exhibitionGames = 1
    exhibitionLimited.seasons[0].exhibitionTeams = [
      exhibitionLimited.seasons[0].exhibitionTeams[0]
    ]
    expect(buildOptions(exhibitionLimited).options[0].unmet[0].cause).includes(
      'weekday/weekend game maximums'
    )
    const limitedField = structuredClone(context.input)
    limitedField.fields[0].availability.hours = hoursOn([6], '08:00', '09:30')
    expect(buildOptions(limitedField).options[0].unmet[0].cause).includes(
      'field time'
    )
    context.input.seasons[0].settings.maxGamesOnWeekdays = 0
    context.input.seasons[0].settings.maxGamesOnWeekend = 0
    expect(buildOptions(context.input).blocking).includes(
      'weekday/weekend game maximums'
    )
    const [homeTeamId, awayTeamId] = context.input.seasons[0].participants
    context.input.required = [
      {
        key: 'replacement',
        seasonId: context.input.seasons[0].id,
        homeTeamId,
        awayTeamId,
        exhibition: false
      }
    ]
    expect(buildOptions(context.input).blocking).includes(
      'weekday/weekend game maximums'
    )
  }).timeout(60000)

  it('ranks the chosen portion before balance, but after placing games', () => {
    for (const preferGameOn of ['weekend', 'weekdays'] as const) {
      const context = world({ preferGameOn })
      const s = context.seasons[0]
      const ledger = new SeasonLedger(s, 1, new Map())
      const weekday = slotAt(context, '2027-03-01')
      const weekend = slotAt(context, '2027-03-06')
      ledger.add(s.teams[0], s.teams[1], weekday, 0)
      const weekdayScore = ledger.score()
      ledger.remove(s.teams[0], s.teams[1], weekday, 0)
      ledger.add(s.teams[0], s.teams[1], weekend, 0)
      expect(compareScores(ledger.score(), weekdayScore)).equals(
        preferGameOn === 'weekend' ? -1 : 1
      )
      expect(ledger.score()[PREFERENCE]).equals(
        preferGameOn === 'weekend' ? 0 : 2
      )
    }
    expect(compareScores([0, 0, 9, 9, 9, 9, 2], [1, 0, 0, 0, 0, 0, 0])).equals(
      -1
    )
  })
  it('builds in the preferred portion and falls back when only the other portion is open', () => {
    for (const preferGameOn of ['weekend', 'weekdays'] as const) {
      const context = world({
        regularGames: 1,
        exhibitionGames: 0,
        preferGameOn
      })
      const options = buildOptions(context.input)
      expect(options.options[0].games.length).greaterThan(0)
      for (const game of options.options[0].games) {
        const point = context.seasons[0].clock.pointOf(
          Date.parse(game.startAt),
          ZONE
        )
        expect(gameWeekPart(point.day).part).equals(preferGameOn)
      }
      context.input.seasons[0].settings.maxGamesOnWeekend =
        preferGameOn === 'weekend' ? 0 : 1
      context.input.seasons[0].settings.maxGamesOnWeekdays =
        preferGameOn === 'weekdays' ? 0 : 1
      const fallback = buildOptions(context.input)
      expect(fallback.options[0].games.length).equals(
        options.options[0].games.length
      )
    }
  }).timeout(60000)
})
