import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type SeasonResult,
  seasonStandings,
  type SeasonTeam
} from './seasonStandings'

const teams: SeasonTeam[] = ['A', 'B', 'C', 'Idle'].map(id => ({
  id,
  name: id,
  kind: id === 'C' ? 'external' : 'full',
  logoPath: null
}))
const game = (
  id: string,
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number | null,
  awayScore: number | null,
  exhibition = false,
  status = 'final'
): SeasonResult => ({
  id,
  homeTeamId,
  awayTeamId,
  homeScore,
  awayScore,
  exhibition,
  status,
  startAt: '2027-04-01T12:00:00Z'
})

describe('season standings arithmetic', () => {
  it('counts ties as half a win, GB, run differential, split records and deterministic streaks', () => {
    const rows = seasonStandings(teams, [
      game('1', 'A', 'B', 5, 2),
      game('2', 'B', 'A', 2, 2),
      game('3', 'C', 'A', 0, 4)
    ])
    expect(rows.map(row => row.teamId)).deep.equals(['A', 'B', 'C', 'Idle'])
    expect(rows[0]).deep.include({
      w: 2,
      l: 0,
      t: 1,
      winningPct: 0.833,
      runsFor: 11,
      runsAgainst: 4,
      runDifferential: 7,
      gamesBehind: 0,
      streak: 'W1'
    })
    expect(rows[0].home).deep.equals({ w: 1, l: 0, t: 0 })
    expect(rows[0].away).deep.equals({ w: 1, l: 0, t: 1 })
    expect(rows[1]).deep.include({
      winningPct: 0.25,
      gamesBehind: 1.5,
      streak: 'T1'
    })
    expect(rows[2]).deep.include({ teamKind: 'external', streak: 'L1' })
    expect(rows[3]).deep.include({
      winningPct: null,
      gamesBehind: null,
      streak: null
    })
  })
  it('keeps classification independent of team kind and ignores canceled, unfinished and scoreless results', () => {
    const games = [
      game('1', 'C', 'A', 7, 1),
      game('2', 'A', 'B', 9, 0, true),
      game('3', 'A', 'B', 10, 0, false, 'cancelled'),
      game('4', 'A', 'B', null, 0),
      game('5', 'A', 'B', 10, 0, false, 'scheduled'),
      game('6', 'A', 'B', 10, 0, false, 'inProgress')
    ]
    expect(
      seasonStandings(teams, games, false).find(row => row.teamId === 'A')
    ).deep.include({ w: 0, l: 1, played: 1 })
    expect(
      seasonStandings(teams, games).find(row => row.teamId === 'A')
    ).deep.include({ w: 1, l: 1, played: 2 })
  })
  it('orders equal records by differential, then name and ID; handles consecutive outcomes and an empty season', () => {
    const tied = [...teams, { ...teams[0], id: 'A2' }]
    expect(seasonStandings(tied, []).map(row => row.teamId)).deep.equals([
      'A',
      'A2',
      'B',
      'C',
      'Idle'
    ])
    expect(seasonStandings([], [])).deep.equals([])
    const games = [
      game('3', 'A', 'B', 0, 3),
      game('1', 'A', 'B', 0, 3),
      game('2', 'A', 'B', 0, 3)
    ]
    expect(
      seasonStandings(teams, games).find(row => row.teamId === 'A')?.streak
    ).equals('L3')
  })
})
