import { type Kysely, sql } from 'kysely'

import { badRequest } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import {
  UMPIRE_MISSING_SLOTS,
  UMPIRE_SIGN_UP,
  UMPIRE_WITHDRAW
} from '../../common/notifications'
import { OPEN_SIDE_NAME } from '../../common/openSides'
import {
  DEFAULT_UMPIRE_NOTIFICATIONS,
  UMPIRE_NOTICE_DAYS,
  type UmpireNotificationSettings,
  umpirePositionName,
  umpirePositions
} from '../../common/umpires'
import {
  daysBetween,
  localClock,
  localDate,
  umpireDate
} from '../../common/umpireTime'
import { roleScopesForUsers } from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { skipWhileRunning, type Stoppable } from '../backgroundJobs'
import type { Database } from '../db/database'
import { administers, requireGroupAdmin } from '../groups/rights'
import type { PushEnqueuer } from '../push/queue'
import type { LeaguePushRequest } from '../push/requests'
import { shortNamesOf } from '../users/nameBook'
import { types } from './types'

/**
 * Umpire Management Notifications: what each league admin chose for
 * themselves (`league_umpire_notifications`), and the notices recorded for
 * them in `notification_events`, each also pushed to their devices with
 * "Notify for league management" on.
 *
 * - The daily digest (`umpireMissingSlots`): once a day from 10:00 in the
 *   league's zone, each admin with missing slots on gets one notice listing
 *   every game of the league within their window that still has an empty
 *   required position, if any. Its source is the admin and league, and its
 *   revision the league's date, so a rerun or a second node adds nothing.
 *   It waits in Pending until dismissed or replaced by the next day's, and
 *   is settled, that day's included, when no game is left to list or the
 *   admin no longer gets one (missing slots off, umpire management off, or
 *   no longer an admin). Once the day's is settled the admin gets no other
 *   that day, so missing slots turned back on counts from the next day's.
 * - A sign-up (`umpireSignUp`) and an umpire's own withdrawal
 *   (`umpireWithdraw`) go to the admins with them on, never to the person
 *   who acted. An admin removing someone else's assignment tells nobody.
 *
 * Nothing is recorded for a league that does not manage umpires, nor for
 * anyone who is not an admin of it (or a site administrator) any more.
 */

/** A notice's push, queued once the write that recorded it commits. */
export type LeagueNoticePush = Omit<LeaguePushRequest, 'v' | 'attempt'>

/** When no locality names a zone the digest goes by. */
export const DEFAULT_LEAGUE_ZONE = 'America/Los_Angeles'

/** The league-local time of day from which the day's digest is recorded. */
export const DIGEST_TIME = '10:00'

const SETTING_KEYS = [
  'missingSlots',
  'daysBefore',
  'signUps',
  'withdrawals'
] as const

/** A settings row as the API answers it; none is the defaults. */
function settingsOf(
  row:
    | {
        missing_slots: boolean
        days_before: number
        sign_ups: boolean
        withdrawals: boolean
      }
    | undefined
): UmpireNotificationSettings {
  if (row == null) return { ...DEFAULT_UMPIRE_NOTIFICATIONS }
  return {
    missingSlots: row.missing_slots,
    daysBefore: row.days_before,
    signUps: row.sign_ups,
    withdrawals: row.withdrawals
  }
}

/**
 * A `PUT /leagues/:leagueId/umpire-notifications` body: any of the four
 * settings, the toggles booleans and `daysBefore` a whole number of days
 * from 1 to 30.
 */
export function noticeSettingsChange(
  body: unknown
): Partial<UmpireNotificationSettings> {
  if (body == null || typeof body !== 'object' || Array.isArray(body))
    throw badRequest('Supply umpire notification settings')
  const change: Partial<UmpireNotificationSettings> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key))
      throw badRequest(`Unknown umpire notification setting ${key}`)
    if (key === 'daysBefore') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < UMPIRE_NOTICE_DAYS.min ||
        value > UMPIRE_NOTICE_DAYS.max
      )
        throw badRequest(
          `daysBefore must be a whole number from ${UMPIRE_NOTICE_DAYS.min} to ${UMPIRE_NOTICE_DAYS.max}`
        )
      change.daysBefore = value
    } else {
      if (typeof value !== 'boolean')
        throw badRequest(`${key} must be true or false`)
      change[key as 'missingSlots' | 'signUps' | 'withdrawals'] = value
    }
  }
  return change
}

/** The caller's own settings for a league they administer. */
export async function noticeSettings(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string
): Promise<UmpireNotificationSettings> {
  await requireGroupAdmin(db, actor, { kind: 'league', id: leagueId })
  return settingsOf(
    await db
      .selectFrom('league_umpire_notifications')
      .select(['missing_slots', 'days_before', 'sign_ups', 'withdrawals'])
      .where('league_id', '=', leagueId)
      .where('user_id', '=', actor.userId)
      .executeTakeFirst()
  )
}

/**
 * Changes the caller's own settings for a league they administer: what
 * `change` names, the rest as they were (the defaults, the first time).
 * Turning missing slots off settles the caller's digests for the league,
 * today's included; turned back on, it counts from the next day's digest.
 */
export async function saveNoticeSettings(
  trx: Kysely<Database>,
  actor: Actor,
  leagueId: string,
  change: Partial<UmpireNotificationSettings>
): Promise<UmpireNotificationSettings> {
  await requireGroupAdmin(trx, actor, { kind: 'league', id: leagueId })
  const columns = {
    ...(change.missingSlots == null
      ? {}
      : { missing_slots: change.missingSlots }),
    ...(change.daysBefore == null ? {} : { days_before: change.daysBefore }),
    ...(change.signUps == null ? {} : { sign_ups: change.signUps }),
    ...(change.withdrawals == null ? {} : { withdrawals: change.withdrawals })
  }
  const now = new Date()
  const before = await trx
    .selectFrom('league_umpire_notifications')
    .select('missing_slots')
    .where('league_id', '=', leagueId)
    .where('user_id', '=', actor.userId)
    .forUpdate()
    .executeTakeFirst()
  const row = await trx
    .insertInto('league_umpire_notifications')
    .values({
      league_id: leagueId,
      user_id: actor.userId,
      ...columns,
      updated_at: now
    })
    .onConflict(oc =>
      oc.columns(['league_id', 'user_id']).doUpdateSet({
        ...columns,
        updated_at: now
      })
    )
    .returning(['missing_slots', 'days_before', 'sign_ups', 'withdrawals'])
    .executeTakeFirstOrThrow()
  const wasOn =
    before?.missing_slots ?? DEFAULT_UMPIRE_NOTIFICATIONS.missingSlots
  if (wasOn && !row.missing_slots) {
    // Turning missing slots off takes the admin's digest out of Pending.
    await settleDigests(
      trx,
      digestSource(leagueId, actor.userId),
      actor.userId,
      null,
      now
    )
  }
  return settingsOf(row)
}

/** A digest's `source_id`: the league and the admin it is for. */
function digestSource(leagueId: string, userId: string): string {
  return `${leagueId}:${userId}`
}

/** An admin who hears of a notice, and the digest window they chose. */
export interface NoticeRecipient {
  userId: string
  daysBefore: number
}

/**
 * Who of this league's admins hears of a notice of this kind: those who
 * turned it on, while they still administer the league (or are a site
 * administrator) and can sign in, less `except` (who acted), by id, each
 * with their `daysBefore`. Nobody while the league does not manage umpires.
 */
export async function noticeRecipients(
  db: Kysely<Database>,
  leagueId: string,
  column: 'missing_slots' | 'sign_ups' | 'withdrawals',
  except: readonly string[] = []
): Promise<NoticeRecipient[]> {
  const league = await db
    .selectFrom('leagues')
    .select('umpire_management')
    .where('id', '=', leagueId)
    .executeTakeFirst()
  if (league?.umpire_management !== true) return []
  const chose = await db
    .selectFrom('league_umpire_notifications')
    .select(['user_id', 'days_before'])
    .where('league_id', '=', leagueId)
    .where(column, '=', true)
    .orderBy('user_id')
    .execute()
  const asked = chose.filter(row => !except.includes(row.user_id))
  if (asked.length === 0) return []
  // Only those who chose are checked, as `adminRecipients` would check them:
  // able to sign in, not disabled or merged, and a league or site admin.
  const live = await db
    .selectFrom('users')
    .select('id')
    .where(
      'id',
      'in',
      asked.map(row => row.user_id)
    )
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .where('merged_into', 'is', null)
    .execute()
  if (live.length === 0) return []
  const scopes = await roleScopesForUsers(
    db,
    live.map(user => user.id)
  )
  const group: GroupRef = { kind: 'league', id: leagueId }
  return asked
    .filter(row => {
      const held = scopes.get(row.user_id)
      return held != null && administers(held, group)
    })
    .map(row => ({ userId: row.user_id, daysBefore: row.days_before }))
}

/** The zone a league's digest keeps: its locality's, else Pacific. */
export function leagueZone(locality: unknown): string {
  const zone =
    locality != null && typeof locality === 'object'
      ? (locality as { timezone?: unknown }).timezone
      : undefined
  if (typeof zone !== 'string' || zone === '') return DEFAULT_LEAGUE_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
    return zone
  } catch {
    return DEFAULT_LEAGUE_ZONE
  }
}

/** Whether the day's digest is due at `now` in `zone`: 10:00 or later. */
export function digestDue(now: Date, zone: string): boolean {
  return localClock(now, zone) >= DIGEST_TIME
}

/**
 * How many calendar days out a game starting at `startAt` is at `now`, both
 * read in `zone` (the game's own, as the umpire schedule reads it): 0 today,
 * 1 tomorrow.
 */
export function daysOut(now: Date, startAt: Date, zone: string): number {
  return daysBetween(localDate(now, zone), localDate(startAt, zone))
}

/** `Plate`, `Plate and Base`, `Plate, Base and Field`. */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** `today`, `1 day out`, `3 days out`. */
export function daysOutText(days: number): string {
  return days === 0 ? 'today' : days === 1 ? '1 day out' : `${days} days out`
}

/** `1 game still needs umpires`, `2 games still need umpires`. */
export function digestTitle(count: number): string {
  return count === 1
    ? '1 game still needs umpires'
    : `${count} games still need umpires`
}

/** One game the digest lists. */
export interface DigestGame {
  id: string
  home: string
  away: string
  startAt: Date
  seasonName: string
  /**
   * The game's own zone (`games.timezone`), which it is dated and counted in,
   * as the umpire schedule the notice opens dates it.
   */
  zone: string
  venue: string
  field: string
  /** The names of its empty required positions, in the requirement's order. */
  open: string[]
  daysOut: number
}

/**
 * `Demo Hawks vs Demo Eagles · Mar 2, 4:00 pm · Fall Minors · Field 1 —
 * Plate and Base (3 days out)`.
 */
export function digestLine(game: DigestGame): string {
  const place = [game.venue.trim(), game.field.trim()]
    .filter(part => part !== '')
    .join(', ')
  const head = [
    `${game.home} vs ${game.away}`,
    umpireDate(game.startAt.toISOString(), game.zone),
    game.seasonName,
    ...(place === '' ? [] : [place])
  ].join(' · ')
  return `${head} — ${joinWords(game.open)} (${daysOutText(game.daysOut)})`
}

/** `Demo Hawks vs Demo Eagles, Mar 2 4:00 pm`. */
function gameWords(game: {
  home: string
  away: string
  startAt: Date
  zone: string
}): string {
  return `${game.home} vs ${game.away}, ${umpireDate(game.startAt.toISOString(), game.zone).replace(',', '')}`
}

/** "Jordan Ray signed up as Plate for Demo Hawks vs Demo Eagles, Mar 2 4:00 pm". */
export function signUpText(
  umpire: string,
  position: string,
  game: { home: string; away: string; startAt: Date; zone: string }
): string {
  return `${umpire} signed up as ${position} for ${gameWords(game)}`
}

/** "Jordan Ray withdrew from Plate for Demo Hawks vs Demo Eagles, Mar 2 4:00 pm". */
export function withdrawText(
  umpire: string,
  position: string,
  game: { home: string; away: string; startAt: Date; zone: string }
): string {
  return `${umpire} withdrew from ${position} for ${gameWords(game)}`
}

/**
 * What a sign-up or withdrawal notice keeps: the umpire by id, never their
 * name, so each reader names them as they are when they read it (a deleted
 * account as "Deleted user", a rename by its new name, in full only for a
 * reader who may read it in full); the slot as it was named; and the game.
 */
export interface SlotNoticeMetadata {
  description: ''
  leagueId: string
  gameId: string
  umpireId: string
  slotName: string
  home: string
  away: string
  /** ISO. */
  startAt: string
  zone: string
}

/** A sign-up or withdrawal notice's words, naming the umpire `umpire`. */
export function slotNoticeText(
  kind: string,
  umpire: string,
  metadata: SlotNoticeMetadata
): string {
  const game = { ...metadata, startAt: new Date(metadata.startAt) }
  return kind === UMPIRE_SIGN_UP
    ? signUpText(umpire, metadata.slotName, game)
    : withdrawText(umpire, metadata.slotName, game)
}

/** Whether a notice is a sign-up or a withdrawal, named when it is read. */
export function isSlotNotice(kind: string): boolean {
  return kind === UMPIRE_SIGN_UP || kind === UMPIRE_WITHDRAW
}

/** Where a notice opens: the league's umpire schedule, on its game. */
export function noticeUrl(leagueId: string, gameId: string): string {
  return `teamstation://umpires/${encodeURIComponent(leagueId)}?view=league&game=${encodeURIComponent(gameId)}`
}

/**
 * The games of a league the digest lists for a window of `daysBefore`
 * calendar days at `now`, by start: not withdrawn, cancelled or final, not
 * started, of a season with an umpire requirement, from today to
 * `daysBefore` days out in the game's own zone, and with a required position
 * nobody holds. Optional positions never count.
 */
export async function digestGames(
  db: Kysely<Database>,
  leagueId: string,
  daysBefore: number,
  now: Date
): Promise<DigestGame[]> {
  // A day's slack either side of the zones; each game is counted in its own.
  const until = new Date(now.getTime() + (daysBefore + 2) * 86_400_000)
  const games = await db
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .innerJoin('season_umpire_requirements as r', 'r.season_id', 'seasons.id')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .leftJoin('venue_fields as f', 'f.id', 'games.field_id')
    .select([
      'games.id as id',
      'games.start_at as startAt',
      'games.venue as venue',
      'f.name as field',
      sql<string>`coalesce(home.name, ${OPEN_SIDE_NAME})`.as('home'),
      sql<string>`coalesce(away.name, ${OPEN_SIDE_NAME})`.as('away'),
      'seasons.id as seasonId',
      'seasons.name as seasonName',
      'games.timezone as zone'
    ])
    .where('seasons.league_id', '=', leagueId)
    .where('games.withdrawn_at', 'is', null)
    .where('games.status', 'not in', ['cancelled', 'final'])
    .where('games.start_at', '>', now)
    .where('games.start_at', '<', until)
    .orderBy('games.start_at')
    .orderBy('games.id')
    .execute()
  if (games.length === 0) return []
  const catalog = await types(db, leagueId)
  const counts = await db
    .selectFrom('season_umpire_type_requirements')
    .selectAll()
    .where('season_id', 'in', [...new Set(games.map(g => g.seasonId))])
    .execute()
  const held = await db
    .selectFrom('umpire_assignments')
    .select(['game_id', 'slot'])
    .where(
      'game_id',
      'in',
      games.map(g => g.id)
    )
    .execute()
  const filled = new Set(held.map(a => `${a.game_id}|${a.slot}`))
  const listed: DigestGame[] = []
  for (const game of games) {
    const startAt = new Date(game.startAt)
    const days = daysOut(now, startAt, game.zone)
    if (days < 0 || days > daysBefore) continue
    const positions = umpirePositions(
      catalog,
      counts
        .filter(c => c.season_id === game.seasonId)
        .map(c => ({
          typeId: c.type_id,
          required: c.required_count,
          optional: c.optional_count
        }))
    )
    const open = positions.filter(
      p => p.required && !filled.has(`${game.id}|${p.slot}`)
    )
    if (open.length === 0) continue
    listed.push({
      id: game.id,
      home: game.home,
      away: game.away,
      startAt,
      seasonName: game.seasonName,
      zone: game.zone,
      venue: game.venue ?? '',
      field: game.field ?? '',
      open: open.map(p => umpirePositionName(p, positions)),
      daysOut: days
    })
  }
  return listed
}

/** One league's name, for a notice's push title. */
async function leagueName(
  db: Kysely<Database>,
  leagueId: string
): Promise<string> {
  const row = await db
    .selectFrom('leagues')
    .select('name')
    .where('id', '=', leagueId)
    .executeTakeFirst()
  return row?.name ?? 'League management'
}

/** What a sign-up or withdrawal notice says of its game and slot. */
export interface SlotNotice {
  leagueId: string
  gameId: string
  slot: string
  /** Whose assignment it is: the umpire, never their guardian. */
  umpireId: string
  /** Who acted, each of their ids: they are never told of it. */
  actorIds: readonly string[]
}

/**
 * A slot's name as the schedule and the digest give it (`Base 2` beside a
 * `Base 1`); its type's bare name once the season no longer lists it, else
 * `Umpire`.
 */
async function slotName(
  db: Kysely<Database>,
  leagueId: string,
  seasonId: string | null,
  slot: string
): Promise<string> {
  const catalog = await types(db, leagueId)
  const counts =
    seasonId == null
      ? []
      : await db
          .selectFrom('season_umpire_type_requirements')
          .select(['type_id', 'required_count', 'optional_count'])
          .where('season_id', '=', seasonId)
          .execute()
  const positions = umpirePositions(
    catalog,
    counts.map(c => ({
      typeId: c.type_id,
      required: c.required_count,
      optional: c.optional_count
    }))
  )
  const position = positions.find(p => p.slot === slot)
  if (position != null) return umpirePositionName(position, positions)
  const typeId = slot.split(':')[0]
  return catalog.find(type => type.id === typeId)?.name ?? 'Umpire'
}

async function recordSlotNotice(
  db: Kysely<Database>,
  notice: SlotNotice,
  kind: typeof UMPIRE_SIGN_UP | typeof UMPIRE_WITHDRAW
): Promise<LeagueNoticePush[]> {
  const recipients = (
    await noticeRecipients(
      db,
      notice.leagueId,
      kind === UMPIRE_SIGN_UP ? 'sign_ups' : 'withdrawals',
      notice.actorIds
    )
  ).map(recipient => recipient.userId)
  if (recipients.length === 0) return []
  const game = await db
    .selectFrom('games')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.start_at as startAt',
      sql<string>`coalesce(home.name, ${OPEN_SIDE_NAME})`.as('home'),
      sql<string>`coalesce(away.name, ${OPEN_SIDE_NAME})`.as('away'),
      'games.timezone as zone',
      'games.season_id as seasonId'
    ])
    .where('games.id', '=', notice.gameId)
    .executeTakeFirstOrThrow()
  const umpireId = (await onePerson(db, notice.umpireId)).userId
  const metadata: SlotNoticeMetadata = {
    description: '',
    leagueId: notice.leagueId,
    gameId: notice.gameId,
    umpireId,
    slotName: await slotName(db, notice.leagueId, game.seasonId, notice.slot),
    home: game.home,
    away: game.away,
    startAt: new Date(game.startAt).toISOString(),
    zone: game.zone
  }
  const id = makeId('audit')
  await db
    .insertInto('notification_events')
    .values({
      id,
      source_type: kind,
      source_id: id,
      revision: 1,
      actor_id: notice.actorIds[0] ?? null,
      // Ids, not words: the umpire is named when the inbox is read.
      metadata,
      recorded_recipients: recipients,
      created_at: new Date()
    })
    .execute()
  // A push is gone once sent, so it names the umpire as each recipient reads
  // them now: one push for each way they are named.
  const readers = await db
    .selectFrom('users')
    .select(['id', 'is_admin'])
    .where('id', 'in', recipients)
    .execute()
  const byName = new Map<string, string[]>()
  for (const reader of readers) {
    const name =
      (
        await shortNamesOf(db, [umpireId], {
          reader: { userId: reader.id, isAdmin: reader.is_admin }
        })
      ).get(umpireId) ?? ''
    byName.set(name, [...(byName.get(name) ?? []), reader.id])
  }
  const title = await leagueName(db, notice.leagueId)
  return [...byName].map(([name, users]) => ({
    t: 'league',
    u: users.sort(),
    title,
    body: slotNoticeText(kind, name, metadata),
    url: noticeUrl(notice.leagueId, notice.gameId),
    tag: `event:league:${id}`
  }))
}

/**
 * Records that an umpire signed up for a slot, for the admins with sign-ups
 * on, in the write's own transaction. Answers the pushes to queue once it
 * commits, one for each way its recipients name the umpire, and none when
 * nobody is told.
 */
export async function recordSignUp(
  trx: Kysely<Database>,
  notice: SlotNotice
): Promise<LeagueNoticePush[]> {
  return await recordSlotNotice(trx, notice, UMPIRE_SIGN_UP)
}

/** `recordSignUp` for an umpire's (or their guardian's) own withdrawal. */
export async function recordWithdrawal(
  trx: Kysely<Database>,
  notice: SlotNotice
): Promise<LeagueNoticePush[]> {
  return await recordSlotNotice(trx, notice, UMPIRE_WITHDRAW)
}

/**
 * Dismisses, for `userId`, each of their digests for a league (`sourceId`)
 * that they have not dismissed, from before the day `revision` or, with
 * none, every one, so it leaves Pending for History. Nothing is written for
 * an account deleted, disabled or merged into another: its receipts went
 * with it, and are not put back.
 */
async function settleDigests(
  db: Kysely<Database>,
  sourceId: string,
  userId: string,
  revision: number | null,
  now: Date
): Promise<void> {
  let query = db
    .selectFrom('notification_events as e')
    .leftJoin('notification_receipts as r', join =>
      join.onRef('r.event_id', '=', 'e.id').on('r.user_id', '=', userId)
    )
    .select('e.id')
    .where('e.source_type', '=', UMPIRE_MISSING_SLOTS)
    .where('e.source_id', '=', sourceId)
    .where('r.dismissed_at', 'is', null)
    .where(eb =>
      eb.exists(
        eb
          .selectFrom('users as u')
          .select('u.id')
          .where('u.id', '=', userId)
          .where('u.deleted_at', 'is', null)
          .where('u.disabled_at', 'is', null)
          .where('u.merged_into', 'is', null)
      )
    )
  if (revision != null) query = query.where('e.revision', '<', revision)
  const earlier = await query.execute()
  if (earlier.length === 0) return
  await db
    .insertInto('notification_receipts')
    .values(
      earlier.map(event => ({
        event_id: event.id,
        user_id: userId,
        viewed_at: now,
        dismissed_at: now
      }))
    )
    .onConflict(oc =>
      oc.columns(['event_id', 'user_id']).doUpdateSet({
        dismissed_at: sql<Date>`coalesce(notification_receipts.dismissed_at, excluded.dismissed_at)`
      })
    )
    .execute()
}

/**
 * Records the day's digest for every admin it is due to at `now`: in each
 * league that manages umpires and whose local time is 10:00 or later, each
 * admin with missing slots on whose window holds a game still missing a
 * required umpire. One a day for each admin and league, whoever runs it:
 * only a row this call inserted is pushed, and it settles that admin's
 * earlier digests for the league, so Pending holds the latest. A due day
 * with no game to list records and pushes nothing, and settles every digest
 * of theirs for the league, today's included, so Pending never keeps a
 * digest of games since filled. Once today's is settled (dismissed, filled,
 * or missing slots turned off) nothing more is done for that admin and
 * league that day, so turning missing slots back on takes effect from the
 * next day's digest.
 *
 * Each digest's push goes to `sweep.push` as soon as its row is in, so a
 * league that fails later in the pass loses none of the pushes before it.
 * Each league is its own try: a failure is said to `sweep.log`, with the
 * league, and the pass goes on to the next. Answers every push it handed on.
 */
export async function recordUmpireDigests(
  db: Kysely<Database>,
  now: Date = new Date(),
  sweep: DigestSweep = {}
): Promise<LeagueNoticePush[]> {
  const log =
    sweep.log ??
    ((line: string) => {
      console.error(line)
    })
  // Every undismissed digest of an account still open, read once a pass.
  const open = await openDigests(db)
  const leagues = await db
    .selectFrom('leagues')
    .select(['id', 'name', 'locality'])
    .where('umpire_management', '=', true)
    .where(eb =>
      eb.exists(
        eb
          .selectFrom('league_umpire_notifications as n')
          .select('n.user_id')
          .whereRef('n.league_id', '=', 'leagues.id')
          .where('n.missing_slots', '=', true)
      )
    )
    .orderBy('id')
    .execute()
  const pushes: LeagueNoticePush[] = []
  const push = async (request: LeagueNoticePush): Promise<void> => {
    pushes.push(request)
    await sweep.push?.(request)
  }
  // Who gets a digest in each league due at `now`, for `settleUnqualified`.
  const qualified = new Map<string, Set<string>>()
  for (const league of leagues) {
    const zone = leagueZone(league.locality)
    if (!digestDue(now, zone)) continue
    try {
      await recordLeagueDigests(db, now, zone, league, open, qualified, push)
    } catch (error) {
      log(`recording umpire digests for league ${league.id}: ${String(error)}`)
    }
  }
  await settleUnqualified(db, now, open, qualified, log)
  return pushes
}

/** What a digest sweep is told: where each push goes, and where a failure. */
export interface DigestSweep {
  /** Told each push as soon as its digest is recorded. */
  push?: (request: LeagueNoticePush) => Promise<void> | void
  /** Told each league's failure; the console's, by default. */
  log?: (line: string) => void
}

/**
 * One league's part of `recordUmpireDigests`, at a time it is due: each
 * qualified admin's digest recorded and handed to `push`, or settled.
 */
async function recordLeagueDigests(
  db: Kysely<Database>,
  now: Date,
  zone: string,
  league: { id: string; name: string },
  open: ReadonlySet<string>,
  qualified: Map<string, Set<string>>,
  push: (request: LeagueNoticePush) => Promise<void>
): Promise<void> {
  const day = localDate(now, zone)
  const revision = Number(day.replaceAll('-', ''))
  const recipients = await noticeRecipients(db, league.id, 'missing_slots')
  qualified.set(league.id, new Set(recipients.map(r => r.userId)))
  if (recipients.length === 0) return
  // Today's digests already recorded, and whether each is settled.
  const today = new Map(
    (
      await db
        .selectFrom('notification_events as e')
        .select(eb => [
          'e.source_id',
          eb
            .exists(
              eb
                .selectFrom('notification_receipts as r')
                .select('r.event_id')
                .whereRef('r.event_id', '=', 'e.id')
                .where('r.dismissed_at', 'is not', null)
            )
            .as('settled')
        ])
        .where('e.source_type', '=', UMPIRE_MISSING_SLOTS)
        .where('e.revision', '=', revision)
        .where(
          'e.source_id',
          'in',
          recipients.map(r => digestSource(league.id, r.userId))
        )
        .execute()
    ).map(row => [row.source_id, row.settled])
  )
  const byWindow = new Map<number, DigestGame[]>()
  for (const { userId, daysBefore } of recipients) {
    const sourceId = digestSource(league.id, userId)
    // Settled today: nothing more until tomorrow's.
    if (today.get(sourceId) === true) continue
    let games = byWindow.get(daysBefore)
    if (games == null) {
      games = await digestGames(db, league.id, daysBefore, now)
      byWindow.set(daysBefore, games)
    }
    if (games.length === 0) {
      // Nothing is left to list: every digest, today's too, leaves Pending.
      if (today.has(sourceId) || open.has(sourceId))
        await settleDigests(db, sourceId, userId, null, now)
      continue
    }
    // Today's is recorded and still lists a game.
    if (today.has(sourceId)) continue
    const title = digestTitle(games.length)
    const made = await db
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        source_type: UMPIRE_MISSING_SLOTS,
        source_id: sourceId,
        revision,
        actor_id: null,
        metadata: {
          title,
          description: games.map(digestLine).join('\n'),
          leagueId: league.id,
          gameId: games[0].id
        },
        recorded_recipients: [userId],
        created_at: now
      })
      .onConflict(oc =>
        oc.columns(['source_type', 'source_id', 'revision']).doNothing()
      )
      .returning('id')
      .executeTakeFirst()
    if (made == null) continue
    // Its push is handed on before anything else can fail: a later sweep
    // finds the row and never pushes it again.
    await push({
      t: 'league',
      u: [userId],
      title: league.name,
      body: title,
      url: noticeUrl(league.id, games[0].id),
      tag: `event:league:${made.id}`
    })
    // The day before's, and any older, leave Pending.
    if (open.has(sourceId))
      await settleDigests(db, sourceId, userId, revision, now)
  }
}

/**
 * The `source_id` of every digest nobody has dismissed whose admin's account
 * is not deleted, disabled or merged away. Those of a closed account are
 * left out: their receipts went with it, so they are never settled, and are
 * not read again.
 */
export async function openDigests(db: Kysely<Database>): Promise<Set<string>> {
  const rows = await db
    .selectFrom('notification_events as e')
    .innerJoin('users as u', join =>
      join.on(eb =>
        eb('u.id', '=', sql<string>`split_part(e.source_id, ':', 2)`)
      )
    )
    .select('e.source_id')
    .distinct()
    .where('e.source_type', '=', UMPIRE_MISSING_SLOTS)
    .where('u.deleted_at', 'is', null)
    .where('u.disabled_at', 'is', null)
    .where('u.merged_into', 'is', null)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('notification_receipts as r')
            .select('r.event_id')
            .whereRef('r.event_id', '=', 'e.id')
            .where('r.dismissed_at', 'is not', null)
        )
      )
    )
    .orderBy('e.source_id')
    .execute()
  return new Set(rows.map(row => row.source_id))
}

/**
 * Settles every undismissed digest whose admin no longer gets one in its
 * league: missing slots off, the league not managing umpires, or no longer
 * its admin. Each is settled once its league's digest is due that day, and
 * nothing is recorded or pushed. `qualified` is who gets one in each league
 * the pass already found due, which is not read again. `open` is the pass's
 * `openDigests`, so an account deleted, disabled or merged away is not in
 * it and is left alone: its receipts went with it. Each league is its own
 * try, said to `log` with the league, so one that fails settles the rest.
 */
async function settleUnqualified(
  db: Kysely<Database>,
  now: Date,
  open: ReadonlySet<string>,
  qualified: ReadonlyMap<string, ReadonlySet<string>>,
  log: (line: string) => void
): Promise<void> {
  const byLeague = new Map<string, string[]>()
  for (const sourceId of open) {
    const at = sourceId.lastIndexOf(':')
    if (at < 0) continue
    const leagueId = sourceId.slice(0, at)
    const users = byLeague.get(leagueId) ?? []
    users.push(sourceId.slice(at + 1))
    byLeague.set(leagueId, users)
  }
  if (byLeague.size === 0) return
  for (const [leagueId, users] of byLeague) {
    try {
      let qualify = qualified.get(leagueId)
      if (qualify == null) {
        const league = await db
          .selectFrom('leagues')
          .select('locality')
          .where('id', '=', leagueId)
          .executeTakeFirst()
        if (!digestDue(now, leagueZone(league?.locality))) continue
        qualify = new Set(
          (await noticeRecipients(db, leagueId, 'missing_slots')).map(
            r => r.userId
          )
        )
      }
      for (const userId of users) {
        if (qualify.has(userId)) continue
        await settleDigests(
          db,
          digestSource(leagueId, userId),
          userId,
          null,
          now
        )
      }
    } catch (error) {
      log(`settling umpire digests for league ${leagueId}: ${String(error)}`)
    }
  }
}

/** How often the umpire digests are looked at: each is due from 10:00 local. */
export const UMPIRE_DIGEST_INTERVAL_MS = 10 * 60 * 1000

/**
 * One sweep: records the digests due at `now` (`recordUmpireDigests`) and
 * queues each one's push as soon as its digest is recorded, so a failure
 * later in the sweep keeps every push before it. A failure is said, not
 * thrown, and the next sweep tries again. Answers how many pushes were
 * queued.
 */
export async function queueUmpireDigests(
  db: Kysely<Database>,
  now: Date,
  queue: Pick<PushEnqueuer, 'add'>,
  log: (line: string) => void,
  record: typeof recordUmpireDigests = recordUmpireDigests
): Promise<number> {
  let queued = 0
  try {
    await record(db, now, {
      push: async request => {
        try {
          if (await queue.add(request)) queued++
        } catch (error) {
          log(`queueing ${request.tag}: ${String(error)}`)
        }
      },
      log
    })
  } catch (error) {
    log(`recording umpire digests: ${String(error)}`)
  }
  return queued
}

/**
 * Records each league admin's daily missing-umpires digest once it is due
 * and asks the push sender to push it: once Valkey is first there on the way
 * up, and then every ten minutes, so a node that was down at 10:00 records
 * the day's on its first sweep. A digest is recorded once a day whoever
 * sweeps, and only the sweep that recorded it queues its push. Answers how
 * to stop: the timer, and the sweep's own queue client.
 */
export function startUmpireDigests(
  db: Kysely<Database>,
  queue: Pick<PushEnqueuer, 'add' | 'whenReady' | 'close'>,
  log: (line: string) => void,
  record: typeof recordUmpireDigests = recordUmpireDigests
): Stoppable {
  const sweep = skipWhileRunning(async () => {
    await queueUmpireDigests(db, new Date(), queue, log, record)
  })
  queue.whenReady(sweep)
  const timer = setInterval(sweep, UMPIRE_DIGEST_INTERVAL_MS)
  // Node's timer, which the app's typecheck reads as the browser's number.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return {
    stop: async () => {
      clearInterval(timer)
      await queue.close()
    }
  }
}
