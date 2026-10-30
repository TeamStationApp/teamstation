import {
  type ColumnType,
  type Generated,
  Kysely,
  PostgresDialect
} from 'kysely'
import { Pool } from 'pg'

import type { Role } from '../../common/roles'
import { attachInt8Parser } from './int8'

/** `timestamptz`: read as a Date, written as a Date or an ISO string. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type Json = ColumnType<unknown, unknown, unknown>
/** `bytea`: read as a Buffer, written as any byte array. */
type Bytes = ColumnType<Buffer, Uint8Array, Uint8Array>

/** A fan following a group: a line on their Home and no access. */
export interface FollowsTable {
  user_id: string
  group_type: 'league' | 'season' | 'team'
  group_id: string
  created_at: Generated<Date>
}

export interface UsersTable {
  id: string
  /** Original historical identifier, retained for migrated accounts only. */
  legacyId: Generated<string | null>
  display_name: string
  first_name: string | null
  last_name: string | null
  username: string | null
  password_hash: string | null
  login_enabled: Generated<boolean>
  is_admin: Generated<boolean>
  onboarding_step: Generated<'name' | 'photo' | 'complete'>
  onboarding_completed_at: Timestamp | null
  disabled_at: Timestamp | null
  /** Set when the person deleted their account; it stays disabled for good. */
  deleted_at: Timestamp | null
  picture_catalog_id: Generated<string | null>
  avatar_path: string | null
  avatar_sha256: string | null
  avatar_source: string | null
  avatar_updated_at: Timestamp | null
  /** Which side they bat from, as a scorecard writes it. Null when nobody said. */
  bats: 'left' | 'right' | 'switch' | null
  throws: 'left' | 'right' | null
  /** Where the two above came from, so an import never overwrites a person. */
  bats_source: 'import' | 'manual' | null
  /** Set when this account was absorbed by another; it is closed, not deleted. */
  merged_into: string | null
  /**
   * The year and month of birth, both or neither (051guardiansAndAccounts).
   * Never a day: `ageOn` in `common/age.ts` reads an age from these two.
   */
  birth_year: number | null
  birth_month: number | null
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
  player_name_privacy: Generated<string | null>
  umpire_management: Generated<boolean>
  umpire_credits: Generated<boolean>
  id: string
  locality: Json | null
  picture_catalog_id: Generated<string | null>
  name: string
  short_name: string | null
  website: string | null
  logo_path: string | null
  logo_sha256: string | null
  logo_source: string | null
  logo_updated_at: Timestamp | null
  notes: string | null
  /**
   * The innings an ERA divides by, for seasons that do not set their own. Set
   * by hand in the database; nothing writes it.
   */
  era_innings: number | null
  /** Feet from home plate to the fence, for seasons that do not set their own. */
  fence_distance_ft: number | null
  spectator_access: Generated<'team' | 'league'>
  /**
   * A SafeSport Local Affiliated Organization, bound by the MAAPP. Set by the
   * league's own administrators (051guardiansAndAccounts).
   */
  safesport_lao: Generated<boolean>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SeasonsTable {
  player_name_privacy: Generated<string | null>
  id: string
  timezone: Generated<string>
  picture_catalog_id: Generated<string | null>
  /** Null until somebody creates a league and moves this season into it. */
  league_id: string | null
  name: string
  age_group: string | null
  logo_path: string | null
  logo_sha256: string | null
  logo_source: string | null
  logo_updated_at: Timestamp | null
  year: number
  term: string | null
  starts_on: string
  ends_on: string
  /**
   * The innings a game here runs, which is what an ERA divides by. Set by hand
   * in the database; nothing writes it. Null takes the league's, and six where
   * that is unset too.
   */
  era_innings: number | null
  /** Feet from home plate to the fence. Null takes the league's. */
  fence_distance_ft: number | null
  spectator_access: Generated<'team' | 'season'>
  created_at: Timestamp
  updated_at: Timestamp
}

/** Where a team row came from. */
export type TeamCreatedFrom =
  'import' | 'peertube' | 'manual' | 'videoTitle' | 'api'

export interface TeamsTable {
  player_name_privacy: Generated<string | null>
  id: string
  league_id: Generated<string | null>
  locality: Json | null
  picture_catalog_id: Generated<string | null>
  custodian_type: Generated<'league' | 'season' | 'team' | null>
  custodian_id: Generated<string | null>
  name: string
  short_name: string | null
  /** `external` plays games in a season without being in it. */
  kind: Generated<'full' | 'external'>
  created_from: Generated<TeamCreatedFrom>
  sport: Generated<string>
  is_managed: Generated<boolean>
  settings: Generated<Json>
  /** The team this turned out to be, when two rows were one real team. */
  merged_into: string | null
  logo_path: string | null
  logo_sha256: string | null
  logo_source: string | null
  logo_updated_at: Timestamp | null
  primary_color: string | null
  secondary_color: string | null
  /**
   * `{ lineup, fromGameId, setAt }`: the starting lineup of the last game
   * that began with a different one, or null (044teamDefaultLineup).
   */
  default_lineup: Json | null
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * The announcer's spoken sentences, each kept once by the digest of the
 * voice and the words (072narrationAudio).
 */
export interface NarrationAudioTable {
  digest: string
  text: string
  voice: string
  audio: Buffer
  created_at: Generated<Date>
}

/**
 * Belonging to a season without being on a team in it: the same member a
 * team has, of every team in the season (056oneMemberKind).
 */
export interface SeasonMembersTable {
  id: string
  user_id: string
  season_id: string
  role: Generated<'member'>
  source: Generated<'peertube' | 'import' | 'manual'>
  joined_at: Timestamp
}

/**
 * Belonging to a **league**, which is how a league-scoped invite means
 * anything: the same member a team has, of every team in the league and in
 * its seasons, including the ones it does not have yet.
 */
export interface LeagueMembersTable {
  id: string
  user_id: string
  league_id: string
  role: Generated<'member'>
  source: Generated<'peertube' | 'import' | 'manual'>
  joined_at: Timestamp
}

export interface SeasonTeamsTable {
  active: Generated<boolean>
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
  jersey: string | null
  positions: Generated<string[]>
  joined_at: Timestamp
  granted_by_link_id: string | null
}

/** A person following a team, which shows them its listing (050teamFollows). */
export interface TeamFollowsTable {
  user_id: string
  team_id: string
  created_at: Generated<Date>
}

/** One role for one person on one league, season or team (043roleFlags). */
export interface ScopeRolesTable {
  id: string
  user_id: string
  scope_type: 'league' | 'season' | 'team'
  scope_id: string
  role: Generated<Role>
  granted_by: string | null
  granted_at: Timestamp
}

/** One player's walk-up song on one team (045walkUpSongs). */
export interface WalkUpSongsTable {
  team_id: string
  user_id: string
  provider: 'appleMusic' | 'localFile'
  provider_id: string
  isrc: string | null
  title: string
  artist: string
  album: string | null
  artwork_url: string | null
  duration_ms: number
  start_ms: number
  end_ms: number
  set_by: string
  set_at: Timestamp
}

export interface ExternalIdsTable {
  id: string
  entity_type: string
  entity_id: string
  /** A caller-chosen name for the other system, `^[a-z][a-zA-Z0-9]{0,31}$`. */
  system: string
  kind: string
  external_id: string
  created_at: Timestamp
}

export interface GamesTable {
  guests: Generated<unknown>
  unrostered: Generated<unknown>
  notes: Generated<string | null>
  arrival_time_delta: Generated<number | null>
  end_at: Generated<Date | null>
  address: Generated<string | null>
  latitude: Generated<number | null>
  longitude: Generated<number | null>
  exhibition: Generated<boolean>
  timezone: Generated<string>
  outside_tournament: Generated<string | null>
  cancellation_reason: Generated<string | null>
  withdrawn_by_team_id: Generated<string | null>
  withdrawn_by_user_id: Generated<string | null>
  withdrawn_at: Timestamp | null
  id: string
  home_team_id: string
  away_team_id: string
  season_id: string | null
  start_at: Timestamp
  venue: string | null
  status: Generated<'scheduled' | 'inProgress' | 'final' | 'cancelled'>
  home_score: number | null
  away_score: number | null
  linescore: Json | null
  /** `teamstation` when a post from that system owns the plays. */
  scoringOwner: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >
  ingest_status: Generated<'none' | 'ok' | 'scoreMismatch' | 'error'>
  ingest_message: string | null
  /** The at-bat TeamStation is scoring now, as a Gumbo document. */
  currentPlay: Json | null
  /** The team-keyed lineups before the first pitch; see `atBatInProgress`. */
  pregame: Json | null
  /** Feet from home plate to the fence. Null takes the season's. */
  fence_distance_ft: number | null
  /** When the starting lineup was taken as the teams' defaults. */
  lineup_started_at: Timestamp | null
  /** A sha256 of both sides' lineups after the last live post. */
  lineups_digest: string | null
  /** Which set of plays the game holds: one more after each reset. */
  play_generation: Generated<number>
  created_at: Timestamp
  updated_at: Timestamp
  /** The registry field the game is on, and the size it is set up in. */
  field_id: Generated<string | null>
  field_size: Generated<string | null>
  /** The Auto-Scheduler preview the game was published from. */
  schedule_preview_id: Generated<string | null>
}

/**
 * One recording on its way in from a Director, in parts.
 *
 * The parts are files; this is what the server cannot learn from a directory
 * — whose upload it is, the game it lands on, and how far it has got.
 */
export interface DirectorUploadsTable {
  id: string
  user_id: string
  game_id: string | null
  title: string
  kind: Generated<string>
  filename: string
  /** Postgres `bigint` arrives as a string, like every other one here. */
  size_bytes: string
  part_size: number
  state: Generated<'open' | 'assembling' | 'ready' | 'failed' | 'abandoned'>
  received_bytes: Generated<string>
  video_id: string | null
  message: string | null
  /**
   * When the recording began, as the app that holds it says. What the video's
   * own `start_at` becomes, and so what the multi-camera view aligns a take's
   * angles on. Null from an app too old to say, and then the game's own time
   * is used — never the moment the upload happened to be opened.
   */
  started_at: Timestamp | null
  /**
   * The server's clock less the app's when the recording was made, in ms, as
   * the app measured it. Added to `started_at` when the upload is taken in,
   * so the video starts on the server's clock. Null from an app that did not
   * measure it.
   */
  server_clock_offset_ms: number | null
  /**
   * Which part of taking the upload in the server is on — `assembling`,
   * `probing`, `remuxing`, `uploading`, `writing` — while `state` says
   * `assembling`. Null before the finish is asked for and after it is done.
   * What lets an app say "converting" instead of showing a bar that has not
   * moved for four minutes.
   */
  step: string | null
  /**
   * The phone stream whose live copy this upload replaces, when the app named
   * one it may replace. Null for Director and Distributor uploads, which the
   * coverage rule places.
   */
  live_stream_id: string | null
  /** The recording ran for every moment that stream published. */
  whole_stream: Generated<boolean>
  created_at: Timestamp
  updated_at: Timestamp
}

export interface VideosTable {
  id: string
  game_id: string | null
  kind: 'program' | 'combined' | 'live'
  title: string
  storage: 'peertube' | 'local' | 'spaces'
  status: Generated<'live' | 'processing' | 'ready' | 'unavailable' | 'error'>
  status_message: string | null
  start_at: Timestamp | null
  /**
   * How `start_at` was worked out — a method, not a source of the file. An
   * upload says `distributor` whichever app sent it, because both read the
   * instant off the take's own index. A live video says `liveSession` when
   * the server placed it as the stream arrived, and `publisher` when the
   * phone or Director publishing it said when its first picture was captured.
   */
  start_at_source:
    | 'obsFilename'
    | 'liveSession'
    | 'originallyPublishedAt'
    | 'distributor'
    | 'manual'
    | 'publisher'
    | null
  /**
   * The measured offset, in ms, that moved `start_at` from the recording
   * app's clock onto the server's. Null when nothing was measured, and then
   * `start_at` is only as good as the clock that said it.
   */
  start_at_clock_offset_ms: number | null
  sync_offset_sec: Generated<number>
  duration_sec: number | null
  /** How many cameras the recording holds. One unless something says else. */
  num_cameras: Generated<number>
  width: number | null
  height: number | null
  codecs: string | null
  probed_master_mtime: Timestamp | null
  size_bytes: string | null
  sha256: string | null
  spaces_verified_at: Timestamp | null
  local_delete_after: Timestamp | null
  /** When a replaced recording may be deleted, objects and all. */
  purge_after: Timestamp | null
  /** The recording that took its place, which is why it is hidden. */
  replaced_by: string | null
  legacy_description: string | null
  published_at: Timestamp | null
  hidden: Generated<boolean>
  created_at: Timestamp
  updated_at: Timestamp
}

/** A column Postgres fills. Inserts and updates must not name it. */
type Filled<T> = ColumnType<T, never, never>

export interface EventsTable {
  id: string
  gameId: string
  startTime: Timestamp | null
  endTime: Timestamp | null
  battingTeamId: string | null
  gumbo: Json
  /**
   * True when the stored document's `credits` is an array, including an empty
   * one; the events trigger sets it. The two mean different things to
   * highlights: no `credits` key is a play whose sender said nothing about
   * credits, which is kept and shown by its type, and `[]` is a play found to
   * hold nothing worth watching, which is dropped.
   */
  creditsLookedAt: Generated<boolean>
  source: Generated<'external' | 'manual' | 'teamstation'>
  hidden: Generated<boolean>
  titleOverride: string | null
  timeNudgeSec: Generated<number>
  createdAt: Timestamp
  updatedAt: Timestamp
  atBatIndex: Filled<number>
  eventType: Filled<string | null>
  isScoringPlay: Filled<boolean | null>
  inning: Filled<number | null>
  halfInning: Filled<'top' | 'bottom' | string | null>
  rbi: Filled<number | null>
  awayScore: Filled<number | null>
  homeScore: Filled<number | null>
}

export interface EventCreditsTable {
  id: string
  eventId: string
  eventType: string
  teamId: string | null
  creditGumboId: number | null
  role: string | null
  position: string | null
  /** The label's first words, `Ground out`. */
  head: string
  /** Words after the person and position, ` pitching`. */
  suffix: string | null
  /** The fielders who assisted: `{ gumboId, position, name? }` each. */
  assists: ColumnType<CreditAssistRow[], CreditAssistRow[] | undefined, never>
  /** How the assists are joined: `from A, B` or `to A to B`. */
  assistWord: 'from' | 'to' | null
  /** The typed name of a credited person with no id. */
  typedName: string | null
  /**
   * False for a label that words its person with no position though the
   * credit has one: `Strikeout: X pitching` for a pitcher at P.
   */
  positionShown: Generated<boolean>
}

/** A fielder who assisted on a credit, as `"eventCredits".assists` holds him. */
export interface CreditAssistRow {
  gumboId: number | null
  position: string | null
  name?: string
}

export interface GumboIdsTable {
  gumbo_id: number
  user_id: string
  created_at: Timestamp
}

export interface EventPlayersTable {
  id: string
  event_id: string
  gumbo_id: number
  team_id: string | null
  role: 'batter' | 'pitcher' | 'runner' | 'scorer' | 'fielder' | 'catcher'
  position: string | null
}

export interface AuthSessionsTable {
  id: string
  user_id: string
  token_hash: string
  user_agent: string | null
  /** What this session is, when it is a thing rather than a browser tab. */
  device_name: string | null
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

/** One plate appearance and the state it began in. See 090plateAppearances. */
export interface PlateAppearancesTable {
  id: string
  game_id: string
  is_pa: Generated<boolean>
  at_bat_index: number
  inning: number
  half_inning: 'top' | 'bottom'
  batter_gumbo_id: number | null
  pitcher_gumbo_id: number | null
  batting_team_id: string | null
  pitching_team_id: string | null
  outs_before: number | null
  on_first: boolean | null
  on_second: boolean | null
  on_third: boolean | null
  first_pitch: 'ball' | 'strike' | 'inPlay' | 'other' | null
  pitches: Generated<number>
  first_pitch_thrown: 'ball' | 'strike' | 'inPlay' | 'other' | null
  pitches_thrown: Generated<number>
  ab: Generated<number>
  h: Generated<number>
  singles: Generated<number>
  doubles: Generated<number>
  triples: Generated<number>
  hr: Generated<number>
  bb: Generated<number>
  k: Generated<number>
  hbp: Generated<number>
  ci: Generated<number>
  sf: Generated<number>
  sh: Generated<number>
  rbi: Generated<number>
  outs_made: Generated<number>
}

/** An API key a person made under Account. See 089userApiKeys. */
export interface UserApiKeysTable {
  id: string
  user_id: string
  name: string
  token_hash: string
  secret_sealed: string
  permissions: string[]
  created_at: Timestamp
  last_used_at: Timestamp | null
  revoked_at: Timestamp | null
}

/**
 * An attempt to sign in by following a link.
 *
 * The token is hashed: a stolen database cannot be used to walk in. `purpose`
 * says where the link leads — the website, or the page that hands a sign-in
 * back to TS Director.
 */
export interface LoginRequestsTable {
  id: string
  email: string
  purpose: 'web' | 'device'
  token_hash: string
  device_name: string | null
  created_at: Timestamp
  expires_at: Timestamp
  consumed_at: Timestamp | null
}

/**
 * A standing offer to let somebody in, made by an administrator of the league,
 * season or team it names.
 */
export interface InvitesTable {
  id: string
  code: string
  scope_type: 'league' | 'season' | 'team'
  scope_id: string
  created_by: string | null
  label: string | null
  /** Null for an invite that never runs out of uses, which is the usual one. */
  max_uses: number | null
  uses: Generated<number>
  expires_at: Timestamp | null
  revoked_at: Timestamp | null
  source: Generated<'peertube' | 'manual'>
  created_at: Timestamp
  /** Set when the invitation was made out to one address and mailed to it. */
  for_email: string | null
  request_id: string | null
  /**
   * The player whose guardian (or adult family member, by `relative_kind`)
   * redeeming this makes somebody. Both set together, on team invites only.
   */
  guardian_of_user_id: Generated<string | null>
  relative_kind: Generated<'guardian' | 'family' | null>
}

/** Who redeemed which invite, and whether that is where their account began. */
export interface InviteRedemptionsTable {
  id: string
  invite_id: string
  user_id: string
  created_account: Generated<boolean>
  redeemed_at: Timestamp
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
  /** The link in the same e-mail. One sign-in, two doors. */
  token_hash: string | null
  /** Where the sign-in was asked for, so the link comes back to it. */
  origin: Generated<'web' | 'ios' | 'android'>
  /** Where the person was going before they were asked to sign in. */
  next_path: string | null
  /** The link host of the app the sign-in was asked for in; null on the web. */
  app_origin: string | null
  /** Held by the machine that asked, so it can finish a sign-in done elsewhere. */
  client_secret_hash: string | null
  approved_at: Timestamp | null
  /** The invite this sign-in carries, so finishing it also lets them in. */
  invite_id: string | null
  /**
   * What an account made by that invite will be called. Held only while the
   * code is pending: settling the account, spending or expiry forgets it.
   */
  display_name: string | null
}

export interface RateEventsTable {
  id: string
  scope: string
  key: string
  /** `Timestamp` already allows undefined on insert, which the default fills. */
  at: Timestamp
}

/** Every play a reset deleted, with the game as it stood. */
export interface GamePlayArchivesTable {
  id: string
  game_id: string
  archived_at: Generated<Timestamp>
  actor_user_id: string | null
  reason: 'resetSwap'
  home_team_id: string
  away_team_id: string
  status: string
  home_score: number | null
  away_score: number | null
  linescore: Json | null
  current_play: Json | null
  pregame: Json | null
  lineups_digest: string | null
  fence_distance_ft: number | null
  play_generation: number
  plays: Json
  players: Json
  tags: Json
}

export interface AuditLogTable {
  id: string
  at: Timestamp
  actor_user_id: string | null
  api_token_id: string | null
  user_api_key_id: Generated<string | null>
  method: string
  path: string
  entity_type: string | null
  entity_id: string | null
  before: Json | null
  after: Json | null
}

/**
 * The one row whose `value` is the revision screen scopes are told about.
 * `value` is a bigint: read it as `value::text`, since the int8 parser
 * refuses one past a safe integer.
 */
export interface SyncClockTable {
  id: number
  value: ColumnType<number | string, number | string, number | string>
}

/**
 * A queued write's answer, by the key its sender gave it: one per person and
 * key. `request_hash` is of the method, path and body, so the key cannot be
 * spent on another request. `result_id` is set in the write's transaction;
 * `status` and `body` once the answer is read, and empty until then.
 */
export interface SyncIdempotencyTable {
  user_id: string
  key: string
  method: string
  path: string
  request_hash: string
  status: number | null
  body: Json | null
  result_id: string | null
  created_at: Timestamp
}

export interface SystemSettingsTable {
  key: string
  value: Json
  updated_at: Timestamp
  updated_by: string | null
}

/**
 * A destination a game can be streamed to.
 *
 * `key_hash` is what a publish is checked against; `key_cipher` is the sealed
 * key itself, because this secret is meant to be read back and pasted into
 * streaming software. `status` is the ingest's own snapshot, written on a
 * timer: the API never talks to the ingest process, it reads this row.
 */
export interface LiveStreamsTable {
  id: string
  game_id: string
  team_id: string
  /** Whose key this is. A key publishes video as somebody. */
  user_id: string
  /** Which of that person's four cameras for this game. */
  slot: Generated<number>
  /** What the camera is called. `Camera <slot>` where nobody has said. */
  label: string | null
  key_hash: string
  key_prefix: string
  key_cipher: string
  state: Generated<'idle' | 'publishing' | 'ended' | 'revoked'>
  opens_at: Timestamp
  /** When somebody ended this key. Null until they do: it is not on a clock. */
  closes_at: Timestamp | null
  video_id: string | null
  status: Json | null
  status_at: Timestamp | null
  last_error: string | null
  first_published_at: Timestamp | null
  last_published_at: Timestamp | null
  ended_at: Timestamp | null
  created_by: string | null
  /** The install that holds this stream. Null for a browser or software. */
  device_id: string | null
  /** What that device is, in words: `iPhone 13 Pro`, `iPad Pro`. */
  device_model: string | null
  /** The phone's own recording: `none`, `recorded`, or `uploaded`. */
  local_recording: Generated<'none' | 'recorded' | 'uploaded'>
  /** Only the phone's own upload replaces this stream's live copy. */
  records_locally: Generated<boolean>
  /** The legacy Director claim route has returned this stream. */
  director_claimed: Generated<boolean>
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * One row per game that has had plays written: the generation asked for, the
 * one built, the status and its reason, and the retry clock. The events write
 * path asks; the stats builder records the result.
 */
export interface GameStatsStateTable {
  game_id: string
  requested_generation: number
  built_generation: Generated<number>
  status: 'pending' | 'built' | 'incomplete' | 'failed'
  detail: string | null
  attempts: Generated<number>
  retry_at: Timestamp | null
  requested_at: Timestamp
  built_at: Timestamp | null
}

/**
 * One player's figures for one game.
 *
 * Written by a stats engine outside the routes, which recomputes a game's rows
 * whenever its plays change, so this is a derived table that can be dropped
 * and rebuilt. A game with no rows yet has no box score.
 */
export interface GamePlayerStatsTable {
  id: string
  game_id: string
  gumbo_id: number
  team_id: string | null
  pa: Generated<number>
  ab: Generated<number>
  h: Generated<number>
  singles: Generated<number>
  doubles: Generated<number>
  triples: Generated<number>
  hr: Generated<number>
  bb: Generated<number>
  k: Generated<number>
  r: Generated<number>
  rbi: Generated<number>
  hbp: Generated<number>
  ci: Generated<number>
  sf: Generated<number>
  sh: Generated<number>
  sb: Generated<number>
  cs: Generated<number>
  pitch_bf: Generated<number>
  pitch_outs: Generated<number>
  pitch_h: Generated<number>
  pitch_hr: Generated<number>
  pitch_bb: Generated<number>
  pitch_hbp: Generated<number>
  pitch_k: Generated<number>
  pitch_r: Generated<number>
  pitch_er: Generated<number>
  extra: Json | null
  computed_at: Timestamp
}

export interface EventTagsTable {
  game_id: string
  target_id: string
  at_bat_index: number
  event_index: number | null
  tag: string
  assigned_by: string
}
export interface UserTagsTable {
  user_id: string
  tag: string
  last_used: Generated<number>
}

export interface SeasonTeamParentsTable {
  season_id: string
  team_id: string
  created_at: Timestamp
}

export interface CreationIdempotencyTable {
  user_id: string
  key: string
  body_hash: string
  response: Json
  created_at: Timestamp
}

export interface GroupRequestsTable {
  id: string
  kind:
    | 'parent'
    | 'participation'
    | 'promotion'
    | 'person'
    | 'membership'
    | 'guardian'
    | 'game'
    | 'gameChange'
    | 'playerAdd'
  sender_id: string
  /** Null for a guardian or membership request sent on one’s own behalf. */
  sender_scope_type: 'league' | 'season' | 'team' | null
  sender_scope_id: string | null
  terms: Json
  revision: Generated<number>
  status: Generated<
    | 'pending'
    | 'accepted'
    | 'declined'
    | 'expired'
    | 'cancelled'
    | 'superseded'
    | 'applied'
  >
  sent_at: Timestamp
  expires_at: Timestamp
  resolved_at: Timestamp | null
  resolved_by: string | null
  game_id: string | null
  initiating_team_id: string | null
  sender_hidden: Generated<boolean>
  supersedes_id: string | null
}

/**
 * A person whose part in a played game was withdrawn by rejecting the add
 * that put them there: the game reads `label` in their place, and their own
 * record leaves the game out (097noticeRequests).
 */
export interface GameWithdrawnPlayersTable {
  game_id: string
  user_id: string
  side: 'away' | 'home'
  request_id: string
  label: string
  withdrawn_at: Generated<Timestamp>
}

export interface GroupRequestSidesTable {
  request_id: string
  scope_type: 'league' | 'season' | 'team' | 'user'
  scope_id: string
  approved_by: string | null
  approved_at: Timestamp | null
}

export interface NotificationEventsTable {
  id: string
  source_type: string
  source_id: string
  revision: number
  actor_id: string | null
  metadata: Json
  recorded_recipients: Generated<string[]>
  created_at: Timestamp
}

export interface NotificationReceiptsTable {
  event_id: string
  user_id: string
  viewed_at: Timestamp
  /** When the person dismissed a reminder, or its upload landed. */
  dismissed_at: Timestamp | null
}

export interface TeamEventsTable {
  notes: Generated<string | null>
  arrival_time_delta: Generated<number | null>
  event_type: Generated<'practice' | 'other'>
  id: string
  team_id: string
  title: string
  start_at: Timestamp
  end_at: Generated<Date | null>
  timezone: Generated<string>
  venue: Generated<string | null>
  address: Generated<string | null>
  latitude: Generated<number | null>
  longitude: Generated<number | null>
  status: Generated<'scheduled' | 'cancelled'>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
export interface EventRsvpsTable {
  event_id: string
  user_id: string
  response: 'yes' | 'maybe' | 'no'
  updated_by: string | null
  updated_at: Generated<Date>
}

/** One write to a game's board that was not TeamStation scoring. */
export interface ScoreboardLogTable {
  /** Explicit positive speeds; measurementOnly marks an older snapshot that
   * is retained for radar matching but excluded from the board timeline. */
  radar: Json
  game_id: string
  /** The Redis write's version for the game. */
  version: number
  /** The server's time when the write was taken in. */
  at: Timestamp
  cause: 'publisher' | 'speedHold' | 'dashboard' | 'reset'
  actor_id: string | null
  /** The publisher's slot after the write, `{ state, receivedAt }`. */
  publisher: Json | null
  overrides: Json
}

/** One point of a video's wall-clock timeline. */
export interface VideoWallAnchorsTable {
  video_id: string
  /** Playlist time, as the player's `currentTime`. */
  media_ms: number
  /** The server-clock instant of the frame at `media_ms`. */
  wall: Timestamp
  source: 'sei' | 'arrival'
  /** False for a wall clock stamped without a measured server offset. */
  corrected: Generated<boolean>
}

export interface LeagueUmpiresTable {
  league_id: string
  user_id: string
  granted_by: string
  granted_at: Generated<Date>
}
export interface UmpireLevelsTable {
  id: string
  league_id: string
  name: string
  position: number
}
export interface SeasonUmpireRequirementsTable {
  season_id: string
  level_id: string
}
export interface UmpireCertificationsTable {
  user_id: string
  level_id: string
  type_id: string
  enabled: Generated<boolean>
}
export interface UmpireAssignmentsTable {
  game_id: string
  slot: string
  user_id: string
  assigned_by: string
  credit_team_id: string | null
  created_at: Generated<Date>
}

/** `date[]`: read through `calendarDateText`, which takes Date or text. */
type CalendarDates = ColumnType<unknown, string[] | undefined, string[]>

/** A real place from Google Maps that leagues can claim and schedule on. */
export interface VenuesTable {
  id: string
  google_place_id: string
  name: string
  address: Generated<string>
  latitude: number
  longitude: number
  timezone: string
  size_switch_minutes: Generated<number>
  /** A weekly-hours list (`src/common/venues.ts`). */
  default_hours: ColumnType<unknown, string | undefined, string>
  default_blackouts: CalendarDates
  photo_path: string | null
  photo_sha256: string | null
  photo_updated_at: Timestamp | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

/** One field at a venue, in the sizes it can be set up in. */
export interface VenueFieldsTable {
  id: string
  venue_id: string
  name: string
  sizes: string[]
  pin_latitude: number | null
  pin_longitude: number | null
  starts_on: ColumnType<unknown, string | null | undefined, string | null>
  ends_on: ColumnType<unknown, string | null | undefined, string | null>
  /** Null takes the venue's default hours. */
  hours: ColumnType<unknown, string | null | undefined, string | null>
  blackouts: CalendarDates
  photo_path: string | null
  photo_sha256: string | null
  photo_updated_at: Timestamp | null
  deleted_at: Timestamp | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

/** One build of a league's schedule, and the edits made to one option. */
export interface SchedulePreviewsTable {
  id: string
  league_id: string
  created_by: string
  created_at: Generated<Date>
  mode: 'full' | 'partial'
  /** The snapshot the engine ran on (`src/server/autoScheduler/snapshot.ts`). */
  input: ColumnType<unknown, string, string>
  /** The engine's options (`src/common/autoScheduler/types.ts`). */
  options: ColumnType<unknown, string | undefined, string>
  /** Why no option could be built, when none could. */
  blocking: string | null
  /** Rejected and added games (`src/common/schedulePreviews.ts`). */
  edits: ColumnType<unknown, string | undefined, string>
  status: Generated<'open' | 'published' | 'discarded'>
  published_option: number | null
  published_at: Timestamp | null
  /** How many upcoming games its publication replaced. */
  removed_games: number | null
}

/** A game a publication proposed. */
export interface SchedulePreviewGamesTable {
  preview_id: string
  game_key: string
  season_id: string
  home_team_id: string
  away_team_id: string
  request_id: string | null
  game_id: string | null
  rejected_at: Timestamp | null
  resolved_at: Timestamp | null
}

/** A team marked as an exhibition team in a season. */
export interface SeasonTeamFlagsTable {
  season_id: string
  team_id: string
  exhibition: Generated<boolean>
}

/** A season's scheduling settings for the Auto-Scheduler. */
export interface SeasonScheduleSettingsTable {
  season_id: string
  field_size: string
  game_minutes: number
  buffer_minutes: number
  regular_games: number
  exhibition_games: number
  doubleheaders: 'never' | 'ifNecessary' | 'allowed'
  starts_on: ColumnType<unknown, string, string>
  ends_on: ColumnType<unknown, string, string>
  blackouts: CalendarDates
  /** A list of window periods (`src/common/seasonScheduling.ts`). */
  windows: ColumnType<unknown, string | undefined, string>
  updated_at: Generated<Date>
}

/** The seasons and fields a league's next schedule is built from. */
export interface LeagueScheduleSetupsTable {
  league_id: string
  season_ids: Generated<string[]>
  field_ids: Generated<string[]>
  /** Fields added from other venues, listed whether chosen or not. */
  added_field_ids: Generated<string[]>
  updated_at: Generated<Date>
}

/** A warning about a game's field, once it has been announced. */
export interface GameFieldWarningsTable {
  game_id: string
  kind: 'conflict' | 'outsideAvailability' | 'fieldDeleted' | 'sizeRemoved'
  other_ref: Generated<string>
  notified_at: Generated<Date>
}

/** A league's claim on a venue, or its request to co-own one. */
export interface VenueClaimsTable {
  id: string
  venue_id: string
  league_id: string
  kind: 'claim' | 'coOwner'
  requested_by: string
  status: Generated<'pending' | 'approved' | 'rejected' | 'left' | 'removed'>
  requested_at: Timestamp
  approves_at: Timestamp
  decided_by: string | null
  decided_at: Timestamp | null
}

/**
 * One person's conversation with Tess (085tess): the summary of the turns
 * compaction removed, the size of the last request, in tokens, and the turn
 * running on it, if any: its owner's id and when its claim lapses.
 */
export interface TessConversationsTable {
  user_id: string
  summary: string | null
  context_tokens: Generated<number>
  turn_owner: string | null
  turn_until: Timestamp | null
  updated_at: Generated<Date>
}

/**
 * A message of a Tess conversation: Anthropic content blocks as they were
 * sent and received. An attachment is `{type: 'attachment', id}`, expanded
 * when the request is built. `id` is a bigint, read as a number.
 */
export interface TessMessagesTable {
  id: Generated<number>
  user_id: string
  role: 'user' | 'assistant'
  content: Json
  created_at: Generated<Date>
}

/** A file given to Tess. Compaction sets `description` and clears `data`. */
export interface TessAttachmentsTable {
  id: string
  user_id: string
  name: string
  media_type: string
  kind: 'image' | 'csv' | 'text' | 'markdown'
  data: Buffer | null
  description: string | null
  created_at: Generated<Date>
}

/** A change Tess proposed, which runs only when its person confirms it. */
export interface TessChangesTable {
  id: string
  user_id: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body: Json | null
  summary: string
  status: Generated<
    'pending' | 'running' | 'done' | 'failed' | 'expired' | 'unknown'
  >
  result: Json | null
  created_at: Generated<Date>
  expires_at: Timestamp
  /** When it was confirmed and began to run. */
  started_at: Timestamp | null
}

/**
 * Tess's tokens for one person in one UTC week, from Monday (085tess).
 * `week_start` is a `date`: read it as text, never as a Date, which `pg`
 * places at local midnight. The token counts are bigints, read as numbers.
 */
export interface TessUsageWeeksTable {
  user_id: string
  week_start: ColumnType<unknown, string, never>
  input_tokens: Generated<number>
  output_tokens: Generated<number>
  requests: Generated<number>
}

/** The audience a conversation is kept to, or `dm` (052chat). */
export type ChatKind =
  | 'teamStaff'
  | 'teamMembers'
  | 'teamFans'
  | 'seasonStaff'
  | 'seasonAllStaff'
  | 'seasonAnnouncements'
  | 'leagueOrg'
  | 'dm'

/** A device holding chat keys, bound to the session it signed in with. */
export interface ChatDevicesTable {
  id: string
  user_id: string
  session_id: string | null
  name: string
  platform: 'web' | 'ios' | 'android'
  box_public_key: Bytes
  sign_public_key: Bytes
  created_at: Generated<Date>
  last_seen_at: Generated<Date>
  revoked_at: Timestamp | null
}

/** A nonce a device signs to bind itself to a new session; used once. */
export interface ChatResumeChallengesTable {
  nonce: Bytes
  device_id: string
  created_at: Generated<Date>
  expires_at: Timestamp
}

/** A user's identity key; at most one per user is not `replaced_at`. */
export interface ChatIdentitiesTable {
  id: string
  user_id: string
  identity_public_key: Bytes
  created_at: Generated<Date>
  replaced_at: Timestamp | null
}

/** One generation of a user's per-user key, signed by the identity. */
export interface ChatUserKeysTable {
  user_id: string
  identity_id: string
  generation: number
  public_key: Bytes
  signature: Bytes
  previous_keys_box: Bytes | null
  created_at: Generated<Date>
}

/** A per-user key generation, boxed to one of the user's devices. */
export interface ChatUserKeyBoxesTable {
  user_id: string
  identity_id: string
  generation: number
  device_id: string
  box: Bytes
  created_at: Generated<Date>
}

/** A new device asking a linked one for the identity. */
export interface ChatLinksTable {
  id: string
  user_id: string
  new_device_id: string
  approved_by_device_id: string | null
  box: Bytes | null
  created_at: Generated<Date>
  expires_at: Timestamp
}

/** A chat. A scope chat names its scope; a DM has none. */
export interface ChatConversationsTable {
  id: string
  kind: ChatKind
  scope_type: 'team' | 'season' | 'league' | null
  scope_id: string | null
  created_by: string | null
  needs_rotation: Generated<boolean>
  closed_at: Timestamp | null
  /** The last message's `seq`. */
  last_seq: Generated<number>
  /** The last membership log row's `seq`. */
  last_log_seq: Generated<number>
  created_at: Generated<Date>
}

/** Who is in a chat, and who was (`left_at`). */
export interface ChatMembersTable {
  conversation_id: string
  user_id: string
  joined_at: Generated<Date>
  left_at: Timestamp | null
  created_at: Generated<Date>
}

/** The hash-chained record of a chat's membership. */
export interface ChatMembershipLogTable {
  conversation_id: string
  seq: number
  event: 'join' | 'leave' | 'identityReset' | 'closed'
  user_id: string
  actor_user_id: string | null
  reason: string | null
  prev_hash: Bytes
  hash: Bytes
  at: Timestamp
  created_at: Generated<Date>
}

/** One epoch of a chat's key, chained to the one before. */
export interface ChatEpochsTable {
  conversation_id: string
  epoch: number
  created_by_user_id: string
  identity_id: string
  /** Null on epoch 1 and on a chain break. */
  previous_key_box: Bytes | null
  chain_break: Generated<boolean>
  signature: Bytes
  created_at: Generated<Date>
}

/** An epoch key, wrapped to one member's per-user key. */
export interface ChatEpochBoxesTable {
  conversation_id: string
  epoch: number
  user_id: string
  identity_id: string
  generation: number
  box: Bytes
  granted_by_user_id: string | null
  created_at: Generated<Date>
}

/** A member asking for a chat's latest key; open until filled or superseded. */
export interface ChatGrantRequestsTable {
  id: Generated<number>
  conversation_id: string
  user_id: string
  identity_id: string
  generation: number
  identity_reset: Generated<boolean>
  opened_at: Generated<Date>
  filled_at: Timestamp | null
  superseded_at: Timestamp | null
  created_at: Generated<Date>
}

/** One encrypted message. The server sees its envelope, never its content. */
export interface ChatMessagesTable {
  id: string
  conversation_id: string
  seq: number
  epoch: number
  sender_user_id: string
  sender_identity_id: string
  kind: 'post' | 'reaction' | 'edit' | 'delete' | 'moderatorDelete'
  /** Set on the two delete kinds only. */
  target_ids: string[] | null
  nonce: Bytes
  ciphertext: Bytes
  signature: Bytes
  cleared_at: Timestamp | null
  created_at: Generated<Date>
}

/** Which uploads a message's content refers to. */
export interface ChatMessageAttachmentsTable {
  message_id: string
  attachment_id: string
  created_at: Generated<Date>
}

/** An encrypted upload, put to the Space once complete. */
export interface ChatAttachmentsTable {
  id: string
  conversation_id: string
  uploader_user_id: string
  size: number
  object_key: string
  digest: Bytes
  completed_at: Timestamp | null
  created_at: Generated<Date>
}

/** How far a member has read. */
export interface ChatReadCursorsTable {
  conversation_id: string
  user_id: string
  seq: Generated<number>
  at: Generated<Date>
  created_at: Generated<Date>
}

/** A reported message, with its text and key disclosed by the reporter. */
export interface ChatReportsTable {
  id: string
  conversation_id: string
  message_id: string
  reporter_user_id: string
  /** The message row as it stood when reported. */
  envelope: Json
  message_key: Bytes
  plaintext: string
  verified: boolean
  created_at: Generated<Date>
  resolved_at: Timestamp | null
}

/** A scope or user whose chats may have changed, set by triggers. */
export interface ChatDirtyTable {
  scope_type: 'team' | 'season' | 'league' | 'user'
  scope_id: string
  marked_at: Generated<Date>
}

export interface ChatConversationPreferencesTable {
  user_id: string
  conversation_id: string
  pinned: Generated<boolean>
  muted: Generated<boolean>
  manual_unread: Generated<boolean>
  manual_unread_revision: Generated<number>
}

export interface ChatMessagePinsTable {
  user_id: string
  conversation_id: string
  message_id: string
  pinned_at: Generated<Date>
}

export interface Database {
  umpire_note_types: UmpireLevelsTable
  game_umpire_notes: { game_id: string; note_type_id: string; value: string }
  league_umpires: LeagueUmpiresTable
  umpire_types: UmpireLevelsTable & { legacy_kind: Generated<string | null> }
  season_umpire_type_requirements: {
    season_id: string
    type_id: string
    required_count: number
    optional_count: number
  }
  umpire_levels: UmpireLevelsTable
  season_umpire_requirements: SeasonUmpireRequirementsTable
  umpire_certifications: UmpireCertificationsTable
  umpire_assignments: UmpireAssignmentsTable
  game_guest_details: {
    game_id: string
    user_id: string
    jersey: string | null
    positions: string[]
    /** An existing person added for this game only (097noticeRequests). */
    pool: Generated<boolean>
  }
  game_withdrawn_players: GameWithdrawnPlayersTable
  team_events: TeamEventsTable
  game_rsvps: EventRsvpsTable
  team_event_rsvps: EventRsvpsTable
  event_geocodes: {
    address: string
    latitude: number
    longitude: number
    updated_at: Generated<Date>
  }
  event_tag_catalog: { tag: string }
  event_tags: EventTagsTable
  user_tags: UserTagsTable
  creation_idempotency: CreationIdempotencyTable
  follows: FollowsTable
  group_requests: GroupRequestsTable
  group_request_sides: GroupRequestSidesTable
  notification_events: NotificationEventsTable
  notification_receipts: NotificationReceiptsTable
  season_team_parents: SeasonTeamParentsTable
  api_tokens: ApiTokensTable
  audit_log: AuditLogTable
  user_api_keys: UserApiKeysTable
  plate_appearances: PlateAppearancesTable
  game_play_archives: GamePlayArchivesTable
  auth_sessions: AuthSessionsTable
  chat_attachments: ChatAttachmentsTable
  chat_conversations: ChatConversationsTable
  chat_conversation_preferences: ChatConversationPreferencesTable
  chat_devices: ChatDevicesTable
  chat_dirty: ChatDirtyTable
  chat_epoch_boxes: ChatEpochBoxesTable
  chat_epochs: ChatEpochsTable
  chat_grant_requests: ChatGrantRequestsTable
  chat_identities: ChatIdentitiesTable
  chat_links: ChatLinksTable
  chat_members: ChatMembersTable
  chat_membership_log: ChatMembershipLogTable
  chat_message_attachments: ChatMessageAttachmentsTable
  chat_messages: ChatMessagesTable
  chat_message_pins: ChatMessagePinsTable
  chat_read_cursors: ChatReadCursorsTable
  chat_reports: ChatReportsTable
  chat_resume_challenges: ChatResumeChallengesTable
  chat_user_key_boxes: ChatUserKeyBoxesTable
  chat_user_keys: ChatUserKeysTable
  email_codes: EmailCodesTable
  rate_events: RateEventsTable
  eventCredits: EventCreditsTable
  gumbo_ids: GumboIdsTable
  event_players: EventPlayersTable
  events: EventsTable
  external_ids: ExternalIdsTable
  games: GamesTable
  game_field_warnings: GameFieldWarningsTable
  league_schedule_setups: LeagueScheduleSetupsTable
  season_schedule_settings: SeasonScheduleSettingsTable
  season_team_flags: SeasonTeamFlagsTable
  schedule_preview_games: SchedulePreviewGamesTable
  schedule_previews: SchedulePreviewsTable
  game_player_stats: GamePlayerStatsTable
  game_stats_state: GameStatsStateTable
  invite_redemptions: InviteRedemptionsTable
  invites: InvitesTable
  league_members: LeagueMembersTable
  leagues: LeaguesTable
  live_streams: LiveStreamsTable
  login_requests: LoginRequestsTable
  memberships: MembershipsTable
  narration_audio: NarrationAudioTable
  season_members: SeasonMembersTable
  scope_roles: ScopeRolesTable
  scoreboard_log: ScoreboardLogTable
  season_teams: SeasonTeamsTable
  seasons: SeasonsTable
  sync_clock: SyncClockTable
  sync_idempotency: SyncIdempotencyTable
  system_settings: SystemSettingsTable
  team_follows: TeamFollowsTable
  teams: TeamsTable
  tess_attachments: TessAttachmentsTable
  tess_changes: TessChangesTable
  tess_conversations: TessConversationsTable
  tess_messages: TessMessagesTable
  tess_usage_weeks: TessUsageWeeksTable
  user_links: UserLinksTable
  user_emails: UserEmailsTable
  users: UsersTable
  video_wall_anchors: VideoWallAnchorsTable
  venue_claims: VenueClaimsTable
  venue_fields: VenueFieldsTable
  venues: VenuesTable
  videos: VideosTable
  walk_up_songs: WalkUpSongsTable
  director_uploads: DirectorUploadsTable
}

export function makeDatabase(connectionString: string): Kysely<Database> {
  attachInt8Parser()
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: makePool(connectionString) })
  })
}

/**
 * The pool, with every connection it opens listening for its own `'error'`.
 *
 * Postgres can drop a connection at any time: a restart, a full disk, an
 * administrator's `pg_terminate_backend`. pg raises that as an `'error'` event
 * on the connection's `Client`, and an event nobody hears takes the whole
 * process down. The pool listens on a connection only while it sits idle, so a
 * connection lost while a request has it checked out went unheard. Here each
 * connection listens from the moment it opens: the query in flight rejects,
 * the request answers its error, and the pool drops the dead connection and
 * opens a fresh one for the next query.
 */
export function makePool(
  connectionString: string,
  log: (message: string) => void = message => {
    console.error(message)
  }
): Pool {
  const pool = new Pool({ connectionString, max: 10 })
  pool.on('connect', client => {
    client.on('error', (error: Error) => {
      log(`database: connection lost: ${error.message}`)
    })
  })
  // The pool repeats an idle connection's error here, which the connection's
  // own listener has already logged. Unheard, the repeat would be fatal too.
  pool.on('error', () => undefined)
  return pool
}
