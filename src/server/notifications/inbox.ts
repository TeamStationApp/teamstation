import { type Kysely, type RawBuilder, type Selectable, sql } from 'kysely'

import { forbidden, notFound } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import type { Notification } from '../../common/notifications'
import { adminScopes, guardedRows, roleScopes } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database, NotificationEventsTable } from '../db/database'
import {
  approvesSide,
  type Clock,
  realClock,
  requestStatus,
  speaksForSender,
  type StoredRequest
} from '../groups/requests'
import { canScheduleFor, currentActor } from '../groups/rights'
import { groupName, heldAt } from '../invites/grants'
import { titleAndDescription } from './requestInformation'

async function informationFor(
  db: Kysely<Database>,
  actor: Actor,
  event: Selectable<NotificationEventsTable>
): Promise<Notification | null> {
  if (
    event.source_type === 'groupRequest' ||
    !event.recorded_recipients.map(Number).includes(actor.userId)
  )
    return null
  const receipt = await db
    .selectFrom('notification_receipts')
    .select('event_id')
    .where('event_id', '=', event.id)
    .where('user_id', '=', actor.userId)
    .executeTakeFirst()
  const metadata = event.metadata as {
    title?: string
    description?: string
    scope?: GroupRef
  }
  // A grant offers to leave the level it gave, for as long as they are in it.
  let leave: Notification['leave'] = null
  if (event.source_type === 'grant' && metadata.scope != null) {
    const held = await heldAt(db, metadata.scope, actor.userId)
    if (held.member || held.roles.length > 0)
      leave = { ...metadata.scope, name: await groupName(db, metadata.scope) }
  }
  return {
    id: event.id,
    requestId: event.id,
    type: event.source_type,
    title: metadata.title ?? 'Organization update',
    description: metadata.description ?? '',
    sentAt: event.created_at.toISOString(),
    expiresAt: event.created_at.toISOString(),
    status: 'accepted',
    canAct: false,
    canWithdraw: false,
    canResend: false,
    viewed: receipt != null,
    leave
  }
}

/**
 * Whether a notification is new news: one waiting for this person's answer,
 * or a grant they have not opened yet, which lights the bell until they do.
 */
function isNews(row: Notification): boolean {
  return row.canAct || (row.type === 'grant' && !row.viewed)
}

export async function notificationFor(
  db: Kysely<Database>,
  actor: Actor,
  request: StoredRequest,
  clock: Clock = realClock
): Promise<Notification | null> {
  const fresh = await currentActor(db, actor)
  const sides = await db
    .selectFrom('group_request_sides')
    .selectAll()
    .where('request_id', '=', request.id)
    .execute()
  let eligible = false
  let actionable = false
  let representedConsent = false
  for (const side of sides) {
    const sideRef = { kind: side.scope_type, id: side.scope_id }
    if (!(await approvesSide(db, fresh, sideRef, request))) continue
    eligible = true
    if (
      side.scope_type === 'team' &&
      side.approved_by != null &&
      (request.kind === 'game' || request.kind === 'gameChange') &&
      (await canScheduleFor(db, fresh, { kind: 'team', id: side.scope_id }))
    )
      representedConsent = true
    let valid = false
    if (side.approved_by != null) {
      try {
        valid = await approvesSide(
          db,
          { userId: side.approved_by, isAdmin: false, scopes: [] },
          sideRef,
          request
        )
      } catch {}
    }
    if (!valid) actionable = true
  }
  const senderAdmin = await speaksForSender(db, fresh, request)
  const event = await db
    .selectFrom('notification_events')
    .select(['id', 'recorded_recipients'])
    .where('source_type', '=', 'groupRequest')
    .where('source_id', '=', request.id)
    .executeTakeFirst()
  const receipt =
    event == null
      ? null
      : await db
          .selectFrom('notification_receipts')
          .select('event_id')
          .where('event_id', '=', event.id)
          .where('user_id', '=', fresh.userId)
          .executeTakeFirst()
  const status = requestStatus(request, clock)
  if (
    status === 'pending' &&
    !eligible &&
    !senderAdmin &&
    request.sender_id === fresh.userId
  )
    return {
      id: event?.id ?? request.id,
      requestId: request.id,
      type: request.kind,
      title: 'Pending invitation you sent',
      description:
        'You no longer administer the sending group. You may withdraw this invitation, but need current administrator authority to resend it or make decisions.',
      sentAt: request.sent_at.toISOString(),
      expiresAt: request.expires_at.toISOString(),
      status,
      canAct: false,
      canWithdraw: true,
      canResend: false,
      viewed: receipt != null,
      leave: null
    }
  const historical =
    status !== 'pending' &&
    (request.sender_id === fresh.userId ||
      event?.recorded_recipients.map(Number).includes(fresh.userId) === true ||
      receipt != null)
  if (!eligible && !senderAdmin && !historical) return null
  const display = await titleAndDescription(db, request)
  return {
    id: event?.id ?? request.id,
    requestId: request.id,
    type: request.kind,
    ...display,
    sentAt: request.sent_at.toISOString(),
    expiresAt: request.expires_at.toISOString(),
    status,
    canAct: status === 'pending' && actionable,
    canWithdraw:
      status === 'pending' &&
      (senderAdmin || request.sender_id === fresh.userId || representedConsent),
    canResend:
      status !== 'accepted' && senderAdmin && request.kind !== 'guardian',
    viewed: receipt != null,
    leave: null
  }
}

/**
 * The teams whose players' guardian requests this person may answer, while
 * those players have no guardian: every team they administer, coach or
 * assist. Whether a player has one is read per request, by `approvesSide`.
 */
async function coachedTeams(
  db: Kysely<Database>,
  actor: Actor,
  administered: GroupRef[]
): Promise<string[]> {
  const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
  return [
    ...new Set([
      ...scopes.coach.teamIds,
      ...scopes.assistant.teamIds,
      ...administered.filter(ref => ref.kind === 'team').map(ref => ref.id)
    ])
  ]
}

/**
 * The players of these teams as a guardian request's terms name them: every
 * row playing on one, and the open row each became, as text. A query, not a
 * list, so a league's worth of players never leaves the database.
 */
function playersOf(teamIds: string[]): RawBuilder<string> {
  return sql<string>`(
    with recursive chain(id, first) as (
      select memberships.user_id, true
      from memberships
      inner join teams on teams.id = memberships.team_id
      where memberships.team_id in (${sql.join(teamIds)})
        and memberships.is_player = true
        and teams.merged_into is null
      union
      select users.merged_into, false
      from chain
      inner join users on users.id = chain.id
      where users.merged_into is not null
    )
    select chain.id::text
    from chain
    inner join users on users.id = chain.id
    where chain.first or users.merged_into is null
  )`
}

/** SQL selects candidate requests; live side checks govern disclosure and the pending dot. */
export async function inbox(
  db: Kysely<Database>,
  actor: Actor,
  options: {
    history?: boolean
    sent?: boolean
    cursor?: string
    limit?: number
  } = {},
  clock: Clock = realClock
): Promise<{
  items: Notification[]
  hasPending: boolean
  nextCursor: string | null
}> {
  const fresh = await currentActor(db, actor)
  const scopes = await adminScopes(db, fresh.userId, fresh.isAdmin)
  const refs: GroupRef[] = [
    ...[...scopes.leagueIds].map(id => ({ kind: 'league' as const, id })),
    ...[...scopes.seasonIds].map(id => ({ kind: 'season' as const, id })),
    ...[...scopes.teamIds].map(id => ({ kind: 'team' as const, id }))
  ]
  const external = await db
    .selectFrom('teams')
    .select(['id', 'custodian_type', 'custodian_id'])
    .where('kind', '=', 'external')
    .execute()
  for (const team of external)
    if (
      team.custodian_type != null &&
      team.custodian_id != null &&
      refs.some(
        ref => ref.kind === team.custodian_type && ref.id === team.custodian_id
      )
    )
      refs.push({ kind: 'team', id: team.id })
  let rows = db.selectFrom('group_requests').selectAll()
  if (!scopes.isAdmin) {
    // A guardian request asks the player's side: so the player's guardians,
    // and while there are none its coaching staff.
    const teamIds = await coachedTeams(db, fresh, refs)
    const guarded = await guardedRows(db, fresh.userId)
    const emails = await db
      .selectFrom('user_emails')
      .select('email')
      .where('user_id', '=', fresh.userId)
      .where('verified_at', 'is not', null)
      .execute()
    const candidateSides = db
      .selectFrom('group_request_sides')
      .select('request_id')
      .where(eb =>
        eb.or([
          eb.and([
            eb('scope_type', '=', 'user'),
            eb('scope_id', 'in', [
              String(fresh.userId),
              ...emails.map(row => `email:${row.email.toLowerCase()}`)
            ])
          ]),
          ...refs.map(ref =>
            eb.and([
              eb('scope_type', '=', ref.kind),
              eb('scope_id', '=', ref.id)
            ])
          )
        ])
      )
    const schedulingSides = db
      .selectFrom('group_request_sides')
      .select('request_id')
      .where('scope_type', '=', 'team')
      .where('scope_id', 'in', teamIds.length === 0 ? [''] : teamIds)
    const historyIds = db
      .selectFrom('notification_events')
      .select('source_id')
      .where('source_type', '=', 'groupRequest')
      .where(eb =>
        eb(eb.val(fresh.userId), '=', eb.fn.any('recorded_recipients'))
      )
    const viewedIds = db
      .selectFrom('notification_events')
      .innerJoin(
        'notification_receipts',
        'notification_receipts.event_id',
        'notification_events.id'
      )
      .select('source_id')
      .where('source_type', '=', 'groupRequest')
      .where('notification_receipts.user_id', '=', fresh.userId)
    rows = rows.where(eb =>
      eb.or([
        eb('id', 'in', candidateSides),
        eb.and([
          eb('kind', 'in', ['game', 'gameChange']),
          eb('id', 'in', schedulingSides)
        ]),
        ...(scopes.seasonIds.size === 0
          ? []
          : [
              eb.and([
                eb('kind', '=', 'game'),
                eb(sql<string>`terms->'game'->>'seasonId'`, 'in', [
                  ...scopes.seasonIds
                ])
              ])
            ]),
        eb('id', 'in', historyIds),
        eb('id', 'in', viewedIds),
        eb('sender_id', '=', fresh.userId),
        ...(guarded.length === 0
          ? []
          : [
              eb.and([
                eb('kind', '=', 'guardian'),
                eb(
                  sql<string>`terms->>'playerUserId'`,
                  'in',
                  guarded.map(String)
                )
              ])
            ]),
        ...(teamIds.length === 0
          ? []
          : [
              eb.and([
                eb('kind', '=', 'guardian'),
                eb(
                  sql<string>`terms->>'playerUserId'`,
                  'in',
                  playersOf(teamIds)
                )
              ])
            ]),
        ...teamIds.map(id =>
          eb.and([
            eb('kind', 'in', ['game', 'gameChange']),
            eb('sender_scope_type', '=', 'team'),
            eb('sender_scope_id', '=', id)
          ])
        ),
        ...refs.map(ref =>
          eb.and([
            eb('sender_scope_type', '=', ref.kind),
            eb('sender_scope_id', '=', ref.id)
          ])
        )
      ])
    )
  }
  const found = await rows.orderBy('sent_at', 'asc').orderBy('id').execute()
  const projected: Notification[] = []
  for (const request of found) {
    const row = await notificationFor(db, fresh, request, clock)
    if (row != null) projected.push(row)
  }
  // History lists every piece of information; the other tabs read grants,
  // which are news until opened, and light the bell.
  const information = await db
    .selectFrom('notification_events')
    .selectAll()
    .where('source_type', '!=', 'groupRequest')
    .$if(options.history !== true, query =>
      query.where('source_type', '=', 'grant')
    )
    .where(eb =>
      eb(eb.val(fresh.userId), '=', eb.fn.any('recorded_recipients'))
    )
    .execute()
  for (const event of information) {
    const row = await informationFor(db, fresh, event)
    if (row != null) projected.push(row)
  }
  projected.sort((a, b) =>
    a.sentAt === b.sentAt
      ? a.requestId < b.requestId
        ? -1
        : a.requestId > b.requestId
          ? 1
          : 0
      : a.sentAt < b.sentAt
        ? -1
        : 1
  )
  const hasPending = projected.some(isNews)
  let visible = projected.filter(row =>
    options.history === true
      ? row.status !== 'pending'
      : options.sent === true
        ? row.canWithdraw
        : isNews(row)
  )
  if (options.cursor != null) {
    const [time, id] = options.cursor.split('|')
    if (!Number.isFinite(Date.parse(time)) || id == null)
      throw forbidden('Invalid notification cursor')
    visible = visible.filter(
      row => row.sentAt > time || (row.sentAt === time && row.requestId > id)
    )
  }
  const limit = Math.max(1, Math.min(100, options.limit ?? 25))
  const page = visible.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page,
    hasPending,
    nextCursor:
      visible.length > limit && last != null
        ? `${last.sentAt}|${last.requestId}`
        : null
  }
}

export async function notificationDetail(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  clock: Clock = realClock
): Promise<Notification> {
  const request = await db
    .selectFrom('group_requests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (request == null) {
    const fresh = await currentActor(db, actor)
    const event = await db
      .selectFrom('notification_events')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (event == null) throw notFound()
    const information = await informationFor(db, fresh, event)
    if (information == null) throw notFound()
    return information
  }
  const row = await notificationFor(db, actor, request, clock)
  if (row == null) throw notFound()
  return row
}

export async function markViewed(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  clock: Clock = realClock
): Promise<void> {
  const detail = await notificationDetail(db, actor, id, clock)
  const event = await db
    .selectFrom('notification_events')
    .select('id')
    .where('id', '=', detail.id)
    .executeTakeFirst()
  if (event == null) throw notFound()
  await db
    .insertInto('notification_receipts')
    .values({ event_id: event.id, user_id: actor.userId })
    .onConflict(oc =>
      oc
        .columns(['event_id', 'user_id'])
        .doUpdateSet({ viewed_at: clock.now() })
    )
    .execute()
}
