import type { GameDetail } from '../../common/api'
import { lstrings } from '../locales/strings'
import { scoringEntry } from '../scoring/isUnscoredGame'
import { eventEnded, type EventTabState } from './eventTabPolicy'

export type GameTab =
  'info' | 'boxScore' | 'watch' | 'score' | 'coach' | 'dj' | 'settings'

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
    | 'coachSides'
    | 'scoreboard'
    | 'linescore'
    | 'homeScore'
    | 'awayScore'
    | 'status'
    | 'scoringOwner'
  > &
    EventTabState
  /** DJ Game is an iPhone's: never the web, and never Android. */
  music?: { djSupported: boolean }
  /** Present where the app can open DJ Game. */
  onDjGame?: () => void
  /** Present where the app can open Coach Game. */
  onCoachGame?: () => void
  onSettings?: () => void
  canManage?: boolean
  now?: number
}

/**
 * The pills across a game, left to right.
 *
 * The same on every platform: Score Game belongs to whoever may score, on a
 * phone as much as in a browser, and Coach Game to a team's head coach, right
 * after it; both sit before DJ Game where a songkeeper has that too.
 */
export function gameTabs(input: GameTabsInput): GameTabPill[] {
  const { game, music, onDjGame } = input
  const info: GameTabPill = { id: 'info', label: 'Info' }
  if (game.eventKind === 'event')
    return input.canManage === true && input.onSettings != null
      ? [info, { id: 'settings', label: 'Settings', role: 'button' }]
      : [info]
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
  // For a head coach (not an assistant) of either team, for his own team's
  // box score, roster, lineup and defence, until the game is called off.
  if (
    game.coachSides.length > 0 &&
    game.status !== 'cancelled' &&
    input.onCoachGame != null
  ) {
    pills.push({ id: 'coach', label: lstrings.game_coach_game, role: 'button' })
  }
  // For a songkeeper of either team, on an iPhone, whatever the game's
  // status: songs are set and played before, during and after.
  if (game.canDj && music?.djSupported === true && onDjGame != null) {
    pills.push({ id: 'dj', label: lstrings.dj_game, role: 'button' })
  }
  if (input.canManage === true && input.onSettings != null) {
    pills.push({ id: 'settings', label: 'Settings', role: 'button' })
  }
  if (eventEnded(game, input.now)) pills.push(info)
  else pills.unshift(info)
  return pills
}
