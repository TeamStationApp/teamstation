import type { GameDetail } from '../../common/api'
import { lstrings } from '../locales/strings'
import { scoringEntry } from '../scoring/isUnscoredGame'
import {
  type EventTabState,
  type GameSection,
  gameSectionOrder
} from './eventTabPolicy'

export type GameTab = 'info' | 'boxScore' | 'watch' | 'score' | 'coach' | 'dj'

export interface GameTabPill {
  id: GameTab
  label: string
  role?: 'button'
}

export interface GameAction {
  id: 'score' | 'record' | 'coach'
  label: string
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
    | 'videos'
  > &
    EventTabState
  /** DJ Game is an iPhone's: never the web, and never Android. */
  music?: { djSupported: boolean }
  /** Present where the app can open DJ Game. */
  onDjGame?: () => void
  /** Present where the app can open Coach Game. */
  onCoachGame?: () => void
  now?: number
}

const sectionLabel: Record<GameSection, string> = {
  info: 'Info',
  boxScore: lstrings.game_box_score,
  watch: lstrings.game_videos
}

/**
 * The content pills across a game, left to right. Settings lives in the gear.
 */
export function gameTabs(input: GameTabsInput): GameTabPill[] {
  const { game } = input
  const info: GameTabPill = { id: 'info', label: 'Info' }
  if (game.eventKind === 'event') return [info]
  const pills: GameTabPill[] = gameSectionOrder(game, input.now).map(id => ({
    id,
    label: sectionLabel[id]
  }))
  return pills
}

/**
 * Score, Record and Coach, on the hero. Each is offered to the same people,
 * on the same devices, as before they left the pills.
 */
export function gameActions(input: GameTabsInput): GameAction[] {
  const { game, music, onDjGame } = input
  if (game.eventKind === 'event') return []
  const actions: GameAction[] = []
  if (
    game.canScore &&
    (scoringEntry(game) != null || game.scoreboard?.open === true)
  ) {
    actions.push({ id: 'score', label: lstrings.game_hero_score })
  }
  if (game.canDj && music?.djSupported === true && onDjGame != null) {
    actions.push({ id: 'record', label: lstrings.game_hero_record })
  }
  if (
    game.coachSides.length > 0 &&
    game.status !== 'cancelled' &&
    input.onCoachGame != null
  ) {
    actions.push({ id: 'coach', label: lstrings.game_hero_coach })
  }
  return actions
}
