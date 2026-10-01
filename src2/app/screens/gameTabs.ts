import type { GameDetail } from '../../common/api'
import { lstrings } from '../locales/strings'
import { scoringEntry } from '../scoring/isUnscoredGame'

export type GameTab = 'boxScore' | 'watch' | 'score' | 'dj'

export interface GameTabPill {
  id: GameTab
  label: string
  role?: 'button'
}

export interface GameTabsInput {
  game: Pick<
    GameDetail,
    | 'canScore'
    | 'canDj'
    | 'scoreboard'
    | 'linescore'
    | 'homeScore'
    | 'awayScore'
    | 'status'
    | 'scoringOwner'
  >
  /** Songs need something to play them with: never on the web. */
  music?: { available: boolean }
  /** Present where the app can open DJ Game. */
  onDjGame?: () => void
}

/**
 * The pills across a game, left to right.
 *
 * The same on every platform: Score Game belongs to whoever may score, on a
 * phone as much as in a browser, and sits immediately before DJ Game where a
 * songkeeper has that too.
 */
export function gameTabs(input: GameTabsInput): GameTabPill[] {
  const { game, music, onDjGame } = input
  const pills: GameTabPill[] = [
    { id: 'boxScore', label: lstrings.game_box_score },
    { id: 'watch', label: lstrings.game_videos }
  ]
  // The one scoring pill, for the people whose plays the server would take,
  // and only while there is something behind it to use. It is a tab, like the
  // other two: the hero stays and the choices appear under the pills.
  if (
    game.canScore &&
    (scoringEntry(game) != null || game.scoreboard?.open === true)
  ) {
    pills.push({ id: 'score', label: lstrings.game_score_game })
  }
  // For a songkeeper of either team, on a phone, whatever the game's status:
  // songs are set and played before, during and after.
  if (game.canDj && music?.available === true && onDjGame != null) {
    pills.push({ id: 'dj', label: lstrings.dj_game, role: 'button' })
  }
  return pills
}
