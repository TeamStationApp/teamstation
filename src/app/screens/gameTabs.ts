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
  id: 'score' | 'record' | 'coach' | 'dj'
  label: string
}

export interface GameTabsInput {
  game: Pick<
    GameDetail,
    | 'canScore'
    | 'canDj'
    | 'assignedRoles'
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
  /** Present when this device can record and the viewer may film the game. */
  onRecordGame?: () => void
  /** Present where the app can open Coach Game. */
  onCoachGame?: () => void
  /** Present when this platform supports the DJ screen. */
  onDjGame?: () => void
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

/** Assigned coaching sides only; administrative permission is not a UI role. */
export function heroCoachSides(
  game: GameTabsInput['game']
): Array<'away' | 'home'> {
  return game.coachSides.filter(side =>
    game.assignedRoles[side].includes('coach')
  )
}

/** Hero actions require an assigned role as well as the existing capability. */
export function gameActions(input: GameTabsInput): GameAction[] {
  const { game, onRecordGame, onCoachGame, onDjGame } = input
  if (game.eventKind === 'event') return []
  const actions: GameAction[] = []
  const assigned = [...game.assignedRoles.away, ...game.assignedRoles.home]
  // Preserve Score's existing availability, including reopening our own games.
  const scoringAvailable =
    scoringEntry(game) != null || game.scoreboard?.open === true
  if (scoringAvailable) {
    if (game.canScore && assigned.includes('scorekeeper'))
      actions.push({ id: 'score', label: lstrings.game_hero_score })
    if (heroCoachSides(game).length > 0 && onCoachGame != null)
      actions.push({ id: 'coach', label: lstrings.game_hero_coach })
    if (game.canDj && assigned.includes('songkeeper') && onDjGame != null)
      actions.push({ id: 'dj', label: 'DJ' })
  }
  if (onRecordGame != null && assigned.includes('videographer'))
    actions.push({ id: 'record', label: lstrings.game_hero_record })
  return actions
}
