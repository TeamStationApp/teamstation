import { createHash } from 'node:crypto'

import type { Kysely, Selectable } from 'kysely'

import { asGameDetail, type GameDetail } from '../../common/api'
import { asLiteral } from '../../common/asLiteral'
import { conflict, forbidden, notFound } from '../../common/errors'
import {
  asEventLocationFields,
  type EventAttendee,
  eventDate,
  type EventInfo,
  eventText,
  PRACTICE_TITLE,
  type Rsvp,
  sortedAttendees,
  type TeamEventInput
} from '../../common/eventInfo'
import { asGameTimezone } from '../../common/gameApprovals'
import { isRecord } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import { shortName } from '../../common/names'
import { type Role, ROLES } from '../../common/roles'
import { canSeeGame, canSeeTeam, visibleScopes } from '../access'
import { type OnePerson, onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, TeamEventsTable } from '../db/database'
import { canScheduleFor, currentActor } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import type { ScheduleRow } from '../routes/seasons'
import { mayScheduleIn, scheduleRights } from '../schedule/scheduleGames'
import { noteScopeChange } from '../socket/syncRevision'
import { recheckUmpireAssignments } from '../umpires/assignments'

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
      eventType: event.event_type,
      notes: event.notes,
      arrivalTimeDelta: event.arrival_time_delta,
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
      canViewAttendance: true,
      canManage: await canScheduleFor(db, fresh, {
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
  if (game == null) throw notFound()
  const canViewAttendance = canSeeGame(scopes, {
    homeTeamId: game.home_team_id,
    awayTeamId: game.away_team_id,
    seasonId: game.season_id
  })
  const rights = await scheduleRights(db, fresh.userId, fresh.isAdmin)
  const team = await db
    .selectFrom('teams')
    .select('name')
    .where('id', '=', game.home_team_id)
    .executeTakeFirstOrThrow()
  return {
    id,
    eventKind: 'game',
    eventType: 'game',
    notes: game.notes,
    arrivalTimeDelta: game.arrival_time_delta,
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
    canViewAttendance,
    canManage:
      mayScheduleIn(rights, game.home_team_id, game.season_id) ||
      mayScheduleIn(rights, game.away_team_id, game.season_id) ||
      (await canScheduleFor(db, fresh, {
        kind: 'team',
        id: game.home_team_id
      })) ||
      (await canScheduleFor(db, fresh, { kind: 'team', id: game.away_team_id }))
  }
}

/** Direct event attendance deliberately does not inherit season/league people. */
async function eventPeople(
  db: Kysely<Database>,
  event: ResolvedEvent,
  actor: Actor,
  media?: MediaContext
): Promise<{ attendees: EventAttendee[]; replyUserIds: string[] }> {
  const identities = new Map<string, OnePerson>()
  const identity = async (id: string): Promise<OnePerson> => {
    const cached = identities.get(id)
    if (cached != null) return cached
    const person = await onePerson(db, id)
    for (const alias of person.userIds) identities.set(alias, person)
    return person
  }
  const members = await db
    .selectFrom('memberships')
    .select(['user_id', 'is_player', 'positions', 'role'])
    .where('team_id', '=', event.teamId)
    .execute()
  const staff = await db
    .selectFrom('scope_roles')
    .select(['user_id', 'role'])
    .where('scope_type', '=', 'team')
    .where('scope_id', '=', event.teamId)
    .execute()
  const participants = new Map<
    string,
    {
      isPlayer: boolean
      positions: Set<string>
      roles: Set<Role>
      children: Set<string>
    }
  >()
  const participant = (
    id: string
  ): {
    isPlayer: boolean
    positions: Set<string>
    roles: Set<Role>
    children: Set<string>
  } => {
    let row = participants.get(id)
    if (row == null) {
      row = {
        isPlayer: false,
        positions: new Set(),
        roles: new Set(),
        children: new Set()
      }
      participants.set(id, row)
    }
    return row
  }
  for (const member of members) {
    const row = participant((await identity(member.user_id)).userId)
    row.isPlayer ||= member.is_player
    if (member.is_player)
      for (const position of member.positions) row.positions.add(position)
    if (member.role === 'owner' || member.role === 'manager')
      row.roles.add('admin')
  }
  for (const member of staff)
    participant((await identity(member.user_id)).userId).roles.add(member.role)
  // Closed aliases are usable; disabled survivors are not rostered children.
  const playerIds = [...participants]
    .filter(([, row]) => row.isPlayer)
    .map(([id]) => id)
  const activePlayers =
    playerIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select('id')
          .where('id', 'in', playerIds)
          .where('disabled_at', 'is', null)
          .where('merged_into', 'is', null)
          .execute()
  const playerAliases = new Set<string>()
  for (const player of activePlayers)
    for (const alias of (await identity(player.id)).userIds)
      playerAliases.add(alias)
  const guardianLinks =
    playerAliases.size === 0
      ? []
      : await db
          .selectFrom('user_links')
          .select(['user_id', 'related_user_id'])
          .where('kind', '=', 'guardian')
          .where('related_user_id', 'in', [...playerAliases])
          .execute()
  for (const link of guardianLinks)
    participant((await identity(link.user_id)).userId).children.add(
      (await identity(link.related_user_id)).userId
    )
  const parent = await identity(actor.userId)
  const ownLinks = await db
    .selectFrom('user_links')
    .select('related_user_id')
    .where('kind', '=', 'guardian')
    .where('user_id', 'in', parent.userIds)
    .execute()
  // RSVP eligibility is explicit on a participating team, never inherited
  // from a season/league, site administration, or guardianship alone.
  const eventMembers = await db
    .selectFrom('memberships')
    .select(['user_id', 'is_player'])
    .where('team_id', 'in', event.teamIds)
    .execute()
  const eventStaff = await db
    .selectFrom('scope_roles')
    .select('user_id')
    .where('scope_type', '=', 'team')
    .where('scope_id', 'in', event.teamIds)
    .where('role', 'in', ['admin', 'coach', 'assistant'])
    .execute()
  const rostered = new Set<string>()
  let mayReplySelf = false
  for (const member of eventMembers) {
    const id = (await identity(member.user_id)).userId
    if (member.is_player) rostered.add(id)
    if (id === parent.userId) mayReplySelf = true
  }
  for (const staff of eventStaff)
    if ((await identity(staff.user_id)).userId === parent.userId)
      mayReplySelf = true
  const ownIds = new Set<string>(mayReplySelf ? [parent.userId] : [])
  for (const link of ownLinks) {
    const id = (await identity(link.related_user_id)).userId
    if (rostered.has(id)) ownIds.add(id)
  }
  const ids = [...new Set([...participants.keys(), ...ownIds])]
  const users =
    ids.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select([
            'id',
            'display_name',
            'first_name',
            'last_name',
            'avatar_path',
            'bats',
            'throws'
          ])
          .where('id', 'in', ids)
          .where('disabled_at', 'is', null)
          .where('merged_into', 'is', null)
          .execute()
  const names = new Map(
    users.map(user => [
      user.id,
      shortName({
        id: user.id,
        displayName: user.display_name,
        firstName: user.first_name,
        lastName: user.last_name
      })
    ])
  )
  const aliases = new Set<string>()
  for (const user of users)
    for (const alias of (await identity(user.id)).userIds) aliases.add(alias)
  const table = event.eventKind === 'game' ? 'game_rsvps' : 'team_event_rsvps'
  const stored =
    aliases.size === 0
      ? []
      : await db
          .selectFrom(table)
          .select(['user_id', 'response'])
          .where('event_id', '=', event.id)
          .where('user_id', 'in', [...aliases])
          .orderBy('updated_at', 'desc')
          .orderBy('user_id')
          .execute()
  const replies = new Map<string, Rsvp>()
  for (const row of stored) {
    const id = (await identity(row.user_id)).userId
    if (!replies.has(id)) replies.set(id, row.response)
  }
  const activeIds = new Set(users.map(user => user.id))
  const replyUserIds = [...ownIds].filter(id => activeIds.has(id))
  return {
    replyUserIds,
    attendees: sortedAttendees(
      users.map(user => {
        const row = participants.get(user.id)
        return {
          userId: user.id,
          name: names.get(user.id)!,
          avatarUrl:
            media == null ? null : imageUrl(media.space, user.avatar_path),
          response: replies.get(user.id) ?? null,
          canReply: ownIds.has(user.id),
          isTeamParticipant: row != null,
          isPlayer: row?.isPlayer ?? false,
          staffRoles: ROLES.filter(role => row?.roles.has(role) === true),
          bats: user.bats,
          throws: user.throws,
          positions: [...(row?.positions ?? [])],
          guardianOf: [...(row?.children ?? [])]
            .map(id => names.get(id)!)
            .filter(Boolean)
        }
      })
    )
  }
}

async function survivingTeam(
  db: Kysely<Database>,
  id: string
): Promise<string> {
  const visited = new Set<string>()
  for (let depth = 0; depth < 16 && !visited.has(id); depth++) {
    visited.add(id)
    const row = await db
      .selectFrom('teams')
      .select('merged_into')
      .where('id', '=', id)
      .executeTakeFirst()
    if (row == null) throw notFound()
    if (row.merged_into == null) return id
    id = row.merged_into
  }
  throw notFound()
}

export async function readEventInfo(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  media: MediaContext,
  teamId?: string
): Promise<EventInfo> {
  const event = await resolveEvent(db, actor, id)
  const fresh = await currentActor(db, actor)
  const scopes = await visibleScopes(db, fresh.userId, fresh.isAdmin)
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', event.teamIds)
    .execute()
  const choices = teams.filter(team => canSeeTeam(scopes, team.id))
  const requested = teamId == null ? undefined : await survivingTeam(db, teamId)
  if (requested != null && !choices.some(team => team.id === requested))
    throw notFound()
  const { teamIds, seasonId, ...info } = event
  if (!event.canViewAttendance)
    return { ...info, replyUserIds: [], attendees: [], attendanceTeams: [] }
  let selected =
    requested ??
    choices.find(team => team.id === event.teamId)?.id ??
    choices[0]?.id ??
    event.teamId
  const projections = new Map<string, Awaited<ReturnType<typeof eventPeople>>>()
  const affiliations = new Set<string>()
  for (const id of event.teamIds) {
    if (!choices.some(team => team.id === id)) continue
    const people = await eventPeople(db, { ...event, teamId: id }, fresh, media)
    projections.set(id, people)
    if (
      people.attendees.some(
        row => row.userId === fresh.userId && row.isTeamParticipant === true
      )
    ) {
      affiliations.add(id)
    }
  }
  if (requested == null && affiliations.size > 0) {
    // Of the viewer's own teams, the one they most likely mean: a point each
    // for guarding a child there, being on its staff and being a member.
    // A tie keeps the event's own team order.
    const viewer = await onePerson(db, fresh.userId)
    const memberOf = new Set(
      (
        await db
          .selectFrom('memberships')
          .select('team_id')
          .where('team_id', 'in', [...affiliations])
          .where('user_id', 'in', viewer.userIds)
          .execute()
      ).map(row => row.team_id)
    )
    let best = -1
    for (const id of event.teamIds) {
      if (!affiliations.has(id)) continue
      const own = projections
        .get(id)!
        .attendees.find(row => row.userId === fresh.userId)
      const points =
        ((own?.guardianOf ?? []).length > 0 ? 1 : 0) +
        ((own?.staffRoles ?? []).length > 0 ? 1 : 0) +
        (memberOf.has(id) ? 1 : 0)
      if (points > best) {
        best = points
        selected = id
      }
    }
  }
  const people =
    projections.get(selected) ??
    (await eventPeople(db, { ...event, teamId: selected }, fresh, media))
  return {
    ...info,
    teamId: selected,
    teamName: teams.find(team => team.id === selected)!.name,
    attendanceTeams: choices.map(team => ({
      ...team,
      isParticipant: affiliations.has(team.id)
    })),
    ...people,
    attendees:
      choices.length === 0
        ? people.attendees
            .filter(row => row.canReply)
            .map(row => ({
              ...row,
              isTeamParticipant: false,
              isPlayer: false,
              staffRoles: [],
              positions: [],
              guardianOf: []
            }))
        : people.attendees
  }
}

export async function saveEventRsvp(
  db: Kysely<Database>,
  actor: Actor,
  id: string,
  userId: string,
  response: Rsvp
): Promise<void> {
  await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph'])
    const event = await resolveEvent(trx, actor, id)
    if (!event.canViewAttendance) throw notFound()
    const people = await eventPeople(trx, event, actor)
    if (!people.replyUserIds.includes(userId))
      throw forbidden(
        'RSVP requires explicit team membership or a child on a participating roster'
      )
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
    if (
      !(await canScheduleFor(trx, fresh, { kind: 'team', id: body.teamId }))
    ) {
      const scopes = await visibleScopes(trx, fresh.userId, fresh.isAdmin)
      if (!canSeeTeam(scopes, body.teamId)) throw notFound()
      throw forbidden(
        'Only team administrators, coaches and assistants may schedule an event'
      )
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
        notes: body.notes ?? null,
        arrival_time_delta: body.arrivalTimeDelta ?? null,
        event_type: body.eventType ?? 'other',
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        status: body.status
      })
      .execute()
    noteScopeChange(trx, { teamId: body.teamId })
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
      throw forbidden(
        'Only team administrators, coaches and assistants may edit these details'
      )
    const startAt =
      event.eventKind === 'event' && raw.startAt !== undefined
        ? eventDate(raw.startAt, 'Start time')
        : event.startAt!
    if (
      event.eventKind === 'game' &&
      [
        'startAt',
        'title',
        'status',
        'teamId',
        'timezone',
        'venue',
        'eventType',
        'arrivalTimeDelta',
        'notes'
      ].some(key => raw[key] !== undefined)
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
      ...(fields.notes === undefined ? {} : { notes: fields.notes }),
      ...(fields.arrivalTimeDelta === undefined
        ? {}
        : { arrival_time_delta: fields.arrivalTimeDelta }),
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
      await recheckUmpireAssignments(trx, id)
      noteScopeChange(trx, { gameId: id })
    } else {
      const askedType =
        raw.eventType === undefined
          ? undefined
          : asLiteral('practice', 'other')(raw.eventType)
      const eventType = askedType ?? event.eventType
      // A practice keeps a title of its own or is called Practice; any other
      // event needs one.
      let title = event.title!
      if (raw.title !== undefined)
        title =
          eventType === 'practice'
            ? (eventText(raw.title, 'Title', 200) ?? PRACTICE_TITLE)
            : eventText(raw.title, 'Title', 200, true)!
      // A practice called Practice only because nobody titled it has no
      // title to become another event with.
      else if (
        eventType === 'other' &&
        event.eventType === 'practice' &&
        title === PRACTICE_TITLE
      )
        throw new TypeError('Title is required')
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
          ...(askedType === undefined ? {} : { event_type: askedType }),
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
      noteScopeChange(trx, { teamId: event.teamId })
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
    umpires: null,
    isGameLive: false,
    nonMemberView: false,
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
    eventType: row.event_type,
    notes: row.notes,
    arrivalTimeDelta: row.arrival_time_delta,
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
    isGameLive: false,
    externalIds: []
  }
}
