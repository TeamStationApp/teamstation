import type { GameDetail, RosterEntry } from '../../common/api'
import { allocatePlayer, createIdentityMap } from './playerIdentity'
import { startAppearance } from './scoringSelectors'
import {
  POSITIONS,
  type ScoringSessionState,
  type ScoringSide,
  type Side
} from './scoringTypes'

export function createDevelopmentSession(
  game: GameDetail,
  away: RosterEntry[],
  home: RosterEntry[]
): ScoringSessionState {
  const emptySide = (): ScoringSide => ({
    players: [],
    battingOrder: [],
    battingIndex: 0,
    defense: {
      P: null,
      C: null,
      '1B': null,
      '2B': null,
      SS: null,
      '3B': null,
      LF: null,
      CF: null,
      RF: null
    },
    pitchCounts: {}
  })
  const session: ScoringSessionState = {
    gamePk: game.id,
    gameData: {
      teams: {
        away: { id: game.awayTeamId, name: game.awayTeamName },
        home: { id: game.homeTeamId, name: game.homeTeamName }
      },
      players: {}
    },
    liveData: {
      linescore: {
        currentInning: 1,
        currentInningOrdinal: '1st',
        inningState: 'Top',
        isTopInning: true,
        balls: 0,
        strikes: 0,
        outs: 0,
        teams: {
          away: { runs: 0, hits: 0, errors: 0 },
          home: { runs: 0, hits: 0, errors: 0 }
        },
        offense: { batter: null, first: null, second: null, third: null },
        defense: {
          P: null,
          C: null,
          '1B': null,
          '2B': null,
          SS: null,
          '3B': null,
          LF: null,
          CF: null,
          RF: null
        }
      },
      boxscore: { teams: { away: emptySide(), home: emptySide() } },
      plays: { allPlays: [], currentPlay: null }
    },
    meta: {
      source: 'local-development',
      sequence: 0,
      identities: createIdentityMap()
    }
  }
  for (const side of ['away', 'home'] as const) {
    const roster = (side === 'away' ? away : home).filter(row => row.isPlayer)
    const team = session.liveData.boxscore.teams[side]
    for (const row of roster) {
      const id = allocatePlayer(session.meta.identities, row.userId)
      if (session.gameData.players[id] != null)
        throw new Error('Player appears more than once in the game roster')
      session.gameData.players[id] = {
        id,
        sourceUserId: row.userId,
        teamId: session.gameData.teams[side].id,
        fullName: row.shortName,
        jersey: row.jersey ?? '',
        bats: row.bats ?? 'right',
        throws: row.throws ?? null,
        positions: [...row.positions],
        local: false
      }
      team.players.push(id)
    }
    while (team.players.length < 9)
      addDevelopmentPlayer(
        session,
        side,
        `Player ${team.players.length + 1}`,
        String(team.players.length + 1)
      )
    team.battingOrder = [...team.players]
    const assigned = new Set<number>()
    for (const position of POSITIONS) {
      const id = team.players.find(
        id =>
          !assigned.has(id) &&
          session.gameData.players[id].positions.includes(position)
      )
      if (id != null) {
        team.defense[position] = id
        assigned.add(id)
      }
    }
    for (const position of POSITIONS)
      if (team.defense[position] == null) {
        const id = team.players.find(id => !assigned.has(id))
        if (id != null) {
          team.defense[position] = id
          assigned.add(id)
        }
      }
  }
  startAppearance(session)
  return session
}
export function addDevelopmentPlayer(
  session: ScoringSessionState,
  side: Side,
  name: string,
  jersey = ''
): number {
  const id = allocatePlayer(session.meta.identities, null)
  session.gameData.players[id] = {
    id,
    sourceUserId: null,
    teamId: session.gameData.teams[side].id,
    fullName: name.trim(),
    jersey,
    bats: 'right',
    throws: null,
    positions: [],
    local: true
  }
  session.liveData.boxscore.teams[side].players.push(id)
  return id
}
