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
}

export interface HeroReplay {
  kind: 'live' | 'replay'
  label: string
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
    | 'replayable'
    | 'nonMemberView'
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
 * The content pills across a game, left to right. Settings lives in the gear;
 * Live / Replay is the hero's own button (`heroReplay`), never a section.
 */
export function gameTabs(input: GameTabsInput): GameTabPill[] {
  const { game } = input
  const info: GameTabPill = { id: 'info', label: 'Info' }
  if (game.eventKind === 'event') return [info]
  return gameSectionOrder(game, input.now).map(id => ({
    id,
    label: sectionLabel[id]
  }))
}

/**
 * The hero's Live / Replay button: the same for members, non-members and the
 * signed out, once something TeamStation scored is stored. Followed live
 * while it is scored, replayed once it is over. Who may open it is the game
 * page's business (a non-member gets the membership sheet), and the replay
 * itself still refuses a non-member (`isReplayable`).
 */
export function heroReplay(
  game: Pick<GameDetail, 'status' | 'replayable'> &
    Pick<EventTabState, 'eventKind'>
): HeroReplay | null {
  if (game.eventKind === 'event' || !game.replayable) return null
  if (game.status === 'inProgress')
    return { kind: 'live', label: lstrings.game_live }
  if (game.status === 'final')
    return { kind: 'replay', label: lstrings.game_replay }
  return null
}

/**
 * Assigned coaching sides only, as a coach or an assistant; administrative
 * permission is not a UI role.
 */
export function heroCoachSides(
  game: GameTabsInput['game']
): Array<'away' | 'home'> {
  return game.coachSides.filter(
    side =>
      game.assignedRoles[side].includes('coach') ||
      game.assignedRoles[side].includes('assistant')
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
  if (scoringAvailable && game.canScore && assigned.includes('scorekeeper'))
    actions.push({ id: 'score', label: lstrings.game_hero_score })
  if (onRecordGame != null && assigned.includes('videographer'))
    actions.push({ id: 'record', label: lstrings.game_hero_record })
  if (scoringAvailable) {
    if (heroCoachSides(game).length > 0 && onCoachGame != null)
      actions.push({ id: 'coach', label: lstrings.game_hero_coach })
    if (game.canDj && assigned.includes('songkeeper') && onDjGame != null)
      actions.push({ id: 'dj', label: 'DJ' })
  }
  return actions
}
