import type { GameScoreboard } from '../scoreboard'
import { statLines } from './credits'
import { fieldingSide } from './rules'
import type { GameState } from './state'

/**
 * What a scored game puts on its scoreboard: the count, the outs, the
 * runners, the inning, who bats and who pitches, the pitcher's count, the
 * runs, and the batter's hits and at-bats in this game.
 *
 * The batter's line is the completed plate appearances so far, the same
 * count the box score uses. The at-bat now in progress counts once it
 * closes. The scorer's own field scoreboard and a game's public scoreboard
 * both read a game through this, so the two cannot disagree. It reads a
 * game and never changes or stores one.
 */
export function scoreboardOfGame(state: GameState): GameScoreboard {
  const line = state.liveData.linescore
  const pitcher = line.defense.P
  const batterId = line.offense.batter?.id
  const batting =
    batterId == null
      ? undefined
      : statLines(state.liveData.plays.allPlays).batting[batterId]
  return {
    inGame: true,
    balls: line.balls,
    strikes: line.strikes,
    outs: line.outs,
    base1: line.offense.first != null,
    base2: line.offense.second != null,
    base3: line.offense.third != null,
    inning: line.currentInning,
    half: line.inningState === 'Bottom' ? 'bottom' : 'top',
    batterName: line.offense.batter?.fullName ?? '',
    pitcherName: pitcher?.fullName ?? '',
    batterNumHits: batting?.h ?? 0,
    batterAtBats: batting?.ab ?? 0,
    numPitches:
      pitcher == null
        ? 0
        : (state.liveData.boxscore.teams[fieldingSide(state)].pitchCounts[
            pitcher.id
          ] ?? 0),
    awayScore: line.teams.away.runs,
    homeScore: line.teams.home.runs
  }
}
