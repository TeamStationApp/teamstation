import { arrivalMinutesInput } from '../../common/eventInfo'
import {
  type EventScheduleDraft,
  eventScheduleValue,
  newEventSchedule
} from '../../common/eventSchedule'
import type {
  GameFieldSummary,
  GameIntent,
  GameProposal
} from '../../common/gameApprovals'
import { OPEN_SIDE_NAME } from '../../common/openSides'
import type { PublicGroup } from '../../common/publicGroups'
import type { SwapEffect } from '../../common/scoring/playsLost'
import type { TeamChoice } from './PlaceholderTeamForm'
import type { TeamSelectorAnchor } from './TeamSelectorScene'

/** Creating a game from a team or season page, or changing one. */
export type GameFormMode =
  | { kind: 'create'; source: { kind: 'team' | 'season'; id: string } }
  | { kind: 'edit'; gameId: string }

export type Side = 'home' | 'away'

/** A side left open: its team is chosen later, in Game Settings. */
export const TBD = { tbd: true } as const

/** What a side holds once chosen: a team, or TBD. */
export type SideChoice = TeamChoice | typeof TBD

/** Whether a side was left TBD. */
export const isTbd = (choice: SideChoice | undefined): choice is typeof TBD =>
  choice != null && 'tbd' in choice

/** The team a side holds: undefined for TBD and for a side not yet chosen. */
export function sideTeamId(choice: SideChoice | undefined): string | undefined {
  return choice == null || isTbd(choice) ? undefined : choice.group.id
}

/** What a chosen side is called: its team's name, or TBD. */
export function sideName(choice: SideChoice): string {
  return isTbd(choice) ? OPEN_SIDE_NAME : choice.group.name
}

/** The team a side holds, or undefined for TBD and an unchosen side. */
export function sideTeam(
  choice: SideChoice | undefined
): TeamChoice | undefined {
  return choice == null || isTbd(choice) ? undefined : choice
}

/**
 * Everything the scene holds before Save, placeholders included. A side is
 * `undefined` until it is chosen.
 */
export interface GameDraft {
  home?: SideChoice
  away?: SideChoice
  schedule: EventScheduleDraft
  venue: string
  address: string
  notes: string
  arrival: string
  exhibition: boolean
  /** The season a season page's game is in; a team page's game has none. */
  season?: PublicGroup
  outsideTournament: string
  /**
   * The registry field the game is on. While one is chosen, the venue and
   * address come from it.
   */
  field?: GameFieldSummary | null
}

/** A game being changed, as the scheduling route answered it. */
export interface LoadedGame {
  game: GameIntent
  version: string
  withdrawTeamIds: string[]
  canPropose: boolean
  /** A scorekeeper may swap home and away at once. */
  canSwap?: boolean
  /** What a swap's reset would delete, and the plays it confirms. */
  plays?: {
    atBats: number
    innings: number
    playsDigest: string
    generation: number
    resets?: boolean
    swap?: SwapEffect
  }
  field?: GameFieldSummary | null
}

export const otherSide = (side: Side): Side =>
  side === 'home' ? 'away' : 'home'

/** The team a game is created from, which must stay in it. */
export function sourceTeamId(mode: GameFormMode): string | undefined {
  return mode.kind === 'create' && mode.source.kind === 'team'
    ? mode.source.id
    : undefined
}

/** What a team page says in place of the Exhibition switch. */
export const TEAM_GAME_NOTE =
  'Creating a game from within the team interface always creates a scrimmage/exhibition game. To create a game that counts for season standings within a season, create the game from the season interface.'

/**
 * From a team, that team is home and the game is a scrimmage or exhibition
 * in no season; from a season, the game is in that season.
 */
export function newGameDraft(
  mode: Extract<GameFormMode, { kind: 'create' }>,
  source: TeamChoice
): GameDraft {
  return {
    ...(mode.source.kind === 'team'
      ? { home: source }
      : { season: source.group }),
    schedule: newEventSchedule(),
    venue: '',
    address: '',
    notes: '',
    arrival: '45',
    exhibition: mode.source.kind === 'team',
    outsideTournament: ''
  }
}

/**
 * Whether the game can be marked exhibition: a season's game counts for its
 * standings or not; a game in no season is always a scrimmage or exhibition.
 */
export function choosesExhibition(
  mode: GameFormMode,
  loaded?: LoadedGame
): boolean {
  return mode.kind === 'create'
    ? mode.source.kind === 'season'
    : loaded?.game.seasonId != null
}

/**
 * The sides that may be TBD: from a team page, the side not holding the
 * team; from a season page, both; when changing a game, only a side that is
 * open now, which the change keeps open or assigns. A change that swaps the
 * sides of a game with one open side moves its TBD with its named team: the
 * side that team left may be TBD.
 */
export function tbdSides(
  draft: GameDraft,
  mode: GameFormMode,
  loaded?: LoadedGame
): Side[] {
  if (mode.kind === 'edit') {
    if (loaded == null) return []
    const { homeTeamId, awayTeamId } = loaded.game
    if (homeTeamId == null && awayTeamId == null) return ['home', 'away']
    if (homeTeamId != null && awayTeamId != null) return []
    const open: Side = homeTeamId == null ? 'home' : 'away'
    const named = homeTeamId ?? awayTeamId
    return [sideTeamId(draft[open]) === named ? otherSide(open) : open]
  }
  const source = sourceTeamId(mode)
  if (source == null) return ['home', 'away']
  return (['home', 'away'] as const).filter(
    side => sideTeamId(draft[otherSide(side)]) === source
  )
}

/** A saved game, ready to change: an open side loads as TBD. */
export function loadedGameDraft(
  loaded: LoadedGame,
  home: SideChoice,
  away: SideChoice
): GameDraft {
  const { game } = loaded
  return {
    home,
    away,
    schedule: newEventSchedule(
      game.startAt,
      game.endAt,
      undefined,
      game.timezone
    ),
    venue: game.venue ?? '',
    address: game.address ?? '',
    notes: game.notes ?? '',
    arrival: game.arrivalTimeDelta == null ? '' : String(game.arrivalTimeDelta),
    exhibition: game.exhibition ?? false,
    outsideTournament: game.outsideTournament ?? '',
    field: loaded.field ?? null
  }
}

/**
 * The sides whose team may be replaced: from a team, every side but the one
 * holding it; from a season, both; a change, both while it may be proposed.
 */
export function replaceableSides(
  draft: GameDraft,
  mode: GameFormMode,
  loaded?: LoadedGame
): Side[] {
  if (mode.kind === 'edit')
    return loaded?.canPropose === true ? ['home', 'away'] : []
  const source = sourceTeamId(mode)
  return (['home', 'away'] as const).filter(
    side => source == null || sideTeamId(draft[side]) !== source
  )
}

export function swapSides(draft: GameDraft): GameDraft {
  return { ...draft, home: draft.away, away: draft.home }
}

/**
 * Puts a team, or TBD, on one side; never the other side's team, never over
 * the source. TBD is never the other side's team.
 */
export function chooseTeam(
  draft: GameDraft,
  side: Side,
  choice: SideChoice,
  mode: GameFormMode
): GameDraft {
  const chosen = sideTeamId(choice)
  if (chosen != null && sideTeamId(draft[otherSide(side)]) === chosen)
    throw new Error('Choose two different teams.')
  const source = sourceTeamId(mode)
  const held = draft[side]
  if (source != null && held != null && sideTeamId(held) === source)
    throw new Error(`${sideName(held)} must play in this game.`)
  return { ...draft, [side]: choice }
}

/** The first thing stopping Save, or nothing. */
export function draftProblem(
  draft: GameDraft,
  mode: GameFormMode,
  sourceName?: string,
  loaded?: LoadedGame
): string | undefined {
  const allowed = tbdSides(draft, mode, loaded)
  for (const side of ['home', 'away'] as const) {
    const choice = draft[side]
    if (choice == null)
      return allowed.includes(side)
        ? `Choose the ${side} team or TBD`
        : `Choose the ${side} team`
    if (isTbd(choice) && !allowed.includes(side))
      return `Choose the ${side} team`
  }
  const home = sideTeamId(draft.home)
  const away = sideTeamId(draft.away)
  if (home != null && home === away) return 'Choose two different teams'
  const source = sourceTeamId(mode)
  if (source != null && home !== source && away !== source)
    return `${sourceName ?? 'The team this game was created from'} must play in this game`
  return undefined
}

/**
 * A team that exists on the server, rather than a placeholder still to be
 * made or TBD.
 */
const savedTeam = (choice: SideChoice | undefined): string | undefined => {
  const team = sideTeam(choice)
  return team == null || team.placeholder != null ? undefined : team.group.id
}

/**
 * What the selector for one side suggests around: the other side's team and
 * the season. A placeholder not yet made, or TBD, is never named; the side's
 * own team stands in for it when changing a game, else the source team, then
 * the season, then nothing.
 */
export function selectorAnchor(
  draft: GameDraft,
  side: Side,
  mode: GameFormMode,
  seasonId: string | null | undefined
): TeamSelectorAnchor {
  const teamId =
    savedTeam(draft[otherSide(side)]) ??
    (mode.kind === 'edit' ? savedTeam(draft[side]) : sourceTeamId(mode))
  return {
    ...(teamId == null ? {} : { teamId }),
    ...(seasonId == null ? {} : { seasonId })
  }
}

/** A loaded game as the draft edits it, whoever may send the change. */
export function editedGame(
  draft: GameDraft,
  home: SideChoice,
  away: SideChoice,
  loaded: LoadedGame
): GameIntent {
  const { startAt, endAt, timezone } = eventScheduleValue(draft.schedule)
  const address = draft.address.trim() === '' ? null : draft.address.trim()
  return {
    ...loaded.game,
    homeTeamId: sideTeamId(home) ?? null,
    awayTeamId: sideTeamId(away) ?? null,
    startAt,
    endAt,
    address,
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
    arrivalTimeDelta: arrivalMinutesInput(draft.arrival),
    ...(address !== (loaded.game.address ?? null)
      ? { latitude: null, longitude: null }
      : {}),
    timezone,
    exhibition: draft.exhibition,
    venue: draft.venue.trim() === '' ? null : draft.venue.trim(),
    ...fieldOf(draft, loaded.game.fieldId ?? null)
  }
}

/**
 * The proposal Save sends, exactly as each mode always has: a team page
 * proposes as its team, a season page as its season, a change as the first
 * team the person may withdraw, or, when they may withdraw none, as the
 * game's season. A TBD side is sent as `null`.
 */
export function gameProposalFields(
  draft: GameDraft,
  mode: GameFormMode,
  home: SideChoice,
  away: SideChoice,
  loaded?: LoadedGame
): Omit<GameProposal, 'idempotencyKey'> {
  const { startAt, endAt, timezone } = eventScheduleValue(draft.schedule)
  const address = draft.address.trim() === '' ? null : draft.address.trim()
  const notes = draft.notes.trim() === '' ? null : draft.notes.trim()
  const venue = draft.venue.trim() === '' ? null : draft.venue.trim()
  const arrivalTimeDelta = arrivalMinutesInput(draft.arrival)
  if (mode.kind === 'edit') {
    if (loaded == null) throw new Error('Game settings could not load.')
    const senderId = loaded.withdrawTeamIds[0]
    const seasonId = loaded.game.seasonId ?? null
    if (senderId == null && seasonId == null)
      throw new Error('You need administrator access to a participating team.')
    return {
      ...(senderId == null
        ? { sender: { kind: 'season' as const, id: seasonId! } }
        : {
            sender: { kind: 'team' as const, id: senderId },
            initiatingTeamId: senderId
          }),
      gameId: mode.gameId,
      expected: loaded.version,
      game: editedGame(draft, home, away, loaded)
    }
  }
  const { source } = mode
  // A team page's game is a scrimmage or exhibition in no season; a season
  // page's game is in that season, counting for its standings or not.
  const season = source.kind === 'season' ? draft.season : undefined
  return {
    sender:
      source.kind === 'team'
        ? { kind: 'team', id: source.id }
        : { kind: 'season', id: source.id },
    ...(source.kind === 'team' &&
    [sideTeamId(home), sideTeamId(away)].includes(source.id)
      ? { initiatingTeamId: source.id }
      : {}),
    game: {
      notes,
      arrivalTimeDelta,
      ...(address == null ? {} : { address }),
      endAt,
      homeTeamId: sideTeamId(home) ?? null,
      awayTeamId: sideTeamId(away) ?? null,
      seasonId: season?.id ?? null,
      startAt,
      timezone,
      exhibition: source.kind === 'team' ? true : draft.exhibition,
      venue,
      ...fieldOf(draft, null),
      outsideTournament:
        source.kind === 'season' || draft.outsideTournament.trim() === ''
          ? null
          : draft.outsideTournament.trim(),
      status: 'scheduled'
    }
  }
}

/**
 * The field keys a proposal carries: the chosen field, `null` to clear the
 * one the game had, or nothing when the field is unchanged.
 */
function fieldOf(
  draft: GameDraft,
  had: string | null
): { fieldId?: string | null; fieldSize?: string | null } {
  const field = draft.field ?? null
  if (field == null)
    return had == null ? {} : { fieldId: null, fieldSize: null }
  return { fieldId: field.fieldId, fieldSize: field.size }
}
