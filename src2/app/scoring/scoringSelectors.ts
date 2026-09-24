import type { ScoreboardState } from '../field/scoreboardModel'
import { asScoringPlay, type PlayerRef } from './scoringContract'
import {
  POSITIONS,
  type ScoringSessionState,
  type ScoringSnapshot,
  type Side
} from './scoringTypes'

export function battingSide(session: ScoringSessionState): Side {
  return session.liveData.linescore.isTopInning ? 'away' : 'home'
}
export function fieldingSide(session: ScoringSessionState): Side {
  return battingSide(session) === 'away' ? 'home' : 'away'
}
export function playerRef(
  session: ScoringSessionState,
  id: number | null
): PlayerRef | null {
  if (id == null) return null
  const player = session.gameData.players[id]
  if (player == null) throw new Error('Unknown player')
  return { id, fullName: player.fullName }
}
export function baseIds(session: ScoringSessionState): Array<number | null> {
  const offense = session.liveData.linescore.offense
  return [
    offense.first?.id ?? null,
    offense.second?.id ?? null,
    offense.third?.id ?? null
  ]
}
export function updateDefense(session: ScoringSessionState): void {
  const assignments =
    session.liveData.boxscore.teams[fieldingSide(session)].defense
  for (const position of POSITIONS)
    session.liveData.linescore.defense[position] = playerRef(
      session,
      assignments[position]
    )
}
/** Mutation is confined to a newly-owned reducer draft or bootstrap record. */
export function startAppearance(
  session: ScoringSessionState
): ScoringSnapshot['awaitingBatter'] {
  const side = battingSide(session)
  const lineup = session.liveData.boxscore.teams[side]
  const id = lineup.battingOrder[lineup.battingIndex]
  updateDefense(session)
  if (id == null) throw new Error('A lineup needs a batter')
  if (baseIds(session).includes(id)) {
    session.liveData.linescore.offense.batter = null
    session.liveData.plays.currentPlay = null
    return {
      teamId: session.gameData.teams[side].id,
      dueIndex: lineup.battingIndex,
      duePlayerId: id
    }
  }
  const batter = playerRef(session, id)
  const pitcher = session.liveData.linescore.defense.P
  if (batter == null || pitcher == null)
    throw new Error('A batter and pitcher are required')
  session.liveData.linescore.offense.batter = batter
  session.liveData.plays.currentPlay = asScoringPlay({
    about: {
      atBatIndex: session.liveData.plays.allPlays.length,
      inning: session.liveData.linescore.currentInning,
      halfInning: side === 'away' ? 'top' : 'bottom',
      isComplete: false
    },
    result: {
      event: '',
      eventType: '',
      description: '',
      awayScore: session.liveData.linescore.teams.away.runs,
      homeScore: session.liveData.linescore.teams.home.runs,
      rbi: 0
    },
    count: {
      balls: session.liveData.linescore.balls,
      strikes: session.liveData.linescore.strikes,
      outs: session.liveData.linescore.outs
    },
    matchup: {
      batter,
      pitcher,
      batSide: {
        code: session.gameData.players[id].bats === 'left' ? 'L' : 'R'
      }
    },
    runners: [],
    playEvents: [],
    source: {
      system: 'gamestation',
      gamestation: { version: 'estimated-v1', outcome: '' }
    }
  })
  return null
}
export function scoreboardFor(session: ScoringSessionState): ScoreboardState {
  const line = session.liveData.linescore
  // Field labels already carry short names; keep the entire supplied name.
  const person = (
    ref: PlayerRef | null
  ): { firstName: string; lastName: string } => ({
    firstName: ref?.fullName ?? '',
    lastName: ''
  })
  const pitcher = line.defense.P
  return {
    awayTeam: session.gameData.teams.away.name,
    homeTeam: session.gameData.teams.home.name,
    awayScore: line.teams.away.runs,
    homeScore: line.teams.home.runs,
    batter: person(line.offense.batter),
    pitcher: person(pitcher),
    pitchCount:
      pitcher == null
        ? 0
        : (session.liveData.boxscore.teams[fieldingSide(session)].pitchCounts[
            pitcher.id
          ] ?? 0),
    balls: line.balls,
    strikes: line.strikes,
    outs: line.outs
  }
}
export function canSwitchBatter(session: ScoringSessionState): boolean {
  const play = session.liveData.plays.currentPlay
  return play != null && !play.playEvents.some(event => event.isPitch)
}
