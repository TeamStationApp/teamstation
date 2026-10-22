import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  EXHIBITION_TEAMS,
  fixedGame,
  PARTICIPANTS,
  season
} from './fixtures.test'
import {
  buildMatchups,
  exhibitionOpponents,
  fixedCounts,
  type Matchup,
  orient,
  regularPairs,
  seasonNeeds,
  seasonTeams
} from './matchups'
import { mulberry32 } from './random'
import type { EngineSeason, FixedGame } from './types'

function matchups(
  of: EngineSeason,
  fixed: FixedGame[] = [],
  active: Set<string> | null = null,
  seed = 1
): Matchup[] {
  return buildMatchups(
    of,
    {
      regular: of.settings.regularGames,
      exhibition: of.settings.exhibitionGames
    },
    fixed,
    active,
    mulberry32(seed)
  )
}

function gamesOf(list: Matchup[], team: string, exhibition: boolean): number {
  return list.filter(
    game =>
      game.exhibition === exhibition &&
      (game.homeTeamId === team || game.awayTeamId === team)
  ).length
}

function meetings(list: Matchup[]): Map<string, number> {
  const met = new Map<string, number>()
  for (const game of list) {
    const key = [game.homeTeamId, game.awayTeamId].sort().join('|')
    met.set(key, (met.get(key) ?? 0) + 1)
  }
  return met
}

const teams = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `tem_${i}`)

describe('buildMatchups', () => {
  it('gives every participant its regular and exhibition games', () => {
    const list = matchups(season())
    expect(list).length(14 + 7)
    for (const team of PARTICIPANTS) {
      expect(gamesOf(list, team, false)).equals(4)
      expect(gamesOf(list, team, true)).equals(1)
    }
  })

  it('keeps opponents even within one', () => {
    for (const [n, games] of [
      [7, 4],
      [8, 10],
      [6, 7],
      [10, 12]
    ]) {
      for (const seed of [1, 2, 3]) {
        const list = matchups(
          season(
            { regularGames: games, exhibitionGames: 0 },
            { participants: teams(n), exhibitionTeams: [] }
          ),
          [],
          null,
          seed
        )
        const low = Math.floor(games / (n - 1))
        const high = Math.ceil(games / (n - 1))
        const met = meetings(list)
        const counts: number[] = []
        for (let a = 0; a < n; a++)
          for (let b = a + 1; b < n; b++)
            counts.push(met.get(`tem_${a}|tem_${b}`) ?? 0)
        expect(Math.min(...counts), `${n}×${games}`).at.least(low)
        expect(Math.max(...counts), `${n}×${games}`).at.most(high)
        for (const team of teams(n))
          expect(gamesOf(list, team, false)).equals(games)
      }
    }
  })

  it('spreads exhibition games over the exhibition teams, never pairing two of them', () => {
    const list = matchups(season())
    expect(gamesOf(list, 'tem_otters', true)).equals(4)
    expect(gamesOf(list, 'tem_herons', true)).equals(3)
    for (const game of list) {
      const flagged = [game.homeTeamId, game.awayTeamId].filter(team =>
        EXHIBITION_TEAMS.includes(team)
      )
      expect(flagged.length).at.most(1)
      expect(flagged.length === 1).equals(game.exhibition)
    }
    const three = matchups(
      season(
        { exhibitionGames: 3 },
        { exhibitionTeams: ['tem_x1', 'tem_x2', 'tem_x3'] }
      )
    )
    for (const team of ['tem_x1', 'tem_x2', 'tem_x3'])
      expect(gamesOf(three, team, true)).equals(7)
    for (const team of PARTICIPANTS) {
      const opponents = three
        .filter(
          game =>
            game.exhibition &&
            (game.homeTeamId === team || game.awayTeamId === team)
        )
        .map(game =>
          game.homeTeamId === team ? game.awayTeamId : game.homeTeamId
        )
      expect(new Set(opponents).size).equals(3)
    }
  })

  it('balances home and away within one for every team', () => {
    for (const [n, games, exhibition] of [
      [7, 4, 1],
      [8, 9, 2],
      [5, 6, 0]
    ]) {
      const list = matchups(
        season(
          { regularGames: games, exhibitionGames: exhibition },
          { participants: teams(n) }
        )
      )
      for (const team of [...teams(n), ...EXHIBITION_TEAMS]) {
        const home = list.filter(game => game.homeTeamId === team).length
        const away = list.filter(game => game.awayTeamId === team).length
        expect(Math.abs(home - away), team).at.most(1)
      }
    }
  })

  it('counts fixed games toward the need, by type', () => {
    const fixed = [
      fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-04-10T15:00:00Z'),
      fixedGame('g2', 'tem_hawks', 'tem_otters', '2027-04-17T15:00:00Z', 90, {
        exhibition: true
      }),
      fixedGame('g3', 'tem_bears', 'tem_owls', '2027-04-17T15:00:00Z', 90, {
        seasonId: 'sea_other'
      })
    ]
    const list = matchups(season(), fixed)
    expect(gamesOf(list, 'tem_hawks', false)).equals(3)
    expect(gamesOf(list, 'tem_owls', false)).equals(3)
    expect(gamesOf(list, 'tem_bears', false)).equals(4)
    expect(gamesOf(list, 'tem_hawks', true)).equals(0)
    expect(gamesOf(list, 'tem_owls', true)).equals(1)
    // Hawks and Owls already met, so they don't meet again.
    expect(meetings(list).get('tem_hawks|tem_owls') ?? 0).equals(0)
  })

  it('gives teams left out of a partial run no new games', () => {
    const active = new Set(['tem_hawks', 'tem_owls', 'tem_otters'])
    const list = matchups(season({ regularGames: 2 }), [], active)
    for (const game of list) {
      expect(active.has(game.homeTeamId)).equals(true)
      expect(active.has(game.awayTeamId)).equals(true)
    }
    expect(gamesOf(list, 'tem_hawks', false)).equals(2)
    expect(gamesOf(list, 'tem_owls', false)).equals(2)
    // Hawks are assigned the Otters; the Owls the Herons, who sit this out.
    expect(gamesOf(list, 'tem_hawks', true)).equals(1)
    expect(gamesOf(list, 'tem_owls', true)).equals(0)
  })

  it('keys games stably and repeats for the same seed', () => {
    const list = matchups(
      season(
        { regularGames: 6, exhibitionGames: 0 },
        { participants: teams(3), exhibitionTeams: [] }
      )
    )
    expect(new Set(list.map(game => game.key)).size).equals(list.length)
    expect(list[0].key).match(/^sea_demo:tem_\d:tem_\d:1$/)
    expect(list.some(game => game.key.endsWith(':2'))).equals(true)
    expect(matchups(season(), [], null, 5)).deep.equals(
      matchups(season(), [], null, 5)
    )
  })

  it('has no exhibition games without exhibition teams', () => {
    const list = matchups(season({}, { exhibitionTeams: [] }))
    expect(list.filter(game => game.exhibition)).length(0)
    expect(exhibitionOpponents(0, 2, [], [], 2)).deep.equals([])
  })
})

describe('matchup helpers', () => {
  it('lists the season’s teams and counts its fixed games', () => {
    expect(seasonTeams(season())).deep.equals([
      ...PARTICIPANTS,
      ...EXHIBITION_TEAMS
    ])
    const counts = fixedCounts(season(), [
      fixedGame('g1', 'tem_hawks', 'tem_outside', '2027-04-10T15:00:00Z')
    ])
    expect(counts.get('tem_hawks')).deep.equals({ regular: 1, exhibition: 0 })
    expect(counts.has('tem_outside')).equals(false)
  })

  it('never lets a fixed count make a need negative', () => {
    const counts = new Map([['tem_hawks', { regular: 6, exhibition: 0 }]])
    const needs = seasonNeeds(
      season(),
      { regular: 4, exhibition: 1 },
      counts,
      null
    )
    expect(needs.get('tem_hawks')).deep.equals({ regular: 0, exhibition: 1 })
    expect(needs.get('tem_owls')).deep.equals({ regular: 4, exhibition: 1 })
  })

  it('stops pairing when only one team still needs games', () => {
    const pairs = regularPairs(
      ['a', 'b', 'c'],
      new Map([
        ['a', 3],
        ['b', 1],
        ['c', 0]
      ]),
      new Map(),
      1
    )
    expect(pairs).deep.equals([['a', 'b']])
  })

  it('crosses fixed exhibition opponents off the assigned ones', () => {
    expect(exhibitionOpponents(1, 2, ['x', 'y', 'z'], ['z'], 1)).deep.equals([
      'x'
    ])
    expect(exhibitionOpponents(0, 2, ['x', 'y', 'z'], ['z'], 1)).deep.equals([
      'x'
    ])
  })

  it('evens out hosting, counting fixed games', () => {
    const oriented = orient(
      [
        ['a', 'b'],
        ['a', 'c']
      ],
      [fixedGame('g1', 'a', 'b', '2027-04-10T15:00:00Z')]
    )
    expect(oriented).deep.equals([
      ['b', 'a'],
      ['a', 'c']
    ])
    // Fixed games can lean a team further than new games can even out.
    const lopsided = [1, 2, 3].map(i =>
      fixedGame(`g${i}`, 'a', 'b', '2027-04-10T15:00:00Z')
    )
    expect(orient([['c', 'd']], lopsided)).deep.equals([['c', 'd']])
  })
})
