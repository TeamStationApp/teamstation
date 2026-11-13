import { type Kysely, type Selectable, sql } from 'kysely'

import { eventName } from '../../common/eventInfo'
import type { EventReminder } from '../../common/push'
import { onePeople } from '../admin/people'
import { anyOf } from '../db/anyOf'
import type { Database, PushRemindersSentTable } from '../db/database'
import { outsideSpoken } from '../users/readerNames'
import type { NewPushRequest, ReminderPushRequest } from './requests'
import {
  emptyReport,
  type PushAddress,
  type PushLog,
  type PushMessage,
  type PushReport,
  type PushTransports,
  sendPush
} from './send'

/** How long before its start an event is reminded of. */
export const REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000

/** Staff who may answer for themselves, as `eventInfo.ts` lets them. */
const ANSWERING_STAFF = ['admin', 'coach', 'assistant'] as const

type EventKind = PushRemindersSentTable['event_kind']

/** A scheduled event starting within the window. */
interface DueEvent {
  kind: EventKind
  id: string
  startAt: Date
  timezone: string
  /** The teams taking part: a game's home side first. */
  teamIds: string[]
  /** A team event's name, as the app lists it; null for a game. */
  title: string | null
}

/** One person's reminder, before it is put in their own words. */
interface Due {
  /** Whether they answered yes themselves. */
  own: boolean
  /** The yes players they are a guardian of. */
  children: string[]
  /** Whose side names a game: theirs, or their first child's. */
  teamId: string
}

type GameRow = Pick<
  Selectable<Database['games']>,
  'id' | 'start_at' | 'timezone' | 'home_team_id' | 'away_team_id'
>
type TeamEventRow = Pick<
  Selectable<Database['team_events']>,
  'id' | 'start_at' | 'timezone' | 'team_id' | 'title' | 'event_type'
>

function gameEvent(game: GameRow): DueEvent {
  return {
    kind: 'game',
    id: game.id,
    startAt: game.start_at,
    timezone: game.timezone,
    teamIds: [game.home_team_id, game.away_team_id],
    title: null
  }
}

function teamEvent(event: TeamEventRow): DueEvent {
  return {
    kind: 'teamEvent',
    id: event.id,
    startAt: event.start_at,
    timezone: event.timezone,
    teamIds: [event.team_id],
    title:
      eventName({
        eventKind: 'event',
        eventType: event.event_type,
        title: event.title
      }) ?? null
  }
}

/**
 * Each start of a game or team event still scheduled in `(now, now + 2h]`,
 * as the request (`requests.ts`) the push sender reminds of it from. The
 * primary queues them every five minutes: whoever has been reminded already
 * stays reminded, so a start queued again costs a read and sends nothing.
 */
export async function dueReminders(
  db: Kysely<Database>,
  now: Date
): Promise<Array<Omit<ReminderPushRequest, 'v' | 'attempt'>>> {
  const until = new Date(now.getTime() + REMINDER_WINDOW_MS)
  const due = async (
    table: 'games' | 'team_events'
  ): Promise<Array<{ id: string; start_at: Date }>> =>
    await db
      .selectFrom(table)
      .select(['id', 'start_at'])
      .where('status', '=', 'scheduled')
      .where('start_at', '>', now)
      .where('start_at', '<=', until)
      .orderBy('id')
      .execute()
  const [games, events] = await Promise.all([due('games'), due('team_events')])
  return [
    ...games.map(game => ({ kind: 'game' as const, row: game })),
    ...events.map(event => ({ kind: 'teamEvent' as const, row: event }))
  ].map(({ kind, row }) => ({
    t: 'reminder',
    kind,
    eventId: row.id,
    startAt: row.start_at.toISOString()
  }))
}

/**
 * How long a reminder is kept written down after its event's start: well
 * past the window it is read in, which ends at the start.
 */
export const REMINDERS_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Forgets the reminders of event starts more than `REMINDERS_KEPT_MS` before
 * `now`, which nothing reads again; answers how many.
 */
export async function pruneReminders(
  db: Kysely<Database>,
  now: Date
): Promise<number> {
  const pruned = await db
    .deleteFrom('push_reminders_sent')
    .where('start_at', '<', new Date(now.getTime() - REMINDERS_KEPT_MS))
    .executeTakeFirst()
  return Number(pruned.numDeletedRows)
}

/**
 * The primary's sweep: queues a request for each event start due
 * (`dueReminders`) through `queue`, and answers how many, then forgets the
 * reminders of long-past starts (`pruneReminders`). A failure to read them
 * or to forget is said in `log`, and the next sweep tries again.
 */
export async function queueReminders(
  db: Kysely<Database>,
  now: Date,
  queue: { add: (request: NewPushRequest) => Promise<unknown> },
  log: (line: string) => void
): Promise<number> {
  let queued = 0
  try {
    const due = await dueReminders(db, now)
    for (const request of due) await queue.add(request)
    queued = due.length
  } catch (error) {
    log(`queueing RSVP reminders: ${String(error)}`)
  }
  await pruneReminders(db, now).catch((error: unknown) => {
    log(`forgetting past RSVP reminders: ${String(error)}`)
  })
  return queued
}

/**
 * The event a reminder request is for, while it is still scheduled to start
 * then and has not started by `now`; otherwise null, and nobody is owed it.
 */
async function eventOf(
  db: Kysely<Database>,
  request: Pick<ReminderPushRequest, 'kind' | 'eventId' | 'startAt'>,
  now: Date
): Promise<DueEvent | null> {
  const event =
    request.kind === 'game'
      ? await db
          .selectFrom('games')
          .select([
            'id',
            'start_at',
            'timezone',
            'home_team_id',
            'away_team_id',
            'status'
          ])
          .where('id', '=', request.eventId)
          .executeTakeFirst()
          .then(row => (row == null ? null : { row, due: gameEvent(row) }))
      : await db
          .selectFrom('team_events')
          .select([
            'id',
            'start_at',
            'timezone',
            'team_id',
            'title',
            'event_type',
            'status'
          ])
          .where('id', '=', request.eventId)
          .executeTakeFirst()
          .then(row => (row == null ? null : { row, due: teamEvent(row) }))
  if (
    event?.row.status !== 'scheduled' ||
    event.row.start_at.getTime() !== Date.parse(request.startAt) ||
    event.row.start_at.getTime() <= now.getTime()
  )
    return null
  return event.due
}

/** Of these rows, the open ones still able to sign in or be answered for. */
async function activeOf(
  db: Kysely<Database>,
  ids: readonly string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  return new Set(
    (
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', anyOf(ids))
        .where('disabled_at', 'is', null)
        .where('merged_into', 'is', null)
        .execute()
    ).map(row => row.id)
  )
}

/**
 * Who hears of `event`, and why. A yes counts only from somebody who may
 * still answer for themselves (`ownIds` in `eventInfo.ts`): a current member
 * of either team, players among them, or its staff, each read as the row they
 * are now and not disabled. A counted player's guardians hear of it too.
 */
async function dueFor(
  db: Kysely<Database>,
  event: DueEvent
): Promise<Map<string, Due>> {
  const [members, staff] = await Promise.all([
    db
      .selectFrom('memberships')
      .select(['user_id', 'team_id', 'is_player'])
      .where('team_id', '=', anyOf(event.teamIds))
      .execute(),
    db
      .selectFrom('scope_roles')
      .select(['user_id', 'scope_id as team_id'])
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', anyOf(event.teamIds))
      .where('role', 'in', [...ANSWERING_STAFF])
      .execute()
  ])
  const people = await onePeople(db, [
    ...members.map(row => row.user_id),
    ...staff.map(row => row.user_id)
  ])
  /** Each person's rows, by the row they are now. */
  const rowsOf = new Map<string, string[]>()
  for (const person of people.values())
    rowsOf.set(person.userId, person.userIds)
  /** Each person who may answer, and their teams here. */
  const answering = new Map<string, { teams: string[]; player: boolean }>()
  for (const row of [
    ...members,
    ...staff.map(member => ({ ...member, is_player: false }))
  ]) {
    const id = people.get(row.user_id)!.userId
    const entry = answering.get(id) ?? { teams: [], player: false }
    if (!entry.teams.includes(row.team_id)) entry.teams.push(row.team_id)
    entry.player ||= row.is_player
    answering.set(id, entry)
  }
  const active = await activeOf(db, [...answering.keys()])
  for (const id of answering.keys()) if (!active.has(id)) answering.delete(id)
  const aliases = new Map<string, string>()
  for (const id of answering.keys())
    for (const alias of rowsOf.get(id)!) aliases.set(alias, id)
  const due = new Map<string, Due>()
  if (aliases.size === 0) return due
  const replies = await db
    .selectFrom(event.kind === 'game' ? 'game_rsvps' : 'team_event_rsvps')
    .select(['user_id', 'response'])
    .where('event_id', '=', event.id)
    .where('user_id', '=', anyOf([...aliases.keys()]))
    .orderBy('updated_at', 'desc')
    .orderBy('user_id')
    .execute()
  // A merged person's latest answer, whichever row it was given on.
  const answered = new Set<string>()
  const yes: string[] = []
  for (const reply of replies) {
    const id = aliases.get(reply.user_id)!
    if (answered.has(id)) continue
    answered.add(id)
    if (reply.response === 'yes') yes.push(id)
  }
  const sideOf = (id: string): string =>
    event.teamIds.find(team => answering.get(id)!.teams.includes(team))!
  for (const id of yes)
    due.set(id, { own: true, children: [], teamId: sideOf(id) })
  const yesPlayers = yes.filter(id => answering.get(id)!.player)
  const playerAliases = yesPlayers.flatMap(id => rowsOf.get(id)!)
  if (playerAliases.length === 0) return due
  const links = await db
    .selectFrom('user_links')
    .select(['user_id', 'related_user_id'])
    .where('kind', '=', 'guardian')
    .where('related_user_id', '=', anyOf(playerAliases))
    .orderBy('related_user_id')
    .execute()
  const guardians = await onePeople(
    db,
    links.map(link => link.user_id)
  )
  const activeGuardians = await activeOf(
    db,
    [...guardians.values()].map(person => person.userId)
  )
  for (const link of links) {
    const guardian = guardians.get(link.user_id)!.userId
    if (!activeGuardians.has(guardian)) continue
    const child = aliases.get(link.related_user_id)!
    const entry = due.get(guardian) ?? {
      own: false,
      children: [],
      teamId: sideOf(child)
    }
    if (!entry.children.includes(child)) entry.children.push(child)
    due.set(guardian, entry)
  }
  return due
}

/**
 * Whether nobody can be owed a reminder of this event start, read in one
 * query before the whole `dueFor` is. Everybody who could be (whoever
 * answered yes on any row, and the guardians of any row of theirs), each
 * read as the open row they are now, must be one `dueFor` never reminds, or
 * one it has nothing left to remind: a row closed in a loop, which has no
 * open row, is never counted settled.
 *
 * - Not owed: their account is disabled, or they may not answer for the
 *   event (no row of theirs is a member or answering staff of its teams)
 *   and are no candidate's guardian.
 * - Nothing left: they were reminded of this start, or have "Notify for
 *   RSVPed events" off.
 *
 * A new yes, a new guardian, a switch turned on, a new place on the team or
 * a reminder given back (`release`) makes it false, and the event is worked
 * out in full. It may say false when `dueFor` would find nobody owed (a
 * guardian of a yes that does not count), never true when it would find
 * somebody.
 */
async function settled(
  db: Kysely<Database>,
  event: DueEvent
): Promise<boolean> {
  const replies = sql.table(
    event.kind === 'game' ? 'game_rsvps' : 'team_event_rsvps'
  )
  const teams = sql.join(event.teamIds)
  const staff = sql.join([...ANSWERING_STAFF])
  const { rows } = await sql<{ settled: boolean }>`
    with recursive
    yes as (
      select distinct user_id as id from ${replies}
        where event_id = ${event.id} and response = 'yes'
    ),
    -- Each yes row, and each row it was closed into, to the open one.
    yes_up (at) as (
      select id from yes
      union
      select u.merged_into from yes_up y join users u on u.id = y.at
        where u.merged_into is not null
    ),
    -- Every row of each person who said yes: their open row, and every row
    -- closed into it, which is where dueFor reads guardians from.
    rows_of as (
      select at as id from yes_up
      union
      select u.id from users u join rows_of r on u.merged_into = r.id
    ),
    guardians as (
      select distinct user_id as id from user_links
        where kind = 'guardian' and related_user_id in (select id from rows_of)
    ),
    candidates as (
      select id from yes
      union
      select id from guardians
    ),
    -- Each candidate, and each row it was closed into, to the open one.
    up (id, at) as (
      select id, id from candidates
      union
      select up.id, u.merged_into from up join users u on u.id = up.at
        where u.merged_into is not null
    ),
    open_of as (
      select up.id, up.at as open from up join users u on u.id = up.at
        where u.merged_into is null
    ),
    -- Each open row, and every row closed into it.
    down (open, id) as (
      select open, open from open_of
      union
      select d.open, u.id from down d join users u on u.merged_into = d.id
    ),
    owed as (
      select distinct o.open as id from open_of o
        join users u on u.id = o.open
        where u.disabled_at is null
          and (
            o.open in (
              select g.open from open_of g where g.id in (select id from guardians)
            )
            or exists (
              select 1 from down d join memberships m on m.user_id = d.id
                where d.open = o.open and m.team_id in (${teams})
            )
            or exists (
              select 1 from down d join scope_roles r on r.user_id = d.id
                where d.open = o.open and r.scope_type = 'team'
                  and r.scope_id in (${teams}) and r.role in (${staff})
            )
          )
    )
    select
      not exists (
        select 1 from candidates c where c.id not in (select id from open_of)
      )
      and not exists (
        select 1 from owed o
          where not exists (
            select 1 from push_reminders_sent s
              where s.event_kind = ${event.kind}
                and s.event_id = ${event.id}
                and s.start_at = ${event.startAt}
                and s.user_id = o.id
          )
          and exists (
            select 1 from user_notification_settings n
              where n.user_id = o.id and n.rsvp_events
          )
      ) as settled
  `.execute(db)
  return rows[0].settled
}

/** Of these people, those with "Notify for RSVPed events" on. */
async function listening(
  db: Kysely<Database>,
  ids: readonly string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  return new Set(
    (
      await db
        .selectFrom('user_notification_settings')
        .select('user_id')
        .where('user_id', '=', anyOf(ids))
        .where('rsvp_events', '=', true)
        .execute()
    ).map(row => row.user_id)
  )
}

/** Of these people, those not yet reminded of this event start. */
async function unreminded(
  db: Kysely<Database>,
  event: DueEvent,
  ids: readonly string[]
): Promise<string[]> {
  if (ids.length === 0) return []
  const reminded = new Set(
    (
      await db
        .selectFrom('push_reminders_sent')
        .select('user_id')
        .where('event_kind', '=', event.kind)
        .where('event_id', '=', event.id)
        .where('start_at', '=', event.startAt)
        .where('user_id', '=', anyOf(ids))
        .execute()
    ).map(row => row.user_id)
  )
  return ids.filter(id => !reminded.has(id))
}

/**
 * Writes down a reminder for each of these people, and answers those it was
 * written for now: one already sent, from this node or another, stays sent.
 */
async function claim(
  db: Kysely<Database>,
  event: DueEvent,
  ids: readonly string[]
): Promise<string[]> {
  if (ids.length === 0) return []
  return (
    await db
      .insertInto('push_reminders_sent')
      .values(
        ids.map(id => ({
          event_kind: event.kind,
          event_id: event.id,
          user_id: id,
          start_at: event.startAt
        }))
      )
      .onConflict(oc => oc.doNothing())
      .returning('user_id')
      .execute()
  ).map(row => row.user_id)
}

/**
 * Takes back the reminders of these people, whom only failures kept it from
 * (`PushReport.unreached`), so that the next sweep tries them again.
 */
async function release(
  db: Kysely<Database>,
  event: DueEvent,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return
  await db
    .deleteFrom('push_reminders_sent')
    .where('event_kind', '=', event.kind)
    .where('event_id', '=', event.id)
    .where('start_at', '=', event.startAt)
    .where('user_id', '=', anyOf(ids))
    .execute()
}

/** "5:30 PM", where the event is. */
export function startTime(startAt: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(startAt)
}

/** Each claimed person's reminder, in their own words. */
async function remindersFor(
  db: Kysely<Database>,
  event: DueEvent,
  due: Map<string, Due>,
  ids: readonly string[]
): Promise<Map<string, EventReminder>> {
  const teams = new Map(
    (
      await db
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', '=', anyOf(event.teamIds))
        .execute()
    ).map(team => [team.id, team.name])
  )
  // A guardian reads their child's full name (`mayViewFullNames`), so the
  // first name is theirs to read.
  const guarded = [...new Set(ids.flatMap(id => due.get(id)!.children))]
  const calledBy = new Map(
    guarded.length === 0
      ? []
      : (
          await db
            .selectFrom('users')
            .select(['id', 'first_name', 'display_name'])
            .where('id', '=', anyOf(guarded))
            .execute()
        ).map(row => [
          row.id,
          row.first_name != null && row.first_name.trim() !== ''
            ? row.first_name
            : row.display_name
        ])
  )
  const starts = `Starts at ${startTime(event.startAt, event.timezone)}`
  const reminders = new Map<string, EventReminder>()
  for (const id of ids) {
    const { own, children, teamId } = due.get(id)!
    const title =
      event.kind === 'game'
        ? `${teams.get(teamId)} vs ${teams.get(event.teamIds[event.teamIds[0] === teamId ? 1 : 0])}`
        : event.title!
    const names = children.map(child => calledBy.get(child)!)
    if (own && names.length > 0) names.unshift('You')
    const body = names.length === 0 ? starts : `${names.join(', ')} · ${starts}`
    reminders.set(id, {
      t: 'event',
      u: id,
      title,
      body,
      url: `teamstation://games/${event.id}`,
      tag: `event:${event.id}`
    })
  }
  return reminders
}

/**
 * A reminder in each platform's shape, kept no longer than the event's
 * start: an alert on iOS, high-priority data on Android in the `payload`
 * field a chat wake uses, and a web push.
 */
export function reminderMessage(
  to: PushAddress,
  reminder: EventReminder,
  startAt: Date,
  now: Date
): PushMessage {
  const ttlSeconds = Math.max(
    0,
    Math.floor((startAt.getTime() - now.getTime()) / 1000)
  )
  const text = JSON.stringify(reminder)
  switch (to.platform) {
    case 'ios':
      return {
        platform: 'ios',
        pushType: 'alert',
        priority: 10,
        expiration: Math.floor(startAt.getTime() / 1000),
        payload: {
          aps: {
            alert: { title: reminder.title, body: reminder.body },
            sound: 'default',
            'thread-id': reminder.tag
          },
          ...reminder
        }
      }
    case 'android':
      return {
        platform: 'android',
        priority: 'high',
        ttlSeconds,
        data: { payload: text }
      }
    case 'web':
      return { platform: 'web', payload: text, urgency: 'high', ttlSeconds }
  }
}

export interface ReminderOutcome extends PushReport {
  /**
   * Reminders written down for this event start, one a person, less those
   * taken back because only failures kept them from that person.
   */
  reminded: number
}

/**
 * The push sender's work for a reminder request: reminds of this event start
 * whoever said yes to it, and the guardians of the players among them, each
 * once however often it is asked. A cancelled or moved event, one already
 * started, and anybody with "Notify for RSVPed events" off hear nothing.
 *
 * Each reminder is written down before it is sent. Those of people only
 * failures kept it from (`unreached`) are taken back, so a later try, or the
 * next sweep's request, reminds them; a failure to work out who is owed it
 * throws, having written nothing down.
 *
 * A sender killed outright between writing reminders down and the send's
 * end (SIGKILL, out of memory, or a stop past its grace) loses them: they
 * stay written down, and the request taken over sends nothing. That is
 * accepted. Taking them back first would remind twice whoever the send had
 * already reached, and a reminder is one notification about one event,
 * which the app shows anyway.
 */
export async function remindOf(
  db: Kysely<Database>,
  request: Pick<ReminderPushRequest, 'kind' | 'eventId' | 'startAt'>,
  now: Date,
  transports: PushTransports,
  log?: PushLog
): Promise<ReminderOutcome> {
  const outcome: ReminderOutcome = { ...emptyReport(), reminded: 0 }
  // Names here go to other people, whoever made the request.
  return await outsideSpoken(async () => {
    const event = await eventOf(db, request, now)
    if (event == null || (await settled(db, event))) return outcome
    const due = await dueFor(db, event)
    const on = await listening(db, [...due.keys()])
    const owed = await unreminded(
      db,
      event,
      [...due.keys()].filter(id => on.has(id))
    )
    if (owed.length === 0) return outcome
    const reminders = await remindersFor(db, event, due, owed)
    const claimed = await claim(db, event, owed)
    if (claimed.length === 0) return outcome
    const report = await sendPush(
      db,
      claimed,
      to => reminderMessage(to, reminders.get(to.userId)!, event.startAt, now),
      transports,
      log
    )
    await release(db, event, report.unreached)
    return {
      ...report,
      reminded: claimed.length - report.unreached.length
    }
  })
}
