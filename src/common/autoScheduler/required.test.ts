import { expect } from 'chai'
import { describe, it } from 'mocha'

import { field, fixedGame, hoursOn, input, season } from './fixtures.test'
import { buildOptions } from './index'
import type { EngineBooking, EngineInput } from './types'

type Required = NonNullable<EngineInput['required']>[number]

function matchup(
  key: string,
  home: string,
  away: string,
  exhibition = false
): Required {
  return {
    key,
    seasonId: 'sea_demo',
    homeTeamId: home,
    awayTeamId: away,
    exhibition
  }
}

/** March and April only, four regular games and one exhibition each. */
function run(changes: Partial<EngineInput> = {}): EngineInput {
  return input({ seasons: [season({ endsOn: '2027-04-30' })], ...changes })
}

// The Hawks are busy for the whole season.
const HAWKS_AWAY: EngineBooking = {
  key: 'bkg_hawks',
  fieldId: null,
  size: null,
  teamIds: ['tem_hawks'],
  start: Date.parse('2027-02-01T00:00:00Z'),
  end: Date.parse('2027-08-01T00:00:00Z')
}

describe('buildOptions with required matchups', () => {
  it('places a required matchup even when its teams’ counts are already met', () => {
    // Two regular games each asked for; the Hawks and Owls already have two.
    const fixed = [
      fixedGame('g1', 'tem_hawks', 'tem_bears', '2027-03-06T15:00:00.000Z'),
      fixedGame('g2', 'tem_foxes', 'tem_hawks', '2027-03-13T15:00:00.000Z'),
      fixedGame('g3', 'tem_owls', 'tem_wolves', '2027-03-20T15:00:00.000Z'),
      fixedGame('g4', 'tem_lynx', 'tem_owls', '2027-03-27T15:00:00.000Z')
    ]
    const result = buildOptions(
      run({
        seasons: [
          season({ endsOn: '2027-04-30', regularGames: 2, exhibitionGames: 0 })
        ],
        fixed,
        required: [matchup('row_1', 'tem_hawks', 'tem_owls')]
      })
    )
    expect(result.blocking).equals(null)
    const [best] = result.options
    expect(best.games).length(1)
    expect(best.games[0]).include({
      key: 'row_1',
      homeTeamId: 'tem_hawks',
      awayTeamId: 'tem_owls',
      exhibition: false
    })
    expect(best.unmet).deep.equals([])
    expect(
      best.fairness.find(row => row.teamId === 'tem_hawks')?.regularGames
    ).equals(3)
    expect(best.fairness).length(9)
  }).timeout(30_000)

  it('gives the keys, home, away and game type back unchanged, whatever teamIds says', () => {
    const required = [
      matchup('gam_a', 'tem_owls', 'tem_hawks'),
      matchup('gam_b', 'tem_bears', 'tem_foxes'),
      matchup('gam_c', 'tem_lynx', 'tem_otters', true)
    ]
    const { options } = buildOptions(run({ required, teamIds: ['tem_elks'] }))
    expect(options.length).greaterThan(0)
    for (const option of options) {
      const games = [...option.games].sort((a, b) => a.key.localeCompare(b.key))
      expect(
        games.map(game => [
          game.key,
          game.homeTeamId,
          game.awayTeamId,
          game.exhibition
        ])
      ).deep.equals(
        required.map(each => [
          each.key,
          each.homeTeamId,
          each.awayTeamId,
          each.exhibition
        ])
      )
      expect(option.unmet).deep.equals([])
    }
  }).timeout(30_000)

  it('reports a required matchup it couldn’t place, with the team that blocks it', () => {
    const { options, blocking } = buildOptions(
      run({
        bookings: [HAWKS_AWAY],
        required: [
          matchup('row_1', 'tem_hawks', 'tem_owls'),
          matchup('row_2', 'tem_bears', 'tem_foxes')
        ]
      })
    )
    expect(blocking).equals(null)
    for (const option of options) {
      expect(option.games.map(game => game.key)).deep.equals(['row_2'])
      expect(option.unmet).deep.equals([
        {
          seasonId: 'sea_demo',
          message: '1 of the 2 games to place again couldn’t be placed',
          cause: 'Demo Hawks’s existing games leave too few open dates'
        }
      ])
    }
  }).timeout(30_000)

  it('reports matchups the field time can’t hold', () => {
    // One Saturday with room for one game.
    const saturday = hoursOn([6], '08:00', '09:30')
    const { options } = buildOptions(
      input({
        seasons: [
          season({
            endsOn: '2027-03-06',
            windows: [{ from: '2027-03-01', hours: saturday }]
          })
        ],
        fields: [
          field({ availability: { ...field().availability, hours: saturday } })
        ],
        required: [
          matchup('row_1', 'tem_hawks', 'tem_owls'),
          matchup('row_2', 'tem_bears', 'tem_foxes')
        ]
      })
    )
    expect(options).length(1)
    expect(options[0].games).length(1)
    expect(options[0].unmet).deep.equals([
      {
        seasonId: 'sea_demo',
        message: '1 of the 2 games to place again couldn’t be placed',
        cause: 'not enough 50/70 field time to place 2 games again'
      }
    ])
  }).timeout(30_000)

  it('blocks when none of them can be placed', () => {
    expect(
      buildOptions(
        run({
          bookings: [HAWKS_AWAY],
          required: [matchup('row_1', 'tem_hawks', 'tem_owls')]
        })
      )
    ).deep.equals({
      options: [],
      blocking: 'Demo Hawks’s existing games leave too few open dates'
    })
    expect(
      buildOptions(
        run({
          fields: [field({ sizes: ['46/60'] })],
          required: [matchup('row_1', 'tem_hawks', 'tem_owls')]
        })
      )
    ).deep.equals({
      options: [],
      blocking: 'not enough 50/70 field time to place 1 game again'
    })
  }).timeout(30_000)

  it('still offers options that differ, with reasons', () => {
    const required = [
      matchup('row_1', 'tem_hawks', 'tem_owls'),
      matchup('row_2', 'tem_bears', 'tem_foxes'),
      matchup('row_3', 'tem_wolves', 'tem_lynx'),
      matchup('row_4', 'tem_elks', 'tem_hawks'),
      matchup('row_5', 'tem_owls', 'tem_bears'),
      matchup('row_6', 'tem_foxes', 'tem_otters', true)
    ]
    const { options } = buildOptions(run({ required }))
    expect(options).length(3)
    const slotsOf = (index: number): string[] =>
      options[index].games.map(game => `${game.fieldId}|${game.startAt}`)
    for (let later = 1; later < 3; later++) {
      expect(options[later].reasons.length).greaterThan(0)
      for (let earlier = 0; earlier < later; earlier++) {
        const theirs = new Set(slotsOf(earlier))
        const different = slotsOf(later).filter(key => !theirs.has(key)).length
        expect(different / required.length).at.least(0.25)
      }
    }
  }).timeout(30_000)

  it('gives one empty option when there is nothing to place', () => {
    const result = buildOptions(run({ required: [] }))
    expect(result.blocking).equals(null)
    expect(result.options).length(1)
    const [only] = result.options
    expect(only.games).deep.equals([])
    expect(only.unmet).deep.equals([])
    expect(only.reasons).deep.equals([])
    expect(only.fairness).length(9)
    expect(only.fairness.every(row => row.regularGames === 0)).equals(true)
  }).timeout(30_000)

  it('ignores matchups of other seasons and places a team outside the season’s lists', () => {
    const { options } = buildOptions(
      run({
        required: [
          {
            ...matchup('row_x', 'tem_hawks', 'tem_owls'),
            seasonId: 'sea_other'
          },
          matchup('row_1', 'tem_hawks', 'tem_guests')
        ]
      })
    )
    expect(options[0].games.map(game => game.key)).deep.equals(['row_1'])
    expect(options[0].fairness.some(row => row.teamId === 'tem_guests')).equals(
      false
    )
  }).timeout(30_000)
})
