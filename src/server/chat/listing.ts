import { type Kysely, sql } from 'kysely'
import { base64url } from 'rfc4648'

import type {
  ChatConversation,
  ChatDmPerson,
  ChatLogRow,
  ChatMember,
  ChatPerson
} from '../../common/api'
import { shortNames } from '../../common/names'
import { hasRole, roleScopes } from '../access'
import type { ChatKind, Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { survivors } from '../teams/teamStaff'
import { isEligible, seasonStaffIds, teamGuardianRows } from './audiences'
import { DmFacts } from './dms'
import { defaultPreferences, preferencesFor } from './preferences'
import { scopeNames, titlesOf } from './titles'

/**
 * What the chat routes read back: a person's conversations, a
 * conversation's members, its log, and names for people.
 *
 * - **Moderators** may delete anyone's message: in team chats whoever holds
 *   `admin` or `coach` on the team (`hasRole`, inherited roles and site
 *   administrators included); in season chats the season staff; in
 *   `leagueOrg` the league's direct administrators; in a DM nobody.
 * - **Approvers** approve history for a member whose identity was reset:
 *   the moderators in `teamMembers`, `teamFans` and `seasonAnnouncements`,
 *   and any member in every other kind.
 *
 * Fields that depend on keys are read from the key tables as they stand
 * (written from M6 and M7 on): no identity is `hasIdentity: false` and
 * `eligible: false`; no epoch is neither `locked` nor `noHolder`.
 */

const MODERATED_APPROVALS: readonly ChatKind[] = [
  'teamMembers',
  'teamFans',
  'seasonAnnouncements'
]

interface ConversationRow {
  id: string
  kind: ChatKind
  scope_type: 'team' | 'season' | 'league' | null
  scope_id: string | null
  closed_at: Date | null
  last_seq: number
}

/** Short names and pictures for people, by id. */
export async function chatPeople(
  db: Kysely<Database>,
  space: MediaContext['space'],
  userIds: number[]
): Promise<Map<number, ChatPerson & { names: string[] }>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName',
      'avatar_path as avatarPath'
    ])
    .where('id', 'in', ids)
    .execute()
  const names = shortNames(rows)
  return new Map(
    rows.map(row => [
      row.id,
      {
        userId: row.id,
        shortName: names.get(row.id) ?? row.displayName,
        avatarUrl: imageUrl(space, row.avatarPath),
        names: [row.displayName, row.firstName ?? '', row.lastName ?? '']
      }
    ])
  )
}

/** Whether any of a person's names holds `query`, ignoring case. */
export function nameMatches(names: string[], query: string): boolean {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return true
  return names.some(name => name.toLowerCase().includes(wanted))
}

/** The season each season id belongs to the league of, for season chats. */
async function leaguesOfSeasons(
  db: Kysely<Database>,
  seasonIds: string[]
): Promise<Map<string, string | null>> {
  if (seasonIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('seasons')
    .select(['id', 'league_id'])
    .where('id', 'in', seasonIds)
    .execute()
  return new Map(rows.map(row => [row.id, row.league_id]))
}

/** Every conversation `userId` is in now, as the list shows it. */
export async function conversationsFor(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean,
  now: Date = new Date()
): Promise<ChatConversation[]> {
  if (!(await isEligible(db, userId, now))) return []
  const rows: ConversationRow[] = await db
    .selectFrom('chat_members')
    .innerJoin(
      'chat_conversations',
      'chat_conversations.id',
      'chat_members.conversation_id'
    )
    .select([
      'chat_conversations.id',
      'chat_conversations.kind',
      'chat_conversations.scope_type',
      'chat_conversations.scope_id',
      'chat_conversations.closed_at',
      'chat_conversations.last_seq'
    ])
    .where('chat_members.user_id', '=', userId)
    .where('chat_members.left_at', 'is', null)
    .orderBy('chat_conversations.created_at')
    .orderBy('chat_conversations.id')
    .execute()
  if (rows.length === 0) return []
  return await describe(db, rows, userId, isAdmin)
}

/** One conversation as the list shows it to `userId`. */
export async function conversationFor(
  db: Kysely<Database>,
  conversationId: string,
  userId: number,
  isAdmin: boolean
): Promise<ChatConversation> {
  const row = await db
    .selectFrom('chat_conversations')
    .select(['id', 'kind', 'scope_type', 'scope_id', 'closed_at', 'last_seq'])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow()
  const [described] = await describe(db, [row], userId, isAdmin)
  return described
}

async function describe(
  db: Kysely<Database>,
  rows: ConversationRow[],
  userId: number,
  isAdmin: boolean
): Promise<ChatConversation[]> {
  const ids = rows.map(row => row.id)
  const preferences = await preferencesFor(db, userId, ids)
  const posts = await db
    .selectFrom('chat_messages')
    .select(['conversation_id', 'id', 'seq', 'created_at'])
    .where('conversation_id', 'in', ids)
    .where('kind', '=', 'post')
    .distinctOn('conversation_id')
    .orderBy('conversation_id')
    .orderBy('seq', 'desc')
    .execute()
  const lastPost = new Map(posts.map(post => [post.conversation_id, post]))
  const titles = await titlesOf(
    db,
    rows.map(row => ({
      id: row.id,
      kind: row.kind,
      scopeType: row.scope_type,
      scopeId: row.scope_id
    }))
  )
  const counts = new Map(
    (
      await db
        .selectFrom('chat_members')
        .select(['conversation_id', eb => eb.fn.countAll<number>().as('n')])
        .where('conversation_id', 'in', ids)
        .where('left_at', 'is', null)
        .groupBy('conversation_id')
        .execute()
    ).map(row => [row.conversation_id, Number(row.n)])
  )
  const unread = new Map(
    (
      await sql<{ conversationId: string; n: number }>`
        select m.conversation_id as "conversationId", count(*)::int as n
        from chat_messages m
        left join chat_read_cursors r
          on r.conversation_id = m.conversation_id and r.user_id = ${userId}
        where m.conversation_id = any(${ids}::text[])
          and m.seq > coalesce(r.seq, 0)
          and m.sender_user_id <> ${userId}
          and m.kind = 'post'
          and m.cleared_at is null
        group by m.conversation_id
      `.execute(db)
    ).rows.map(row => [row.conversationId, Number(row.n)])
  )
  const keys = await keyState(db, ids, userId)
  const people = await dmPeople(
    db,
    rows.filter(row => row.kind === 'dm').map(row => row.id),
    userId
  )
  const names = await scopeNames(
    db,
    rows.flatMap(row =>
      row.scope_type == null || row.scope_id == null
        ? []
        : [{ type: row.scope_type, id: row.scope_id }]
    )
  )
  // When each chat last had a message, for the list. The newest envelope
  // of any kind: a reaction or an edit is news in a chat too.
  const lastAt = new Map(
    (
      await db
        .selectFrom('chat_messages')
        .select([
          'conversation_id',
          eb => eb.fn.max<Date>('created_at').as('at')
        ])
        .where('conversation_id', 'in', ids)
        .groupBy('conversation_id')
        .execute()
    ).map(row => [row.conversation_id, new Date(row.at).toISOString()])
  )

  // Moderation and posting, from the caller's roles.
  const scopes = await roleScopes(db, userId, isAdmin)
  const seasonIds = rows.flatMap(row =>
    row.scope_type === 'season' && row.scope_id != null ? [row.scope_id] : []
  )
  const seasonLeague = await leaguesOfSeasons(db, seasonIds)
  const direct = await db
    .selectFrom('scope_roles')
    .select(['scope_type', 'scope_id', 'role'])
    .where('user_id', '=', userId)
    .execute()
  const holdsOn = (type: string, id: string | null | undefined): boolean =>
    id != null &&
    direct.some(role => role.scope_type === type && role.scope_id === id)
  const seasonStaff = (seasonId: string): boolean =>
    holdsOn('season', seasonId) || holdsOn('league', seasonLeague.get(seasonId))

  return rows.map(row => {
    const scopeId = row.scope_id ?? ''
    let canModerate = false
    if (row.scope_type === 'team') {
      canModerate =
        hasRole(scopes, 'admin', scopeId) || hasRole(scopes, 'coach', scopeId)
    } else if (row.scope_type === 'season') {
      canModerate = seasonStaff(scopeId)
    } else if (row.scope_type === 'league') {
      canModerate = direct.some(
        role =>
          role.scope_type === 'league' &&
          role.scope_id === scopeId &&
          role.role === 'admin'
      )
    }
    const closed = row.closed_at != null
    const canPost =
      !closed && (row.kind !== 'seasonAnnouncements' || seasonStaff(scopeId))
    const key = keys.get(row.id)
    return {
      id: row.id,
      kind: row.kind,
      title: titles.get(row.id) ?? null,
      scope:
        row.scope_type == null || row.scope_id == null
          ? null
          : { type: row.scope_type, id: row.scope_id },
      scopeName:
        row.scope_type == null
          ? null
          : (names.get(`${row.scope_type}:${scopeId}`) ?? null),
      lastSeq: Number(row.last_seq),
      lastMessageAt: lastAt.get(row.id) ?? null,
      lastPostAt:
        lastPost.get(row.id) == null
          ? null
          : new Date(lastPost.get(row.id)!.created_at).toISOString(),
      lastPostId: lastPost.get(row.id)?.id ?? null,
      lastPostSeq: Number(lastPost.get(row.id)?.seq ?? 0),
      preferences: preferences.get(row.id) ?? defaultPreferences(),
      unread: unread.get(row.id) ?? 0,
      canPost,
      canModerate,
      locked: key?.locked ?? false,
      noHolder: key?.noHolder ?? false,
      closed,
      memberCount: counts.get(row.id) ?? 0,
      people: people.get(row.id) ?? []
    }
  })
}

/**
 * For each DM, everybody else who was in it with the caller, by short name:
 * its current members, and those who left no earlier than the caller (last)
 * joined, marked `left`, so the app can still name a DM whose others have all gone.
 * Nobody who left before the caller came, and never the caller's own
 * accounts merged into theirs. Short names are made distinct among the
 * DM's people and the caller, as `membersOf` makes them among its members.
 */
async function dmPeople(
  db: Kysely<Database>,
  conversationIds: string[],
  userId: number
): Promise<Map<string, ChatDmPerson[]>> {
  if (conversationIds.length === 0) return new Map()
  const { rows } = await sql<{
    conversationId: string
    userId: number | string
    left: boolean
  }>`
    select m.conversation_id as "conversationId", m.user_id as "userId",
      m.left_at is not null as "left"
    from chat_members m
    join chat_members me
      on me.conversation_id = m.conversation_id and me.user_id = ${userId}
    join users u on u.id = m.user_id
    where m.conversation_id = any(${conversationIds}::text[])
      and m.user_id <> ${userId}
      and (m.left_at is null or m.left_at >= me.joined_at)
      and u.merged_into is distinct from ${userId}
  `.execute(db)
  if (rows.length === 0) return new Map()
  const users = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName'
    ])
    .where('id', 'in', [userId, ...rows.map(row => Number(row.userId))])
    .execute()
  const userOf = new Map(users.map(user => [user.id, user]))
  const byConversation = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byConversation.get(row.conversationId) ?? []
    list.push(row)
    byConversation.set(row.conversationId, list)
  }
  const result = new Map<string, ChatDmPerson[]>()
  for (const [conversationId, list] of byConversation) {
    const named = [userId, ...list.map(row => Number(row.userId))].flatMap(
      id => {
        const user = userOf.get(id)
        return user == null ? [] : [user]
      }
    )
    const names = shortNames(named)
    result.set(
      conversationId,
      list
        .map(row => {
          const id = Number(row.userId)
          return {
            userId: id,
            shortName:
              names.get(id) ?? userOf.get(id)?.displayName ?? String(id),
            left: row.left
          }
        })
        .sort((a, b) => a.shortName.localeCompare(b.shortName))
    )
  }
  return result
}

/**
 * For each conversation with an epoch: whether the caller holds no box for
 * the latest epoch under their current identity (`locked`), and whether no
 * current member does (`noHolder`).
 */
async function keyState(
  db: Kysely<Database>,
  conversationIds: string[],
  userId: number
): Promise<Map<string, { locked: boolean; noHolder: boolean }>> {
  const { rows } = await sql<{
    conversationId: string
    mine: boolean
    anyone: boolean
  }>`
    with latest as (
      select conversation_id, max(epoch) as epoch
      from chat_epochs
      where conversation_id = any(${conversationIds}::text[])
      group by conversation_id
    ),
    held as (
      select b.conversation_id, b.user_id
      from chat_epoch_boxes b
      join latest l
        on l.conversation_id = b.conversation_id and l.epoch = b.epoch
      join chat_identities i
        on i.id = b.identity_id and i.user_id = b.user_id
        and i.replaced_at is null
      join chat_members m
        on m.conversation_id = b.conversation_id and m.user_id = b.user_id
        and m.left_at is null
    )
    select l.conversation_id as "conversationId",
      exists (
        select 1 from held h
        where h.conversation_id = l.conversation_id and h.user_id = ${userId}
      ) as mine,
      exists (
        select 1 from held h where h.conversation_id = l.conversation_id
      ) as anyone
    from latest l
  `.execute(db)
  return new Map(
    rows.map(row => [
      row.conversationId,
      { locked: !row.mine, noHolder: !row.anyone }
    ])
  )
}

/** The people who may moderate a conversation, by kind and scope. */
export async function moderatorsOf(
  db: Kysely<Database>,
  conversation: { kind: ChatKind; scope_id: string | null },
  memberIds: number[]
): Promise<Set<number>> {
  const scopeId = conversation.scope_id
  if (conversation.kind === 'dm' || scopeId == null) return new Set()
  let raw: number[] = []
  if (conversation.kind.startsWith('team')) {
    // `hasRole(admin | coach)` on the team, read for everybody at once: the
    // team's own, its seasons' and their leagues', and site administrators.
    const { rows } = await sql<{ userId: number }>`
      with seasons as (
        select s.id, s.league_id
        from season_teams st join seasons s on s.id = st.season_id
        where st.team_id = ${scopeId}
      )
      select user_id as "userId" from scope_roles
      where role in ('admin', 'coach') and (
        (scope_type = 'team' and scope_id = ${scopeId})
        or (scope_type = 'season' and scope_id in (select id from seasons))
        or (scope_type = 'league' and scope_id in (select league_id from seasons))
      )
      union
      select user_id from memberships
      where team_id = ${scopeId} and role in ('owner', 'manager')
      union
      select id from users
      where is_admin and id = any(${memberIds}::bigint[])
    `.execute(db)
    raw = rows.map(row => Number(row.userId))
  } else if (conversation.kind.startsWith('season')) {
    raw = await seasonStaffIds(db, [scopeId])
  } else {
    const rows = await db
      .selectFrom('scope_roles')
      .select(['user_id'])
      .where('scope_type', '=', 'league')
      .where('scope_id', '=', scopeId)
      .where('role', '=', 'admin')
      .execute()
    raw = rows.map(row => row.user_id)
  }
  return new Set((await survivors(db, raw)).values())
}

/**
 * Whether `userId` approves history for a member whose identity was reset
 * in this conversation: a moderator in `teamMembers`, `teamFans` and
 * `seasonAnnouncements`, any member in every other kind.
 */
export async function isApprover(
  db: Kysely<Database>,
  conversation: { kind: ChatKind; scope_id: string | null },
  userId: number
): Promise<boolean> {
  if (!MODERATED_APPROVALS.includes(conversation.kind)) return true
  return (await moderatorsOf(db, conversation, [userId])).has(userId)
}

const ROLE_WORDS: Record<string, string> = {
  admin: 'Admin',
  coach: 'Coach',
  scorekeeper: 'Scorekeeper',
  songkeeper: 'Songkeeper',
  videographer: 'Videographer'
}

/** How each member stands in a conversation, such as "Coach · Guardian". */
async function labelsOf(
  db: Kysely<Database>,
  conversation: {
    kind: ChatKind
    scope_type: string | null
    scope_id: string | null
  },
  memberIds: number[],
  now: Date
): Promise<Map<number, string>> {
  const parts = new Map<number, string[]>(memberIds.map(id => [id, []]))
  const add = (id: number | undefined, part: string): void => {
    if (id == null) return
    const list = parts.get(id)
    if (list != null && !list.includes(part)) list.push(part)
  }
  const resolve = async <R extends { user_id: number }>(
    rows: R[],
    part: (row: R) => string
  ): Promise<void> => {
    const survivorOf = await survivors(
      db,
      rows.map(row => row.user_id)
    )
    for (const row of rows) add(survivorOf.get(row.user_id), part(row))
  }
  const scopeId = conversation.scope_id

  if (conversation.scope_type === 'team' && scopeId != null) {
    await resolve(
      await db
        .selectFrom('memberships')
        .select(['user_id'])
        .where('team_id', '=', scopeId)
        .where('role', 'in', ['owner', 'manager'])
        .execute(),
      () => 'Admin'
    )
    await resolve(
      await db
        .selectFrom('scope_roles')
        .select(['user_id', 'role'])
        .where('scope_type', '=', 'team')
        .where('scope_id', '=', scopeId)
        .execute(),
      row => ROLE_WORDS[row.role] ?? 'Staff'
    )
    await resolve(
      await db
        .selectFrom('memberships')
        .select(['user_id'])
        .where('team_id', '=', scopeId)
        .where('is_player', '=', true)
        .execute(),
      () => 'Player'
    )
    await resolve(
      (await teamGuardianRows(db, [scopeId])).map(id => ({ user_id: id })),
      () => 'Guardian'
    )
    await resolve(
      await db
        .selectFrom('team_follows')
        .select(['user_id'])
        .where('team_id', '=', scopeId)
        .execute(),
      () => 'Fan'
    )
  } else if (conversation.scope_type === 'season' && scopeId != null) {
    const season = await db
      .selectFrom('seasons')
      .select(['league_id'])
      .where('id', '=', scopeId)
      .executeTakeFirst()
    if (season?.league_id != null) {
      await resolve(
        await db
          .selectFrom('scope_roles')
          .select(['user_id'])
          .where('scope_type', '=', 'league')
          .where('scope_id', '=', season.league_id)
          .execute(),
        () => 'League'
      )
    }
    await resolve(
      await db
        .selectFrom('scope_roles')
        .select(['user_id'])
        .where('scope_type', '=', 'season')
        .where('scope_id', '=', scopeId)
        .execute(),
      () => 'Season staff'
    )
    const teams = await db
      .selectFrom('season_teams')
      .innerJoin('teams', 'teams.id', 'season_teams.team_id')
      .select(['teams.id', 'teams.name'])
      .where('season_teams.season_id', '=', scopeId)
      .execute()
    const teamIds = teams.map(team => team.id)
    const teamName = new Map(teams.map(team => [team.id, team.name]))
    if (teamIds.length > 0) {
      await resolve(
        await db
          .selectFrom('memberships')
          .select(['user_id', 'team_id'])
          .where('team_id', 'in', teamIds)
          .where('role', 'in', ['owner', 'manager'])
          .execute(),
        row => `Admin · ${teamName.get(row.team_id) ?? ''}`
      )
      await resolve(
        await db
          .selectFrom('scope_roles')
          .select(['user_id', 'scope_id', 'role'])
          .where('scope_type', '=', 'team')
          .where('scope_id', 'in', teamIds)
          .where('role', '<>', 'videographer')
          .execute(),
        row =>
          `${ROLE_WORDS[row.role] ?? 'Staff'} · ${teamName.get(row.scope_id) ?? ''}`
      )
      await resolve(
        await db
          .selectFrom('memberships')
          .select(['user_id', 'team_id'])
          .where('team_id', 'in', teamIds)
          .where('is_player', '=', true)
          .execute(),
        row => `Player · ${teamName.get(row.team_id) ?? ''}`
      )
    }
  } else if (conversation.scope_type === 'league' && scopeId != null) {
    await resolve(
      await db
        .selectFrom('scope_roles')
        .select(['user_id', 'role'])
        .where('scope_type', '=', 'league')
        .where('scope_id', '=', scopeId)
        .execute(),
      row => ROLE_WORDS[row.role] ?? 'League'
    )
  } else {
    const facts = new DmFacts(db, now)
    const players = await facts.playersAmong(memberIds)
    for (const id of players) add(id, 'Player')
    for (const playerId of players) {
      const { guardians, family } = await facts.relativesOf(playerId)
      for (const id of guardians) add(id, 'Guardian')
      for (const id of family) add(id, 'Family')
      for (const id of await facts.staffOf(playerId)) add(id, 'Staff')
    }
  }
  return new Map(
    [...parts].map(([id, list]) => [
      id,
      list.length === 0 ? 'Member' : list.join(' · ')
    ])
  )
}

/** A conversation's current members, as `GET …/members` lists them. */
export async function membersOf(
  db: Kysely<Database>,
  space: MediaContext['space'],
  conversationId: string,
  now: Date = new Date()
): Promise<ChatMember[]> {
  const conversation = await db
    .selectFrom('chat_conversations')
    .select(['kind', 'scope_type', 'scope_id'])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow()
  const members = (
    await db
      .selectFrom('chat_members')
      .select(['user_id'])
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .execute()
  ).map(row => row.user_id)
  if (members.length === 0) return []
  const people = await chatPeople(db, space, members)
  const moderators = await moderatorsOf(db, conversation, members)
  const labels = await labelsOf(db, conversation, members, now)
  const identities = await db
    .selectFrom('chat_identities')
    .leftJoin('chat_user_keys', join =>
      join
        .onRef('chat_user_keys.identity_id', '=', 'chat_identities.id')
        .onRef('chat_user_keys.user_id', '=', 'chat_identities.user_id')
    )
    .select([
      'chat_identities.user_id as userId',
      'chat_identities.identity_public_key as key',
      eb => eb.fn.max('chat_user_keys.generation').as('generation')
    ])
    .where('chat_identities.user_id', 'in', members)
    .where('chat_identities.replaced_at', 'is', null)
    .groupBy(['chat_identities.user_id', 'chat_identities.identity_public_key'])
    .execute()
  const identityOf = new Map(identities.map(row => [row.userId, row]))
  const waiting = new Set(
    (
      await db
        .selectFrom('chat_grant_requests')
        .select(['user_id'])
        .where('conversation_id', '=', conversationId)
        .where('identity_reset', '=', true)
        .where('filled_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute()
    ).map(row => row.user_id)
  )
  const approvalsModerated = MODERATED_APPROVALS.includes(conversation.kind)
  return members
    .map(userId => {
      const person = people.get(userId)
      const identity = identityOf.get(userId)
      const isModerator = moderators.has(userId)
      return {
        userId,
        shortName: person?.shortName ?? String(userId),
        avatarUrl: person?.avatarUrl ?? null,
        label: labels.get(userId) ?? 'Member',
        isModerator,
        isApprover: approvalsModerated ? isModerator : true,
        eligible: identity != null && !waiting.has(userId),
        hasIdentity: identity != null,
        identityKey:
          identity == null
            ? null
            : base64url.stringify(new Uint8Array(identity.key), { pad: false }),
        generation: identity?.generation ?? null
      }
    })
    .sort((a, b) => a.shortName.localeCompare(b.shortName))
}

/** Log rows after `after`, in order, as `GET …/log` answers them. */
export async function logOf(
  db: Kysely<Database>,
  conversationId: string,
  after: number
): Promise<ChatLogRow[]> {
  const rows = await db
    .selectFrom('chat_membership_log')
    .select([
      'seq',
      'event',
      'user_id',
      'actor_user_id',
      'reason',
      'prev_hash',
      'hash',
      'at'
    ])
    .where('conversation_id', '=', conversationId)
    .where('seq', '>', after)
    .orderBy('seq')
    .limit(1000)
    .execute()
  const b64 = (bytes: Uint8Array): string =>
    base64url.stringify(new Uint8Array(bytes), { pad: false })
  return rows.map(row => ({
    seq: Number(row.seq),
    event: row.event,
    userId: row.user_id,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    prevHash: b64(row.prev_hash),
    hash: b64(row.hash),
    at: new Date(row.at).getTime()
  }))
}

/** Every member's read cursor, as `GET …/reads` answers it. */
export async function readsOf(
  db: Kysely<Database>,
  conversationId: string
): Promise<Array<{ userId: number; seq: number }>> {
  const rows = await db
    .selectFrom('chat_read_cursors')
    .innerJoin('chat_members', join =>
      join
        .onRef(
          'chat_members.conversation_id',
          '=',
          'chat_read_cursors.conversation_id'
        )
        .onRef('chat_members.user_id', '=', 'chat_read_cursors.user_id')
    )
    .select(['chat_read_cursors.user_id', 'chat_read_cursors.seq'])
    .where('chat_read_cursors.conversation_id', '=', conversationId)
    .where('chat_members.left_at', 'is', null)
    .orderBy('chat_read_cursors.user_id')
    .execute()
  return rows.map(row => ({ userId: row.user_id, seq: Number(row.seq) }))
}
