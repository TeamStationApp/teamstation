import type { GameDetail, GameLineupsResponse, Lineup } from '../api'
import { freshGame, newSetup, type RosterPlayer } from '../scoring/lineup'
import { teamsOf, withSideLineup } from '../scoring/startingSetup'
import { setupOf } from '../scoring/state'
import { type ReplayBoxScore, replayBoxScore } from './replayBoxScore'

export function startingBox(
  game: GameDetail,
  lineups: GameLineupsResponse
): ReplayBoxScore | null {
  const chosen = {
    away: lineups.away.start ?? lineups.away.current,
    home: lineups.home.start ?? lineups.home.current
  }
  const roster = (lineup: Lineup | null): RosterPlayer[] => {
    const people = [
      ...(lineup?.batters ?? []),
      ...Object.values(lineup?.defense ?? {})
    ]
    return people.flatMap((person, index) =>
      person?.gumboId == null ||
      people.findIndex(other => other?.gumboId === person.gumboId) !== index
        ? []
        : [
            {
              gumboId: person.gumboId,
              shortName: person.name,
              jersey: person.jersey
            }
          ]
    )
  }
  const rosters = { away: roster(chosen.away), home: roster(chosen.home) }
  if (chosen.away === null && chosen.home === null) return null
  const teams = teamsOf(game)
  let state = freshGame(game.id, teams, newSetup(teams, rosters))
  for (const side of ['away', 'home'] as const) {
    const lineup = chosen[side]
    if (lineup !== null) state = withSideLineup(state, side, lineup)
  }
  const box = replayBoxScore(freshGame(game.id, teams, setupOf(state)))
  // Named, unregistered lineup slots are real starters too. These negative
  // keys identify display rows only; they never enter the scoring engine or API.
  for (const side of ['away', 'home'] as const) {
    const lineup = chosen[side]
    if (lineup === null) continue
    const known = box[side].batting
    box[side].batting = lineup.batters.map(
      (person, index) =>
        known.find(row => row.id === person.gumboId) ?? {
          id: -(index + 1),
          name: person.name,
          ab: 0,
          r: 0,
          h: 0,
          rbi: 0,
          bb: 0,
          k: 0,
          sub: false,
          current: false
        }
    )
    const pitcher = lineup.defense.P
    if (pitcher !== null && pitcher.gumboId === null)
      box[side].pitching = [
        {
          id: -1,
          name: pitcher.name,
          outs: 0,
          ip: '0.0',
          h: 0,
          r: 0,
          er: 0,
          bb: 0,
          k: 0,
          pc: 0,
          hbp: 0,
          strikes: 0,
          current: false
        }
      ]
  }
  return box
}
