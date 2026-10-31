import { type Kysely, type RawBuilder, type Selectable, sql } from 'kysely'

import { forbidden, notFound } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import {
  isSchedulingNews,
  type Notification,
  type PlayerAddTerms,
  RECORDING_UPLOAD
} from '../../common/notifications'
import type { Role } from '../../common/roles'
import { adminScopes, guardedRows, roleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database, NotificationEventsTable } from '../db/database'
import {
  mayAnswerPlayerAdd,
  rejoinedSince,
  supersededPlayerAdd
} from '../groups/noticePolicy'
import {
  approvesSide,
  type Clock,
  realClock,
  requestStatus,
  speaksForSender,
  type StoredRequest
} from '../groups/requests'
import { canScheduleFor, currentActor } from '../groups/rights'
import { heldAt } from '../invites/grants'
import { shortNamesOf, userNames } from '../users/nameBook'
import {
  grantInformation,
  type PlayerRemovedMetadata,
  playerRemovedWords,
  titleAndDescription
} from './requestInformation'

/**
 * A row as the inbox works with it: the notification, and whether it is
 * news (Pending, and the bell) on top of whatever its fields say. The flag
 * travels with the row, and leaves it before it is sent.
 */
type Listed = Notification & { news: boolean }

/** The notification as it is sent: without the inbox's own flag. */
function sent({ news: _news, ...row }: Listed): Notification {
  return row
}

/** The words a page of notices reads of other rows, read once for the page. */
interface PageNames {
  /** The live name of each user a notice names: actors and senders. */
  people: ReadonlyMap<string, string>
  /** Each group a grant names, by `kind:id` (`groupNames`). */
  groups: ReadonlyMap<string, string>
  /** The short name of each player a removal notice names, by user id. */
  players: ReadonlyMap<string, string>
}

/** A notice of information, worded for this person. */
async function informationFor(
  db: Kysely<Database>,
  actor: Actor,
  event: Selectable<NotificationEventsTable>,
  names: PageNames
): Promise<Listed | null> {
  if (
    event.source_type === 'groupRequest' ||
    !event.recorded_recipients.includes(actor.userId)
  )
    return null
  const receipt = await db
    .selectFrom('notification_receipts')
    .select(['event_id', 'dismissed_at'])
    .where('event_id', '=', event.id)
    .where('user_id', '=', actor.userId)
    .executeTakeFirst()
  const metadata = event.metadata as {
    title?: string
    description?: string
    scope?: GroupRef
    roles?: Role[]
    claimKind?: 'claim' | 'request'
    leagueName?: string
    gameId?: string
    liveStreamId?: string
    venueId?: string
    leagueId?: string
    seasonId?: string
    teamId?: string
  }
  let title = metadata.title ?? 'Organization update'
  let description = metadata.description ?? ''
  // A grant offers to leave the level it gave, for as long as they are in it.
  let leave: Notification['leave'] = null
  if (event.source_type === 'grant' && metadata.scope != null) {
    const group =
      names.groups.get(`${metadata.scope.kind}:${metadata.scope.id}`) ??
      'Unavailable group'
    // Who gave it, and where, are named as they are now.
    const said = grantInformation(
      actorName(names.people, event.actor_id),
      group,
      metadata.roles ?? []
    )
    title = said.title
    description = said.description
    const held = await heldAt(db, metadata.scope, actor.userId)
    if (held.member || held.roles.length > 0)
      leave = { ...metadata.scope, name: group }
  }
  // A claim a person decided names them as they are now.
  if (
    event.source_type === 'venueClaimDecided' &&
    metadata.description == null &&
    metadata.claimKind != null &&
    metadata.leagueName != null
  )
    description = `${actorName(names.people, event.actor_id)} decided ${metadata.leagueName}'s ${metadata.claimKind}.`
  // A player taken off a roster is named as they are now.
  if (event.source_type === PLAYER_ADD_REJECTED) {
    const removed = event.metadata as PlayerRemovedMetadata
    const said = playerRemovedWords(
      removed,
      names.players.get(removed.userId) ?? ''
    )
    title = said.title
    description = said.description
  }
  // A reminder waits on its owner until they dismiss it or the upload lands,
  // which settles it the same way.
  const reminder = event.source_type === RECORDING_UPLOAD
  const waiting = reminder && receipt?.dismissed_at == null
  // A player taken off a roster by their side is news to its managers until
  // they dismiss it; there is nothing to do but read it.
  const removal =
    event.source_type === PLAYER_ADD_REJECTED && receipt?.dismissed_at == null
  const row: Listed = {
    // A removal waits until dismissed, with nothing to do but read it.
    news: removal,
    id: event.id,
    requestId: event.id,
    type: event.source_type,
    title,
    description,
    sentAt: event.created_at.toISOString(),
    expiresAt: event.created_at.toISOString(),
    status: waiting ? 'pending' : 'accepted',
    canAct: waiting,
    canWithdraw: false,
    canResend: false,
    canReject: false,
    rejectUntil: null,
    viewed: receipt != null,
    leave,
    ...(reminder
      ? { gameId: metadata.gameId, liveStreamId: metadata.liveStreamId }
      : {}),
    ...(isSchedulingNews(event.source_type)
      ? Object.fromEntries(
          (['gameId', 'venueId', 'leagueId', 'seasonId', 'teamId'] as const)
            .filter(key => metadata[key] != null)
            .map(key => [key, metadata[key]])
        )
      : {})
  }
  return row
}

/**
 * What a page of notices names, in one read of `users` and one of each kind
 * of group: the actor of every grant and of every claim a person decided,
 * the sender of every request, and the group of every grant; and in one more
 * read of `users`, the player of every removal notice.
 */
async function pageNames(
  db: Kysely<Database>,
  events: ReadonlyArray<Selectable<NotificationEventsTable>>,
  requests: readonly StoredRequest[] = []
): Promise<PageNames> {
  const people = await userNames(db, [
    ...events
      .filter(
        event =>
          event.source_type === 'grant' ||
          event.source_type === 'venueClaimDecided'
      )
      .flatMap(event => (event.actor_id == null ? [] : [event.actor_id])),
    ...requests.map(request => request.sender_id)
  ])
  const scopes = events.flatMap(event => {
    const scope = (event.metadata as { scope?: GroupRef } | null)?.scope
    return event.source_type === 'grant' && scope != null ? [scope] : []
  })
  const players = await shortNamesOf(
    db,
    events.flatMap(event =>
      event.source_type === PLAYER_ADD_REJECTED
        ? [(event.metadata as PlayerRemovedMetadata).userId]
        : []
    )
  )
  return { people, groups: await groupNames(db, scopes), players }
}

/**
 * Each group's name, by `kind:id`, in one query for each kind named; a group
 * that is gone is not in it.
 */
async function groupNames(
  db: Kysely<Database>,
  refs: readonly GroupRef[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const [kind, table] of [
    ['league', 'leagues'],
    ['season', 'seasons'],
    ['team', 'teams']
  ] as const) {
    const ids = [
      ...new Set(refs.filter(ref => ref.kind === kind).map(ref => ref.id))
    ]
    if (ids.length === 0) continue
    const rows = await db
      .selectFrom(table)
      .select(['id', 'name'])
      .where('id', 'in', ids)
      .execute()
    for (const row of rows) names.set(`${kind}:${row.id}`, row.name)
  }
  return names
}

/** The live name of whoever a notice is from, or "An admin" for nobody. */
function actorName(
  actors: ReadonlyMap<string, string>,
  actorId: string | null
): string {
  const name = actorId == null ? undefined : actors.get(actorId)
  return name == null || name === '' ? 'An admin' : name
}

/** A reminder still waiting: Pending lists these before anything else. */
function rankOf(row: Notification): number {
  return row.type === RECORDING_UPLOAD && row.status === 'pending' ? 0 : 1
}

/** Pending reminders first, then oldest first, then by id. */
function compareRows(
  a: { rank: number; sentAt: string; requestId: string },
  b: { rank: number; sentAt: string; requestId: string }
): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.sentAt !== b.sentAt) return a.sentAt < b.sentAt ? -1 : 1
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0
}

/**
 * Whether a notification waits on this person: a request they can answer, or
 * an upload reminder they have not dismissed. These are Pending, and light
 * the bell. A grant or a scheduling notice is accepted when it is recorded,
 * so it is History from the start.
 */
function isNews(row: Listed): boolean {
  return row.canAct || row.news
}

/** The notice a team's roster managers get when a player's side rejected an add. */
export const PLAYER_ADD_REJECTED = 'playerAddRejected'

/**
 * A request as this person's notification, or null when it is not theirs.
 * `senders` holds the senders' live names a page read at once.
 */
export async function notificationFor(
  db: Kysely<Database>,
  actor: Actor,
  request: StoredRequest,
  clock: Clock = realClock,
  senders?: ReadonlyMap<string, string>
): Promise<Listed | null> {
  const fresh = await currentActor(db, actor)
  const sides = await db
    .selectFrom('group_request_sides')
    .selectAll()
    .where('request_id', '=', request.id)
    .execute()
  let eligible = false
  let actionable = false
  let representedConsent = false
  // A player add answers to the player's side as it is now.
  if (request.kind === 'playerAdd') {
    eligible = await mayAnswerPlayerAdd(db, fresh, request)
    actionable = eligible
  }
  for (const side of request.kind === 'playerAdd' ? [] : sides) {
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
          .select(['event_id', 'dismissed_at'])
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
      news: false,
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
      canReject: false,
      rejectUntil: null,
      viewed: receipt != null,
      leave: null
    }
  const historical =
    status !== 'pending' &&
    (request.sender_id === fresh.userId ||
      event?.recorded_recipients.includes(fresh.userId) === true ||
      receipt != null)
  if (!eligible && !senderAdmin && !historical) return null
  const display = await titleAndDescription(db, request, senders)
  // A change already made, which its approver may reject for 90 days, until
  // a later add of the same person replaces it.
  const notice = request.kind === 'playerAdd' && status === 'applied'
  const canReject =
    notice &&
    eligible &&
    request.expires_at.getTime() > clock.now().getTime() &&
    !(await supersededPlayerAdd(db, request)) &&
    !(await rejoinedSince(db, request.terms as PlayerAddTerms))
  const row: Listed = {
    // An applied add its approver may still reject, until they dismiss it:
    // news like a request waiting on them, without anything to accept.
    news: canReject && receipt?.dismissed_at == null,
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
      status !== 'accepted' &&
      senderAdmin &&
      request.kind !== 'guardian' &&
      request.kind !== 'membership' &&
      // A player add is made or asked once; a refused one is asked again by
      // adding the player again.
      request.kind !== 'playerAdd',
    viewed: receipt != null,
    leave: null,
    // Every item carries both, as the published shape has them.
    canReject,
    rejectUntil: notice ? request.expires_at.toISOString() : null
  }
  return row
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

/**
 * Every row of those who play on these teams, closed ones too: a player add
 * names the row it was made with, and a merge since leaves it there.
 */
function rowsOfPlayers(teamIds: string[]): RawBuilder<string> {
  return sql<string>`(
    with recursive chain(id) as (
      select memberships.user_id
      from memberships
      inner join teams on teams.id = memberships.team_id
      where memberships.team_id in (${sql.join(teamIds)})
        and memberships.is_player = true
        and teams.merged_into is null
      union
      select users.id
      from chain
      inner join users on users.merged_into = chain.id
    )
    select chain.id::text from chain
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
    const ownRows = (await onePerson(db, fresh.userId)).userIds
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
              ]),
              // A guardian added since a player add was made answers it too.
              eb.and([
                eb('kind', '=', 'playerAdd'),
                eb(sql<string>`terms->>'userId'`, 'in', guarded.map(String))
              ])
            ]),
        // So does whoever `playerAddApprovers` names now: the player once no
        // guardian can act, and the coaches of the teams they play on.
        eb.and([
          eb('kind', '=', 'playerAdd'),
          eb('status', 'in', ['pending', 'applied']),
          eb(sql<string>`terms->>'userId'`, 'in', ownRows.map(String))
        ]),
        ...(teamIds.length === 0
          ? []
          : [
              eb.and([
                eb('kind', '=', 'playerAdd'),
                eb('status', 'in', ['pending', 'applied']),
                eb(sql<string>`terms->>'userId'`, 'in', rowsOfPlayers(teamIds))
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
  // History lists every piece of information; the other tabs read only
  // undismissed upload reminders, which wait in Pending and light the bell.
  // Grants and scheduling notices are History from the moment they are
  // recorded.
  const information = await db
    .selectFrom('notification_events')
    .selectAll()
    .where('source_type', '!=', 'groupRequest')
    .$if(options.history !== true, query =>
      query.where(eb =>
        eb.and([
          eb('source_type', 'in', [RECORDING_UPLOAD, PLAYER_ADD_REJECTED]),
          eb.not(
            eb.exists(
              eb
                .selectFrom('notification_receipts')
                .select('notification_receipts.event_id')
                .whereRef(
                  'notification_receipts.event_id',
                  '=',
                  'notification_events.id'
                )
                .where('notification_receipts.user_id', '=', fresh.userId)
                .where('notification_receipts.dismissed_at', 'is not', null)
            )
          )
        ])
      )
    )
    .where(eb =>
      eb(eb.val(fresh.userId), '=', eb.fn.any('recorded_recipients'))
    )
    .execute()
  const names = await pageNames(db, information, found)
  const projected: Listed[] = []
  for (const request of found) {
    const row = await notificationFor(db, fresh, request, clock, names.people)
    if (row != null) projected.push(row)
  }
  for (const event of information) {
    const row = await informationFor(db, fresh, event, names)
    if (row != null) projected.push(row)
  }
  projected.sort((a, b) =>
    compareRows(
      { rank: rankOf(a), sentAt: a.sentAt, requestId: a.requestId },
      { rank: rankOf(b), sentAt: b.sentAt, requestId: b.requestId }
    )
  )
  const hasPending = projected.some(isNews)
  let visible = projected.filter(row =>
    options.history === true
      ? row.status !== 'pending' && !isNews(row)
      : options.sent === true
        ? row.canWithdraw
        : isNews(row)
  )
  if (options.cursor != null) {
    // The last row of the page before, rank and all, so a page that ended
    // among the reminders carries on there even when that reminder has been
    // dismissed since. A cursor without a rank is from before reminders were
    // listed first, when every row was of the second rank.
    const parts = options.cursor.split('|')
    const [rankText, time, id] = parts.length === 2 ? ['1', ...parts] : parts
    if (
      (rankText !== '0' && rankText !== '1') ||
      !Number.isFinite(Date.parse(time)) ||
      id == null ||
      parts.length > 3
    )
      throw forbidden('Invalid notification cursor')
    const at = { rank: Number(rankText), sentAt: time, requestId: id }
    visible = visible.filter(
      row =>
        compareRows(
          { rank: rankOf(row), sentAt: row.sentAt, requestId: row.requestId },
          at
        ) > 0
    )
  }
  const limit = Math.max(1, Math.min(100, options.limit ?? 25))
  const page = visible.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(sent),
    hasPending,
    nextCursor:
      visible.length > limit && last != null
        ? `${rankOf(last)}|${last.sentAt}|${last.requestId}`
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
    const information = await informationFor(
      db,
      fresh,
      event,
      await pageNames(db, [event])
    )
    if (information == null) throw notFound()
    return sent(information)
  }
  const row = await notificationFor(db, actor, request, clock)
  if (row == null) throw notFound()
  return sent(row)
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

/**
 * Dismisses a notification for this person: Pending lets it go, and History
 * keeps it. A reminder nobody opened has no receipt yet, so this makes one.
 */
export async function dismissNotification(
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
  const now = clock.now()
  await db
    .insertInto('notification_receipts')
    .values({
      event_id: event.id,
      user_id: actor.userId,
      viewed_at: now,
      dismissed_at: now
    })
    .onConflict(oc =>
      oc
        .columns(['event_id', 'user_id'])
        .doUpdateSet({ viewed_at: now, dismissed_at: now })
    )
    .execute()
}
