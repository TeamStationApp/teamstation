import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildOptions } from '../../common/autoScheduler'
import { field, input, season } from '../../common/autoScheduler/fixtures.test'
import type {
  EngineResult,
  PlannedGame
} from '../../common/autoScheduler/types'
import { validatePlacements } from './previews'
import { deviceInput, type Snapshot } from './snapshot'

const game: PlannedGame = {
  key: 'one',
  seasonId: 'sea_demo',
  homeTeamId: 'tem_hawks',
  awayTeamId: 'tem_owls',
  exhibition: false,
  size: '50/70',
  fieldId: 'fld_one',
  startAt: '2027-03-06T16:00:00Z',
  endAt: '2027-03-06T17:30:00Z'
}
const snap = (): Snapshot => ({
  engine: input(),
  existing: 'workAround',
  teamIds: null,
  knownGameIds: [],
  replaceGameIds: [],
  reschedules: [],
  teams: [],
  seasons: [],
  fields: [field()]
})
const result = (...games: PlannedGame[]): EngineResult => ({
  options: [{ games, fairness: [], reasons: [], score: [], unmet: [] }],
  blocking: null
})
describe('untrusted device placements', () => {
  it('rejects collision with weekly reservation identifiers instead of skipping the cap', () => {
    const held = snap()
    held.engine.seasons = [season({ maxGamesOnWeekend: 1 })]
    held.engine.weeklyGames = [
      {
        seasonId: game.seasonId,
        fieldId: game.fieldId,
        teamIds: [game.homeTeamId],
        start: Date.parse('2027-03-06T14:00:00Z')
      }
    ]
    expect(() => {
      validatePlacements(held, result(game))
    }).throws('maximum of 1')
    expect(() => {
      validatePlacements(held, result({ ...game, key: 'weekly:0' }))
    }).throws('unique')
  })
  it('accepts ordinary games and rejects invalid identity, times, matchups and requested counts', () => {
    validatePlacements(snap(), result(game))
    for (const changes of [
      { seasonId: 'foreign' },
      { startAt: 'invalid' },
      { endAt: 'invalid' },
      { endAt: game.startAt },
      { key: '' },
      { key: 'x'.repeat(301) },
      { awayTeamId: game.homeTeamId },
      { endAt: '2027-03-06T17:35:00Z' },
      { homeTeamId: 'foreign' },
      { awayTeamId: 'foreign' },
      { exhibition: true },
      { size: '60/90' as const },
      { fieldId: 'foreign' }
    ])
      expect(() => {
        validatePlacements(snap(), result({ ...game, ...changes }))
      }).throws()
    expect(() => {
      validatePlacements(snap(), result(game, game))
    }).throws('unique')
    const fixed = snap()
    fixed.engine.fixed = [
      { ...game, start: Date.parse(game.startAt), end: Date.parse(game.endAt) }
    ]
    expect(() => {
      validatePlacements(fixed, result(game))
    }).throws('unique')
    const booked = snap()
    booked.engine.bookings = [
      {
        key: game.key,
        fieldId: game.fieldId,
        size: game.size,
        teamIds: [],
        start: Date.parse(game.startAt),
        end: Date.parse(game.endAt)
      }
    ]
    expect(() => {
      validatePlacements(booked, result(game))
    }).throws('unique')
    const limited = snap()
    limited.engine.seasons = [season({ regularGames: 0 })]
    expect(() => {
      validatePlacements(limited, result(game))
    }).throws('requested game counts')
    limited.engine.seasons = [season({ exhibitionGames: 0 })]
    const exhibition = { ...game, exhibition: true, awayTeamId: 'tem_otters' }
    expect(() => {
      validatePlacements(limited, result(exhibition))
    }).throws('requested game counts')
    validatePlacements(snap(), result(exhibition))
    validatePlacements(
      snap(),
      result({
        ...exhibition,
        homeTeamId: 'tem_otters',
        awayTeamId: game.homeTeamId
      })
    )
  })
  it('enforces partial and required matchup scope, permitting the original departed team', () => {
    const partial = snap()
    partial.engine.teamIds = [game.homeTeamId]
    expect(() => {
      validatePlacements(partial, result(game))
    }).throws('selected teams')
    partial.engine.teamIds.push(game.awayTeamId)
    validatePlacements(partial, result(game))
    partial.engine.required = [{ ...game, homeTeamId: 'departed' }]
    expect(() => {
      validatePlacements(partial, result(game))
    }).throws('requested games')
    validatePlacements(partial, result({ ...game, homeTeamId: 'departed' }))
  })
  it('checks explicit fields, weekly reservations, buffers and manager bookings', () => {
    const selected = snap()
    selected.engine.seasons[0].settings.fieldIds = []
    expect(() => {
      validatePlacements(selected, result(game))
    }).throws('selected')
    const weekly = snap()
    weekly.engine.seasons[0].settings.maxGamesOnWeekend = 1
    weekly.engine.weeklyGames = [
      {
        seasonId: game.seasonId,
        fieldId: game.fieldId,
        teamIds: [game.homeTeamId],
        start: Date.parse('2027-03-07T16:00:00Z')
      }
    ]
    expect(() => {
      validatePlacements(weekly, result(game))
    }).throws('maximum')
    weekly.engine.weeklyGames = []
    validatePlacements(weekly, result(game))
    const overlap = {
      ...game,
      key: 'two',
      homeTeamId: 'tem_foxes',
      awayTeamId: 'tem_bears'
    }
    expect(() => {
      validatePlacements(snap(), result(game, overlap))
    }).throws()
    const managers = snap()
    managers.engine.headCoaches = {
      [game.homeTeamId]: 'coach',
      [overlap.homeTeamId]: 'coach'
    }
    managers.engine.fields.push(field({ id: 'fld_two' }))
    managers.engine.seasons[0].settings.fieldIds!.push('fld_two')
    expect(() => {
      validatePlacements(
        managers,
        result(game, { ...overlap, fieldId: 'fld_two' })
      )
    }).throws('Manager')
  })
  it('sends the device tokens for other games, outside teams and coaches, and validates its result against the real input', () => {
    const held = snap()
    const engine = {
      ...held.engine,
      seasons: [season({ regularGames: 1, exhibitionGames: 0 })],
      headCoaches: { tem_hawks: 'usr_coach', tem_outside: 'usr_coach' },
      bookings: [
        {
          key: 'gam_other_league',
          fieldId: null,
          size: null,
          teamIds: ['tem_outside'],
          start: Date.parse('2027-03-06T13:00:00Z'),
          end: Date.parse('2027-03-06T15:00:00Z')
        }
      ],
      weeklyGames: [
        {
          seasonId: 'sea_other_league',
          fieldId: 'fld_other_league',
          teamIds: ['tem_hawks', 'tem_outside'],
          start: Date.parse('2027-03-06T13:00:00Z')
        }
      ]
    }
    held.engine = engine
    const sent = deviceInput(engine)
    const text = JSON.stringify(sent)
    for (const secret of [
      'gam_other_league',
      'tem_outside',
      'usr_coach',
      'sea_other_league',
      'fld_other_league'
    ])
      expect(text).not.includes(secret)
    expect(sent.headCoaches).deep.equals({
      tem_hawks: 'coach:1',
      'team:1': 'coach:1'
    })
    expect(sent.bookings[0]).includes({ key: 'busy:1' })
    expect(sent.bookings[0].teamIds).deep.equals(['team:1'])
    expect(sent.weeklyGames?.[0]).deep.includes({
      seasonId: 'season:1',
      fieldId: null,
      teamIds: ['tem_hawks', 'team:1']
    })
    expect(sent.seasons).deep.equals(engine.seasons)
    validatePlacements(held, buildOptions(sent))
  })
})
