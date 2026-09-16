import {
  type ColumnType,
  type Generated,
  Kysely,
  PostgresDialect
} from 'kysely'
import { Pool } from 'pg'

/** `timestamptz`: read as a Date, written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type Json = ColumnType<unknown, unknown, unknown>

export interface UsersTable {
  id: string
  display_name: string
  first_name: string | null
  last_name: string | null
  username: string | null
  password_hash: string | null
  login_enabled: Generated<boolean>
  is_admin: Generated<boolean>
  avatar_path: string | null
  /** Set when this account was absorbed by another; it is closed, not deleted. */
  merged_into: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * A person's addresses. The identity is `users.id`; an address is an attribute
 * of it, and unique across the table so a sign-in code reaches one account.
 */
export interface UserEmailsTable {
  id: string
  user_id: string
  email: string
  is_primary: Generated<boolean>
  verified_at: Timestamp | null
  source: Generated<'peertube' | 'import' | 'manual'>
  created_at: Timestamp
}

export interface UserLinksTable {
  id: string
  user_id: string
  related_user_id: string
  kind: 'guardian' | 'family' | 'other'
  can_manage: Generated<boolean>
  created_at: Timestamp
}

export interface LeaguesTable {
  id: string
  name: string
  short_name: string | null
  website: string | null
  logo_path: string | null
  notes: string | null
  spectator_access: Generated<'team' | 'league'>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SeasonsTable {
  id: string
  /** Null until somebody creates a league and moves this season into it. */
  league_id: string | null
  name: string
  age_group: string | null
  year: number
  term: string | null
  starts_on: string | null
  ends_on: string | null
  spectator_access: Generated<'team' | 'season'>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface TeamsTable {
  id: string
  name: string
  short_name: string | null
  /** `external` plays games in a season without being in it. */
  kind: Generated<'full' | 'external'>
  created_from: Generated<'import' | 'peertube' | 'manual' | 'videoTitle'>
  sport: Generated<string>
  is_managed: Generated<boolean>
  settings: Generated<Json>
  logo_path: string | null
  primary_color: string | null
  secondary_color: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * Belonging to a season without being on a team in it. A season member sees
 * every team in the season; being on a team is separate and stronger.
 */
export interface SeasonMembersTable {
  id: string
  user_id: string
  season_id: string
  role: Generated<'spectator' | 'member'>
  source: Generated<'peertube' | 'import' | 'manual'>
  joined_at: Timestamp
}

export interface SeasonTeamsTable {
  season_id: string
  team_id: string
  joined_at: Timestamp
}

export interface MembershipsTable {
  id: string
  user_id: string
  team_id: string
  role: Generated<'owner' | 'manager' | 'member'>
  is_player: Generated<boolean>
  is_spectator: Generated<boolean>
  jersey: string | null
  positions: Generated<string[]>
  joined_at: Timestamp
  granted_by_link_id: string | null
}

export interface AdminRolesTable {
  id: string
  user_id: string
  scope_type: 'league' | 'season' | 'team'
  scope_id: string
  role: Generated<'admin'>
  granted_by: string | null
  granted_at: Timestamp
}

export interface ExternalIdsTable {
  id: string
  entity_type: string
  entity_id: string
  system: string
  kind: string
  external_id: string
  created_at: Timestamp
}

export interface GamesTable {
  id: string
  home_team_id: string
  away_team_id: string
  season_id: string | null
  start_at: Timestamp
  venue: string | null
  status: Generated<'scheduled' | 'inProgress' | 'final' | 'cancelled'>
  home_score: number | null
  away_score: number | null
  gumbo_game_data: Json | null
  linescore: Json | null
  boxscore: Json | null
  ingest_status: Generated<'none' | 'ok' | 'scoreMismatch' | 'error'>
  ingest_message: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface VideosTable {
  id: string
  game_id: string | null
  kind: 'program' | 'combined'
  title: string
  storage: 'peertube' | 'local' | 'spaces'
  status: Generated<'live' | 'processing' | 'ready' | 'unavailable' | 'error'>
  status_message: string | null
  start_at: Timestamp | null
  start_at_source:
    | 'obsFilename'
    | 'liveSession'
    | 'originallyPublishedAt'
    | 'distributor'
    | 'manual'
    | null
  sync_offset_sec: Generated<number>
  duration_sec: number | null
  width: number | null
  height: number | null
  codecs: string | null
  probed_master_mtime: Timestamp | null
  size_bytes: string | null
  sha256: string | null
  spaces_verified_at: Timestamp | null
  local_delete_after: Timestamp | null
  legacy_description: string | null
  published_at: Timestamp | null
  hidden: Generated<boolean>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface EventsTable {
  id: string
  game_id: string
  at_bat_index: number
  start_time: Timestamp | null
  end_time: Timestamp | null
  inning: number | null
  half_inning: 'top' | 'bottom' | null
  batting_team_id: string | null
  event_type: string | null
  description: string | null
  is_scoring_play: Generated<boolean>
  rbi: Generated<number>
  away_score: number | null
  home_score: number | null
  gumbo: Json
  source: Generated<'external' | 'manual'>
  hidden: Generated<boolean>
  title_override: string | null
  time_nudge_sec: Generated<number>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface EventPlayersTable {
  id: string
  event_id: string
  user_id: string
  team_id: string | null
  role: 'batter' | 'pitcher' | 'runner' | 'scorer' | 'fielder' | 'catcher'
  position: string | null
}

export interface AuthSessionsTable {
  id: string
  user_id: string
  token_hash: string
  user_agent: string | null
  created_at: Timestamp
  last_used_at: Timestamp | null
  expires_at: Timestamp
  revoked_at: Timestamp | null
}

export interface ApiTokensTable {
  id: string
  user_id: string
  label: string
  token_hash: string
  scopes: Generated<string[]>
  created_at: Timestamp
  last_used_at: Timestamp | null
  expires_at: Timestamp | null
  revoked_at: Timestamp | null
}

export interface EmailCodesTable {
  id: string
  email: string
  code_hash: string
  purpose: 'login' | 'verify' | 'reset'
  attempts: Generated<number>
  created_at: Timestamp
  expires_at: Timestamp
  consumed_at: Timestamp | null
}

export interface AuditLogTable {
  id: string
  at: Timestamp
  actor_user_id: string | null
  api_token_id: string | null
  method: string
  path: string
  entity_type: string | null
  entity_id: string | null
  before: Json | null
  after: Json | null
}

export interface SystemSettingsTable {
  key: string
  value: Json
  updated_at: Timestamp
  updated_by: string | null
}

export interface PlayerSeasonStatsTable {
  id: string
  user_id: string
  season_id: string | null
  team_id: string
  g: Generated<number>
  pa: Generated<number>
  ab: Generated<number>
  h: Generated<number>
  singles: Generated<number>
  doubles: Generated<number>
  triples: Generated<number>
  hr: Generated<number>
  r: Generated<number>
  rbi: Generated<number>
  bb: Generated<number>
  k: Generated<number>
  sb: Generated<number>
  cs: Generated<number>
  pitch_appearances: Generated<number>
  pitch_outs_recorded: Generated<number>
  pitch_h: Generated<number>
  pitch_r: Generated<number>
  pitch_bb: Generated<number>
  pitch_k: Generated<number>
  field_po: Generated<number>
  field_a: Generated<number>
  field_e: Generated<number>
  computed_at: Timestamp
}

export interface TeamSeasonRecordsTable {
  id: string
  team_id: string
  season_id: string | null
  w: Generated<number>
  l: Generated<number>
  t: Generated<number>
  runs_for: Generated<number>
  runs_against: Generated<number>
  computed_at: Timestamp
}

export interface Database {
  admin_roles: AdminRolesTable
  api_tokens: ApiTokensTable
  audit_log: AuditLogTable
  auth_sessions: AuthSessionsTable
  email_codes: EmailCodesTable
  event_players: EventPlayersTable
  events: EventsTable
  external_ids: ExternalIdsTable
  games: GamesTable
  leagues: LeaguesTable
  memberships: MembershipsTable
  player_season_stats: PlayerSeasonStatsTable
  season_members: SeasonMembersTable
  season_teams: SeasonTeamsTable
  seasons: SeasonsTable
  system_settings: SystemSettingsTable
  team_season_records: TeamSeasonRecordsTable
  teams: TeamsTable
  user_links: UserLinksTable
  user_emails: UserEmailsTable
  users: UsersTable
  videos: VideosTable
}

export function makeDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 10 })
    })
  })
}
