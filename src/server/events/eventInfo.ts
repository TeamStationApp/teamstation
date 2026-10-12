import { createHash } from 'node:crypto'

import type { Kysely, Selectable } from 'kysely'

import { asGameDetail, type GameDetail } from '../../common/api'
import { conflict, forbidden, notFound } from '../../common/errors'
import {
  asEventLocationFields,
  eventDate,
  type EventInfo,
  eventText,
  type Rsvp,
  sortedAttendees,
  type TeamEventInput
} from '../../common/eventInfo'
import { asGameTimezone } from '../../common/gameApprovals'
import { isRecord } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import { shortName } from '../../common/names'
import { canSeeGame, canSeeTeam, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, TeamEventsTable, UsersTable } from '../db/database'
import { canAdminister, currentActor } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import type { ScheduleRow } from '../routes/seasons'
import { mayScheduleIn, scheduleRights } from '../schedule/scheduleGames'

type ResolvedEvent = Omit<EventInfo, 'attendees' | 'replyUserIds'> & {
  teamIds: string[]
  seasonId: string | null
}
const iso = (date: Date | null): string | null => date?.toISOString() ?? null

export async function resolveEvent(
  db: Kysely<Database>,
  actor: Actor,
  id: string
): Promise<ResolvedEvent> {
  const fresh = await currentActor(db, actor)
  const scopes = await visibleScopes(db, fresh.userId, fresh.isAdmin)
  const event = await db
    .selectFrom('team_events')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (event != null) {
    if (!canSeeTeam(scopes, event.team_id)) throw notFound()
    const team = await db
      .selectFrom('teams')
      .select('name')
      .where('id', '=', event.team_id)
      .executeTakeFirstOrThrow()
    return {
      id,
      eventKind: 'event',
      title: event.title,
      teamId: event.team_id,
      teamIds: [event.team_id],
      seasonId: null,
      teamName: team.name,
      startAt: event.start_at.toISOString(),
      endAt: iso(event.end_at),
      timezone: event.timezone,
      venue: event.venue,
      address: event.address,
      latitude: event.latitude,
      longitude: event.longitude,
      status: event.status,
      canManage: await canAdminister(db, fresh, {
        kind: 'team',
        id: event.team_id
      })
    }
  }
  const game = await db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (
    game == null ||
    !canSeeGame(scopes, {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      seasonId: game.season_id
    })
  )
    throw notFound()
  const rights = await scheduleRights(db, fresh.userId, fresh.isAdmin)
  const team = await db
    .selectFrom('teams')
    .select('name')
    .where('id', '=', game.home_team_id)
    .executeTakeFirstOrThrow()
  return {
    id,
    eventKind: 'game',
    title: null,
    teamId: game.home_team_id,
    teamIds: [game.home_team_id, game.away_team_id],
    seasonId: game.season_id,
    teamName: team.name,
    startAt: game.start_at.toISOString(),
    endAt: iso(game.end_at),
    timezone: game.timezone,
    venue: game.venue,
    address: game.address,
    latitude: game.latitude,
    longitude: game.longitude,
    status: game.status,
    canManage:
      mayScheduleIn(rights, game.home_team_id, game.season_id) ||
      mayScheduleIn(rights, game.away_team_id, game.season_id)
  }
}

/** Roster rows exist until removed. Guardian links grant attendance rights. */
async function eventPeople(
  db: Kysely<Database>,
  event: ResolvedEvent,
  actor: Actor
): Promise<{
  users: Array<
    Pick<
      Selectable<UsersTable>,
      'id' | 'display_name' | 'avatar_path' | 'is_admin'
    >
  >
  replies: Array<{ user_id: number; response: Rsvp }>
  replyUserIds: number[]
}> {
  const members = await db
    .selectFrom('memberships')
    .select(['user_id', 'is_player'])
    .where('team_id', 'in', event.teamIds)
    .execute()
  const staff = await db
    .selectFrom('scope_roles')
    .select('user_id')
    .where('scope_type', '=', 'team')
    .where('scope_id', 'in', event.teamIds)
    .execute()
  const players = [
    ...new Set(members.filter(row => row.is_player).map(row => row.user_id))
  ]
  const guardians =
    players.length === 0
      ? []
      : await db
          .selectFrom('user_links')
          .select(['user_id', 'related_user_id'])
          .where('kind', '=', 'guardian')
          .where('related_user_id', 'in', players)
          .execute()
  const parent = await onePerson(db, actor.userId)
  const ownLinks = await db
    .selectFrom('user_links')
    .select('related_user_id')
    .where('kind', '=', 'guardian')
    .where('user_id', 'in', parent.userIds)
    .orderBy('related_user_id')
    .execute()
  const ownChildren = new Set<number>()
  for (const link of ownLinks) {
    const child = await onePerson(db, link.related_user_id)
    if (child.userId !== actor.userId) ownChildren.add(child.userId)
  }
  const table = event.eventKind === 'game' ? 'game_rsvps' : 'team_event_rsvps'
  const replies = await db
    .selectFrom(table)
    .select(['user_id', 'response'])
    .where('event_id', '=', event.id)
    .execute()
  const eligible = new Set(
    [...members, ...staff, ...guardians]
      .map(row => row.user_id)
      .concat([...ownChildren])
  )
  const ids = [
    ...new Set([...eligible, actor.userId, ...replies.map(row => row.user_id)])
  ]
  const users = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'avatar_path', 'is_admin'])
    .where('id', 'in', ids)
    .where('disabled_at', 'is', null)
    .where('merged_into', 'is', null)
    .execute()
  const activeIds = new Set(users.map(user => user.id))
  const replyUserIds = [
    actor.userId,
    ...[...ownChildren].filter(id => activeIds.has(id))
  ]
  // A spectator may RSVP for themselves. Show their reply to other viewers
  // only while they can still see this event; removed roster rows stay private.
  const parentVisibility = new Map<number, boolean>(
    parent.userIds.map((id): [number, boolean] => [id, true])
  )
  const visibleUsers = []
  for (const user of users) {
    if (!eligible.has(user.id) && user.id !== actor.userId) {
      const scopes = await visibleScopes(db, user.id, user.is_admin)
      let allowed =
        event.eventKind === 'event'
          ? canSeeTeam(scopes, event.teamId)
          : canSeeGame(scopes, {
              homeTeamId: event.teamIds[0],
              awayTeamId: event.teamIds[1],
              seasonId: event.seasonId
            })
      if (!allowed) {
        const child = await onePerson(db, user.id)
        const links = await db
          .selectFrom('user_links')
          .select('user_id')
          .where('kind', '=', 'guardian')
          .where('related_user_id', 'in', child.userIds)
          .execute()
        for (const link of links) {
          const cached = parentVisibility.get(link.user_id)
          if (cached !== undefined) {
            if (cached) {
              allowed = true
              break
            }
            continue
          }
          const guardian = await onePerson(db, link.user_id)
          const active = await db
            .selectFrom('users')
            .select('is_admin')
            .where('id', '=', guardian.userId)
            .where('disabled_at', 'is', null)
            .where('merged_into', 'is', null)
            .executeTakeFirst()
          let visible = false
          if (active != null) {
            const scopes = await visibleScopes(
              db,
              guardian.userId,
              active.is_admin
            )
            visible =
              event.eventKind === 'event'
                ? canSeeTeam(scopes, event.teamId)
                : canSeeGame(scopes, {
                    homeTeamId: event.teamIds[0],
                    awayTeamId: event.teamIds[1],
                    seasonId: event.seasonId
                  })
          }
          parentVisibility.set(link.user_id, visible)
          if (visible) {
            allowed = true
            break
          }
        }
      }
      if (!allowed) continue
    }
    visibleUsers.push(user)
  }
  return { users: visibleUsers, replies, replyUserIds }
}

export async function readEventInfo(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  media: MediaContext
): Promise<EventInfo> {
  const event = await resolveEvent(db, actor, id)
  const { users, replies, replyUserIds } = await eventPeople(db, event, actor)
  const { teamIds, seasonId, ...info } = event
  return {
    ...info,
    replyUserIds,
    attendees: sortedAttendees(
      users.map(user => ({
        userId: user.id,
        name: replyUserIds.includes(user.id)
          ? user.display_name
          : shortName({ id: user.id, displayName: user.display_name }),
        avatarUrl: imageUrl(media.space, user.avatar_path),
        response:
          replies.find(row => row.user_id === user.id)?.response ?? null,
        canReply: replyUserIds.includes(user.id)
      }))
    )
  }
}

export async function saveEventRsvp(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  userId: number,
  response: Rsvp
): Promise<void> {
  await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph'])
    const event = await resolveEvent(trx, actor, id)
    const people = await eventPeople(trx, event, actor)
    if (!people.replyUserIds.includes(userId))
      throw forbidden('You can RSVP only for yourself or your children')
    const table = event.eventKind === 'game' ? 'game_rsvps' : 'team_event_rsvps'
    await trx
      .insertInto(table)
      .values({
        event_id: id,
        user_id: userId,
        response,
        updated_by: actor.userId,
        updated_at: new Date()
      })
      .onConflict(oc =>
        oc.columns(['event_id', 'user_id']).doUpdateSet({
          response,
          updated_by: actor.userId,
          updated_at: new Date()
        })
      )
      .execute()
  })
}

export async function createTeamEvent(
  db: Kysely<Database>,
  actor: Actor,
  body: TeamEventInput
): Promise<{ id: string }> {
  return await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph'])
    const fresh = await currentActor(trx, actor)
    const team = await trx
      .selectFrom('teams')
      .select(['id', 'kind', 'merged_into'])
      .where('id', '=', body.teamId)
      .executeTakeFirst()
    if (team == null || team.merged_into != null) throw notFound()
    if (!(await canAdminister(trx, fresh, { kind: 'team', id: body.teamId }))) {
      const scopes = await visibleScopes(trx, fresh.userId, fresh.isAdmin)
      if (!canSeeTeam(scopes, body.teamId)) throw notFound()
      throw forbidden('Only team administrators may schedule an event')
    }
    if (team.kind !== 'full')
      throw forbidden('Choose a team with its own schedule')
    const hash = createHash('sha256')
      .update(JSON.stringify({ kind: 'teamEvent', ...body }))
      .digest('hex')
    const existing = await trx
      .selectFrom('creation_idempotency')
      .selectAll()
      .where('user_id', '=', actor.userId)
      .where('key', '=', body.idempotencyKey)
      .executeTakeFirst()
    if (existing != null) {
      if (existing.body_hash !== hash)
        throw conflict('This retry key belongs to different event details')
      return existing.response as { id: string }
    }
    const id = makeId('teamEvent')
    await trx
      .insertInto('team_events')
      .values({
        id,
        team_id: body.teamId,
        title: body.title,
        start_at: new Date(body.startAt),
        end_at: body.endAt == null ? null : new Date(body.endAt),
        timezone: body.timezone,
        venue: body.venue,
        address: body.address ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        status: body.status
      })
      .execute()
    await trx
      .insertInto('creation_idempotency')
      .values({
        user_id: actor.userId,
        key: body.idempotencyKey,
        body_hash: hash,
        response: { id },
        created_at: new Date()
      })
      .execute()
    return { id }
  })
}

export async function updateEventInfo(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  raw: unknown
): Promise<void> {
  if (!isRecord(raw)) throw new TypeError('Enter event details')
  await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph'])
    const event = await resolveEvent(trx, actor, id)
    if (!event.canManage)
      throw forbidden('Only event administrators may edit these details')
    const startAt =
      event.eventKind === 'event' && raw.startAt !== undefined
        ? eventDate(raw.startAt, 'Start time')
        : event.startAt!
    if (
      event.eventKind === 'game' &&
      ['startAt', 'title', 'status', 'teamId', 'timezone', 'venue'].some(
        key => raw[key] !== undefined
      )
    )
      throw new TypeError(
        'Use game scheduling to change game time, venue or participants'
      )
    const fields = asEventLocationFields(raw, startAt)
    const end = fields.endAt === undefined ? event.endAt : fields.endAt
    if (end != null && Date.parse(end) <= Date.parse(startAt))
      throw new TypeError('End time must be after start time')
    const changedAddress =
      fields.address !== undefined && fields.address !== event.address
    const coordinates = {
      latitude:
        fields.latitude === undefined
          ? changedAddress
            ? null
            : event.latitude
          : fields.latitude,
      longitude:
        fields.longitude === undefined
          ? changedAddress
            ? null
            : event.longitude
          : fields.longitude
    }
    const location = {
      end_at: end == null ? null : new Date(end),
      address: fields.address === undefined ? event.address : fields.address,
      ...coordinates,
      updated_at: new Date()
    }
    if (event.eventKind === 'game') {
      await trx
        .updateTable('games')
        .set(location)
        .where('id', '=', id)
        .execute()
    } else {
      let title = event.title!
      if (raw.title !== undefined)
        title = eventText(raw.title, 'Title', 200, true)!
      if (
        raw.status !== undefined &&
        raw.status !== 'scheduled' &&
        raw.status !== 'cancelled'
      )
        throw new TypeError('Choose scheduled or cancelled')
      await trx
        .updateTable('team_events')
        .set({
          ...location,
          title,
          start_at: new Date(startAt),
          timezone:
            raw.timezone === undefined
              ? event.timezone
              : asGameTimezone(raw.timezone),
          venue:
            raw.venue === undefined
              ? event.venue
              : eventText(raw.venue, 'Venue', 200),
          status: raw.status ?? (event.status as 'scheduled' | 'cancelled')
        })
        .where('id', '=', id)
        .execute()
    }
  })
}

/** A presentation adapter: titled events never create baseball game rows. */
export async function teamEventDetail(
  db: Kysely<Database>,
  actor: Actor,
  id: string
): Promise<GameDetail | undefined> {
  const row = await db
    .selectFrom('team_events')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (row == null) return undefined
  const event = await resolveEvent(db, actor, id)
  return asGameDetail({
    ...event,
    homeTeamId: event.teamId,
    homeTeamName: event.teamName,
    awayTeamId: '',
    awayTeamName: '',
    seasonId: null,
    homeScore: null,
    awayScore: null,
    ingestStatus: 'none',
    ingestMessage: null,
    canScore: false,
    canDj: false,
    videos: []
  })
}

export function teamEventSchedule(
  row: Selectable<TeamEventsTable>,
  teamName: string,
  logoPath: string | null
): ScheduleRow {
  return {
    id: row.id,
    eventKind: 'event' as const,
    title: row.title,
    homeTeamId: row.team_id,
    homeTeamName: teamName,
    awayTeamId: '',
    awayTeamName: '',
    homeTeamExternal: false,
    awayTeamExternal: false,
    homeLogoPath: logoPath,
    awayLogoPath: null,
    seasonId: null,
    startAt: row.start_at.toISOString(),
    endAt: iso(row.end_at),
    venue: row.venue,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    exhibition: false,
    pendingApproval: false,
    pendingRequestId: null,
    cancellationReason: null,
    withdrawnByTeamId: null,
    withdrawnByTeamName: null,
    status: row.status,
    homeScore: null,
    awayScore: null,
    ingestStatus: 'none',
    videoCount: 0,
    durationSec: null,
    posterUrl: null,
    isLive: false,
    externalIds: []
  }
}
