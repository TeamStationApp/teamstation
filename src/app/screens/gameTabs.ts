import type { GameDetail } from '../../common/api'
import { isReplayable } from '../../common/replay/replayTimeline'
import { lstrings } from '../locales/strings'
import { scoringEntry } from '../scoring/isUnscoredGame'
import {
  type EventTabState,
  type GameSection,
  gameSectionOrder
} from './eventTabPolicy'

export type GameTab =
  'info' | 'boxScore' | 'watch' | 'plays' | 'replay' | 'score' | 'coach' | 'dj'

export interface GameTabPill {
  id: GameTab
  label: string
  role?: 'button'
  live?: boolean
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
  /** Present where the app can open the game's replay. */
  onReplay?: () => void
  now?: number
}

/** A game shows its Plays from the first recorded pitch. */
export function hasPlaysPill(
  game: Pick<GameTabsInput['game'], 'eventKind' | 'hasScoringEvents'>
): boolean {
  return game.eventKind !== 'event' && game.hasScoringEvents === true
}

const sectionLabel: Record<GameSection, string> = {
  info: 'Info',
  boxScore: lstrings.game_box_score,
  watch: lstrings.game_videos
}

/** The game's plays, after Videos; also the Tess sitemap's `?tab=plays`. */
const PLAYS_TAB: GameTabPill = { id: 'plays', label: lstrings.game_plays }

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
  // The game's plays, from its first recorded pitch (the at-bat in progress
  // included), right after Videos. Never a section a reader lands on.
  const videos = pills.findIndex(item => item.id === 'watch')
  const plays = hasPlaysPill(game)
  if (plays) pills.splice(videos < 0 ? pills.length : videos + 1, 0, PLAYS_TAB)
  // The game in 3D, for a member, once something TeamStation scored is
  // stored: replayed once it is over, followed live while it is scored.
  // It follows Videos and Plays, wherever the game's sections put Info.
  if (input.onReplay != null && isReplayable(game, game.replayable)) {
    const pill: GameTabPill =
      game.status === 'inProgress'
        ? {
            id: 'replay',
            label: lstrings.game_live,
            role: 'button',
            live: true
          }
        : { id: 'replay', label: lstrings.game_replay, role: 'button' }
    pills.splice(videos < 0 ? pills.length : videos + (plays ? 2 : 1), 0, pill)
  }
  return pills
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
