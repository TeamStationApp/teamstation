import type {
  UmpireLevel,
  UmpirePosition,
  UmpireSettings,
  UmpireType
} from './umpires'

export interface UmpireAssignment {
  userId: string
  name: string
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
  notes: string
  umpireNotes: Record<string, string>
  positions: UmpirePosition[]
  assignments: Record<string, UmpireAssignment>
  conflicts: UmpireConflict[]
  choices: Record<string, UmpireChoice[]>
}
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
export interface UmpireLeaderboard {
  completed: Array<{
    userId: string
    name: string
    count: number
    symbol: string
  }>
  scheduled: Array<{
    userId: string
    name: string
    count: number
    symbol: string
  }>
  teams: Array<{ id: string; name: string; count: number }> | null
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
