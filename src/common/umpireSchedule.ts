import type {
  UmpireLevel,
  UmpirePosition,
  UmpireSettings,
  UmpireType
} from './umpires'

export interface UmpireAssignment {
  userId: string
  name: string
  /** The account's display name, shown when the assignment is opened. */
  displayName: string
  assignedBy: string
  canRemove: boolean
  teams?: Array<{ id: string; name: string }>
}
export interface UmpireConflict {
  userId: string
  name: string
  activity: 'playing' | 'already umpiring'
  gameId: string
  time: string
  closeness: string
}
export interface UmpireChoice {
  userId: string
  name: string
  reason: string | null
}
export interface UmpireGameRow {
  id: string
  seasonId: string
  seasonName: string
  levelId: string
  levelName: string
  startAt: string
  endAt: string | null
  timezone: string
  date: string
  status: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
  home: string
  away: string
  homeTeamId?: string
  awayTeamId?: string
  location?: string
  venue: string
  /** The registry field the game is on. Blank when the game has none. */
  field: string
  notes: string
  umpireNotes: Record<string, string>
  positions: UmpirePosition[]
  assignments: Record<string, UmpireAssignment>
  conflicts: UmpireConflict[]
  choices: Record<string, UmpireChoice[]>
}
/**
 * The most rows a page of the umpire schedule holds. Each page computes the
 * whole schedule, so the table reads the rows it holds again in one read
 * after a sign-up, not a page at a time.
 */
export const UMPIRE_PAGE_MOST = 500
export interface UmpireSchedule {
  settings: UmpireSettings
  levels: UmpireLevel[]
  types: UmpireType[]
  noteTypes: UmpireLevel[]
  games: UmpireGameRow[]
  creditTeams: Array<{ id: string; name: string }>
  viewerId: string
  isAdmin: boolean
  view: 'umpire' | 'league' | 'schedule'
}
/** A column of the table, and the note under its heading. */
export interface UmpireColumn extends UmpirePosition {
  optionalHeader: string | null
}

/** What a column's heading says of the games that offer it. */
export function optionalPositionHeader(
  games: ReadonlyArray<Pick<UmpireGameRow, 'positions'>>,
  slot: string
): string | undefined {
  const offering = games.filter(g => g.positions.some(p => p.slot === slot))
  const optional = offering.filter(
    g => !g.positions.find(p => p.slot === slot)!.required
  ).length
  return optional === 0
    ? undefined
    : optional === offering.length
      ? 'Optional'
      : 'Optional in some games'
}

/** The columns `games` fill, by type in the league's order, then ordinal. */
export function umpireColumns(
  types: ReadonlyArray<Pick<UmpireType, 'id'>>,
  games: ReadonlyArray<Pick<UmpireGameRow, 'positions'>>
): UmpireColumn[] {
  return types.flatMap(type => {
    const held = games
      .flatMap(game => game.positions)
      .filter(position => position.typeId === type.id)
    return [...new Map(held.map(p => [p.slot, p])).values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(position => ({
        ...position,
        optionalHeader: optionalPositionHeader(games, position.slot) ?? null
      }))
  })
}
export interface UmpireLeague {
  id: string
  name: string
  logoUrl: string | null
}
export interface UmpireGameBlock {
  positions: Array<
    UmpirePosition & {
      person: { userId: string; name: string; avatarUrl?: string | null } | null
    }
  >
}
export interface UmpireRank {
  userId: string
  name: string
  count: number
  symbol: string
}
export interface UmpireLeaderboard {
  completed: UmpireRank[]
  scheduled: UmpireRank[]
  teams: Array<{ id: string; name: string; count: number }> | null
  page?: {
    order: 'asc' | 'desc'
    limit: number
    offset: number
    total: number
  }
}
/** The most people one read of the leaderboard's pages returns. */
export const UMPIRE_LEADERBOARD_MAX_PAGE = 50
export interface UmpireLeaderboardQuery {
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}
export const UMPIRE_RANK_SYMBOLS = [
  '🏆',
  '🥈',
  '🥉',
  '⭐⭐⭐⭐⭐',
  '⭐⭐⭐⭐',
  '⭐⭐⭐',
  '⭐⭐',
  '⭐',
  '👍',
  '👌'
]
