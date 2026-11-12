import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildOptions } from '../../common/autoScheduler'
import { field, input, season } from '../../common/autoScheduler/fixtures.test'
import { deviceInput, type Snapshot } from './snapshot'

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
describe('the input a device searches', () => {
  it('sends the device tokens for other games, outside teams, seasons and coaches, and its games name only the run’s own', () => {
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
    const own = new Set([
      ...engine.seasons.flatMap(each => [
        ...each.participants,
        ...each.exhibitionTeams
      ])
    ])
    for (const option of buildOptions(sent).options)
      for (const placed of option.games)
        expect(own.has(placed.homeTeamId) && own.has(placed.awayTeamId)).equals(
          true
        )
  })
})
