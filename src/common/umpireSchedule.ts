import type { UmpireLevel, UmpireSettings } from './umpires'

export interface UmpireAssignment {
  userId: string
  name: string
  assignedBy: string
  canRemove: boolean
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
  venue: string
  notes: string
  plate: boolean
  fieldCount: number
  assignments: Record<string, UmpireAssignment>
  conflicts: UmpireConflict[]
  choices: Record<string, UmpireChoice[]>
}
export interface UmpireSchedule {
  settings: UmpireSettings
  levels: UmpireLevel[]
  games: UmpireGameRow[]
  creditTeams: Array<{ id: string; name: string }>
  viewerId: string
  isAdmin: boolean
  view: 'umpire' | 'league'
}
export interface UmpireLeague {
  id: string
  name: string
  logoUrl: string | null
}
export interface UmpireGameBlock {
  plateNeeded: boolean
  plate: { userId: string; name: string } | null
  fieldCount: number
  field: Array<{ userId: string; name: string } | null>
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
