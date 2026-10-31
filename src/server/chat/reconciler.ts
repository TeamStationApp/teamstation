import type { Kysely } from 'kysely'

import { compareUserIds } from '../../common/chatCrypto/userId'
import { makeId } from '../../common/ids'
import { asUserId } from '../../common/userId'
import { onePerson } from '../admin/people'
import type { ChangeFeed } from '../changeFeed/feed'
import type { Database } from '../db/database'
import { survivors } from '../teams/teamStaff'
import {
  audienceOf,
  isEligible,
  kindsOf,
  LEAGUE_KINDS,
  type ScopeKind,
  type ScopeType,
  scopeTypeOf,
  SEASON_KINDS,
  TEAM_KINDS
} from './audiences'
import { recheckDm } from './dms'
import {
  currentMembers,
  inTransaction,
  joinMembers,
  leaveMembers,
  notifyChat
} from './membershipLog'

/**
 * Keeps every scope chat's members equal to its audience, and every DM
 * within its rules.
 *
 * Triggers on the roster tables (migration 051) append `chat_dirty` rows —
 * a team, season, league or user whose chats may have changed — and notify
 * `chat_dirty`. The reconciler, in the primary only, takes them with
 * `delete … returning` and expands them into conversations:
 *
 * - a team: its three chats, and the three of every season it plays in;
 * - a season: its three;
 * - a league: its Org chat, and the three of each of its seasons;
 * - every team, season or league mark also re-checks every DM holding a
 *   player of a team in that scope;
 * - a user: every scope chat they are in, those the audiences might now put
 *   them in, and every DM they are in.
 *
 * Each conversation is reconciled in its own transaction holding its row
 * `for update`, which serialises the reconciler with `memberNow` in the
 * workers: a scope chat's audience is diffed with `chat_members`, writing
 * `join` and `leave` rows, opening grant requests for joiners with an
 * identity, flagging `needs_rotation` on a leave, and notifying
 * `chat_changes`. A scope chat is created the first time its audience is not
 * empty. A DM is never diffed with an audience; it is re-checked
 * (`recheckDm`).
 *
 * `ChatReconciler` hears `chat_dirty` on the process's feed, debounces 1 s,
 * drains every mark whenever the feed is first in place or returns, and
 * sweeps hourly: it drains, re-checks every
 * DM, reconciles every conversation, and creates any missing scope chat.
 */

export interface DirtyMark {
  scope_type: ScopeType | 'user'
  scope_id: string
}

export interface ScopeTarget {
  kind: ScopeKind
  scopeId: string
}

export interface Targets {
  scopes: ScopeTarget[]
  dms: string[]
}

export interface Reconciled {
  conversationId: string | null
  joined: string[]
  left: string[]
}

/**
 * Brings one scope chat's members to its audience, creating the chat when
 * the audience is not empty and there is none yet.
 */
export async function reconcileScope(
  db: Kysely<Database>,
  kind: ScopeKind,
  scopeId: string,
  now: Date = new Date()
): Promise<Reconciled> {
  return await inTransaction(db, async trx => {
    const lock = async (): Promise<{ id: string } | undefined> =>
      await trx
        .selectFrom('chat_conversations')
        .select(['id'])
        .where('kind', '=', kind)
        .where('scope_id', '=', scopeId)
        .forUpdate()
        .executeTakeFirst()
    let conversation = await lock()
    if (conversation == null) {
      const audience = await audienceOf(trx, kind, scopeId, now)
      if (audience.size === 0) {
        return { conversationId: null, joined: [], left: [] }
      }
      await trx
        .insertInto('chat_conversations')
        .values({
          id: makeId('conversation'),
          kind,
          scope_type: scopeTypeOf(kind),
          scope_id: scopeId
        })
        .onConflict(oc =>
          oc
            .columns(['scope_id', 'kind'])
            .where('scope_id', 'is not', null)
            .doNothing()
        )
        .execute()
      conversation = await lock()
      if (conversation == null) throw new Error(`no ${kind} for ${scopeId}`)
    }
    // Read under the lock, so whoever held it before has written.
    const audience = await audienceOf(trx, kind, scopeId, now)
    const current = await currentMembers(trx, conversation.id)
    const joined = [...audience]
      .filter(id => !current.includes(id))
      .sort(compareUserIds)
    const left = current.filter(id => !audience.has(id))
    if (joined.length === 0 && left.length === 0) {
      return { conversationId: conversation.id, joined, left }
    }
    await leaveMembers(trx, conversation.id, left, null, 'audience', now)
    await joinMembers(trx, conversation.id, joined, null, 'audience', now)
    await notifyChat(trx, conversation.id, 'members')
    return { conversationId: conversation.id, joined, left }
  })
}

/** Reconciles any conversation by id: a scope chat or a DM. */
export async function reconcileConversation(
  db: Kysely<Database>,
  conversationId: string,
  now: Date = new Date()
): Promise<void> {
  const row = await db
    .selectFrom('chat_conversations')
    .select(['kind', 'scope_id'])
    .where('id', '=', conversationId)
    .executeTakeFirst()
  if (row == null) return
  if (row.kind === 'dm' || row.scope_id == null) {
    await recheckDm(db, conversationId, now)
    return
  }
  await reconcileScope(db, row.kind, row.scope_id, now)
}

const key = (target: ScopeTarget): string => `${target.kind}:${target.scopeId}`

/** The conversations a batch of marks reaches. */
export async function targetsOf(
  db: Kysely<Database>,
  marks: DirtyMark[]
): Promise<Targets> {
  const scopes = new Map<string, ScopeTarget>()
  const dms = new Set<string>()
  const addScope = (kind: ScopeKind, scopeId: string): void => {
    scopes.set(key({ kind, scopeId }), { kind, scopeId })
  }

  const marked = (type: DirtyMark['scope_type']): string[] => [
    ...new Set(
      marks.filter(mark => mark.scope_type === type).map(mark => mark.scope_id)
    )
  ]
  const userTeams = new Set<string>()
  const userSeasons = new Set<string>()
  const userLeagues = new Set<string>()
  for (const userText of marked('user')) {
    let userId: string
    try {
      userId = asUserId(userText)
    } catch {
      continue
    }
    const person = await onePerson(db, userId)
    const rows = [...new Set([userId, ...person.userIds])]
    const memberships = await db
      .selectFrom('memberships')
      .select(['team_id'])
      .where('user_id', 'in', rows)
      .execute()
    for (const row of memberships) userTeams.add(row.team_id)
    const follows = await db
      .selectFrom('team_follows')
      .select(['team_id'])
      .where('user_id', 'in', rows)
      .execute()
    for (const row of follows) userTeams.add(row.team_id)
    const roles = await db
      .selectFrom('scope_roles')
      .select(['scope_type', 'scope_id'])
      .where('user_id', 'in', rows)
      .execute()
    for (const row of roles) {
      if (row.scope_type === 'team') userTeams.add(row.scope_id)
      if (row.scope_type === 'season') userSeasons.add(row.scope_id)
      if (row.scope_type === 'league') userLeagues.add(row.scope_id)
    }
    // Each child as the row they now are: a link names the row they had.
    const wards = await db
      .selectFrom('user_links')
      .select(['related_user_id'])
      .where('user_id', 'in', rows)
      .where('kind', '=', 'guardian')
      .execute()
    const children = await survivors(
      db,
      wards.map(row => row.related_user_id)
    )
    if (children.size > 0) {
      const played = await db
        .selectFrom('memberships')
        .select(['team_id'])
        .where('user_id', 'in', [...new Set(children.values())])
        .where('is_player', '=', true)
        .execute()
      for (const row of played) userTeams.add(row.team_id)
    }
    const seasonMembers = await db
      .selectFrom('season_members')
      .select(['season_id'])
      .where('user_id', 'in', rows)
      .execute()
    for (const row of seasonMembers) userSeasons.add(row.season_id)
    const leagueMembers = await db
      .selectFrom('league_members')
      .select(['league_id'])
      .where('user_id', 'in', rows)
      .execute()
    for (const row of leagueMembers) userLeagues.add(row.league_id)
    const chats = await db
      .selectFrom('chat_members')
      .innerJoin(
        'chat_conversations',
        'chat_conversations.id',
        'chat_members.conversation_id'
      )
      .select([
        'chat_conversations.id',
        'chat_conversations.kind',
        'chat_conversations.scope_id'
      ])
      .where('chat_members.user_id', 'in', rows)
      .where('chat_members.left_at', 'is', null)
      .execute()
    for (const chat of chats) {
      if (chat.kind === 'dm' || chat.scope_id == null) dms.add(chat.id)
      else addScope(chat.kind, chat.scope_id)
    }
  }

  const teams = new Set([...marked('team'), ...userTeams])
  const seasons = new Set([...marked('season'), ...userSeasons])
  const leagues = new Set([...marked('league'), ...userLeagues])

  // A league's seasons, and a team's.
  const leagueSeasons = await seasonsOfLeagues(db, [...leagues])
  const teamSeasons = await seasonsOfTeams(db, [...teams])
  for (const team of teams) for (const kind of TEAM_KINDS) addScope(kind, team)
  for (const season of [...seasons, ...leagueSeasons, ...teamSeasons]) {
    for (const kind of SEASON_KINDS) addScope(kind, season)
  }
  for (const league of leagues) {
    for (const kind of LEAGUE_KINDS) addScope(kind, league)
  }

  // DMs holding a player of a team in a marked scope (not a user's scopes:
  // a user's own DMs are re-checked above).
  const scopeSeasons = [
    ...marked('season'),
    ...(await seasonsOfLeagues(db, marked('league')))
  ]
  const scopeTeams = new Set(marked('team'))
  if (scopeSeasons.length > 0) {
    const rows = await db
      .selectFrom('season_teams')
      .select(['team_id'])
      .where('season_id', 'in', scopeSeasons)
      .execute()
    for (const row of rows) scopeTeams.add(row.team_id)
  }
  for (const id of await dmsWithPlayersOf(db, [...scopeTeams])) dms.add(id)

  return { scopes: [...scopes.values()], dms: [...dms].sort() }
}

async function seasonsOfLeagues(
  db: Kysely<Database>,
  leagueIds: string[]
): Promise<string[]> {
  if (leagueIds.length === 0) return []
  const rows = await db
    .selectFrom('seasons')
    .select(['id'])
    .where('league_id', 'in', leagueIds)
    .execute()
  return rows.map(row => row.id)
}

async function seasonsOfTeams(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const rows = await db
    .selectFrom('season_teams')
    .select(['season_id'])
    .where('team_id', 'in', teamIds)
    .execute()
  return [...new Set(rows.map(row => row.season_id))]
}

/** DMs with a current member who plays on one of these teams. */
async function dmsWithPlayersOf(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const rows = await db
    .selectFrom('chat_members')
    .innerJoin(
      'chat_conversations',
      'chat_conversations.id',
      'chat_members.conversation_id'
    )
    .innerJoin('memberships', 'memberships.user_id', 'chat_members.user_id')
    .select(['chat_conversations.id'])
    .distinct()
    .where('chat_conversations.kind', '=', 'dm')
    .where('chat_members.left_at', 'is', null)
    .where('memberships.team_id', 'in', teamIds)
    .where('memberships.is_player', '=', true)
    .execute()
  return rows.map(row => row.id)
}

/**
 * Reconciles everything a batch of marks reaches. Throws after trying them
 * all when any failed, so the caller can put the marks back.
 */
export async function processMarks(
  db: Kysely<Database>,
  marks: DirtyMark[],
  now: Date,
  log: (message: string) => void = () => undefined
): Promise<Targets> {
  const targets = await targetsOf(db, marks)
  let failed = 0
  for (const target of targets.scopes) {
    try {
      await reconcileScope(db, target.kind, target.scopeId, now)
    } catch (error) {
      failed += 1
      log(`reconciling ${target.kind} ${target.scopeId}: ${String(error)}`)
    }
  }
  for (const id of targets.dms) {
    try {
      await recheckDm(db, id, now)
    } catch (error) {
      failed += 1
      log(`re-checking DM ${id}: ${String(error)}`)
    }
  }
  if (failed > 0) throw new Error(`${failed} conversation(s) failed`)
  return targets
}

/**
 * Takes every mark there is and reconciles what they reach. The queue is
 * append-only (088chatDirtyQueue), so a scope marked many times while the
 * reconciler was behind is coalesced here and read once. Marks appended
 * while it drains are left for the next drain. On a failure the marks go
 * back, once each (without a notify, so a broken conversation is retried by
 * the next notify or the sweep rather than in a loop). Answers how many
 * scopes were taken.
 */
export async function drainDirty(
  db: Kysely<Database>,
  now: Date,
  log: (message: string) => void = () => undefined
): Promise<number> {
  const taken = await db
    .deleteFrom('chat_dirty')
    .returning(['scope_type', 'scope_id'])
    .execute()
  const marks = distinctMarks(taken)
  if (marks.length === 0) return 0
  try {
    await processMarks(db, marks, now, log)
  } catch (error) {
    await db.insertInto('chat_dirty').values(marks).execute()
    throw error
  }
  return marks.length
}

/** Each scope once, in the order it was first marked. */
export function distinctMarks<
  T extends { scope_type: string; scope_id: string }
>(marks: readonly T[]): T[] {
  const seen = new Set<string>()
  return marks.filter(mark => {
    const key = `${mark.scope_type}:${mark.scope_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The hourly pass: drains the marks, re-checks every DM, reconciles every
 * conversation, and creates any missing scope chat for every unmerged full
 * team, every season and every league. It is also what lets a player who
 * turns 13 in, on the first of the month after their birth month.
 */
export async function sweep(
  db: Kysely<Database>,
  now: Date,
  log: (message: string) => void = () => undefined
): Promise<void> {
  await drainDirty(db, now, log)
  const dms = await db
    .selectFrom('chat_conversations')
    .select(['id'])
    .where('kind', '=', 'dm')
    .orderBy('id')
    .execute()
  const failures: string[] = []
  for (const dm of dms) {
    try {
      await recheckDm(db, dm.id, now)
    } catch (error) {
      failures.push(`DM ${dm.id}: ${String(error)}`)
    }
  }
  const scopes = new Map<string, ScopeTarget>()
  const add = (kind: ScopeKind, scopeId: string): void => {
    scopes.set(key({ kind, scopeId }), { kind, scopeId })
  }
  const existing = await db
    .selectFrom('chat_conversations')
    .select(['kind', 'scope_id'])
    .where('kind', '<>', 'dm')
    .execute()
  for (const row of existing) {
    if (row.kind !== 'dm' && row.scope_id != null) add(row.kind, row.scope_id)
  }
  const teams = await db
    .selectFrom('teams')
    .select(['id'])
    .where('kind', '=', 'full')
    .where('merged_into', 'is', null)
    .execute()
  for (const team of teams)
    for (const kind of kindsOf('team')) add(kind, team.id)
  const seasons = await db.selectFrom('seasons').select(['id']).execute()
  for (const season of seasons) {
    for (const kind of kindsOf('season')) add(kind, season.id)
  }
  const leagues = await db.selectFrom('leagues').select(['id']).execute()
  for (const league of leagues) {
    for (const kind of kindsOf('league')) add(kind, league.id)
  }
  for (const target of scopes.values()) {
    try {
      await reconcileScope(db, target.kind, target.scopeId, now)
    } catch (error) {
      failures.push(`${target.kind} ${target.scopeId}: ${String(error)}`)
    }
  }
  for (const failure of failures) log(`sweep: ${failure}`)
}

/** The marks that could change whether `userId` belongs in a conversation. */
async function marksFor(
  db: Kysely<Database>,
  conversation: {
    kind: string
    scope_type: string | null
    scope_id: string | null
  },
  userId: string
): Promise<DirtyMark[]> {
  const keys: DirtyMark[] = [{ scope_type: 'user', scope_id: String(userId) }]
  const scopeId = conversation.scope_id
  if (scopeId != null) {
    if (conversation.scope_type === 'team') {
      keys.push({ scope_type: 'team', scope_id: scopeId })
      const seasons = await db
        .selectFrom('season_teams')
        .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
        .select(['seasons.id', 'seasons.league_id'])
        .where('season_teams.team_id', '=', scopeId)
        .execute()
      for (const season of seasons) {
        keys.push({ scope_type: 'season', scope_id: season.id })
        if (season.league_id != null) {
          keys.push({ scope_type: 'league', scope_id: season.league_id })
        }
      }
    } else if (conversation.scope_type === 'season') {
      keys.push({ scope_type: 'season', scope_id: scopeId })
      const season = await db
        .selectFrom('seasons')
        .select(['league_id'])
        .where('id', '=', scopeId)
        .executeTakeFirst()
      if (season?.league_id != null) {
        keys.push({ scope_type: 'league', scope_id: season.league_id })
      }
      const teams = await db
        .selectFrom('season_teams')
        .select(['team_id'])
        .where('season_id', '=', scopeId)
        .execute()
      for (const team of teams) {
        keys.push({ scope_type: 'team', scope_id: team.team_id })
      }
    } else {
      keys.push({ scope_type: 'league', scope_id: scopeId })
    }
  }
  const held = await db
    .selectFrom('chat_dirty')
    .select(['scope_type', 'scope_id'])
    .where(eb =>
      eb.or(
        keys.map(mark =>
          eb.and([
            eb('scope_type', '=', mark.scope_type),
            eb('scope_id', '=', mark.scope_id)
          ])
        )
      )
    )
    .execute()
  return held
}

/**
 * Whether `userId` is in the conversation now. When a `chat_dirty` mark
 * touches it, that one conversation is reconciled first (leaving the mark
 * for the reconciler), so a new invitee is not refused in the second before
 * the reconciler runs. Somebody who is no longer eligible is never a member.
 */
export async function memberNow(
  db: Kysely<Database>,
  conversationId: string,
  userId: string,
  now: Date = new Date()
): Promise<boolean> {
  const conversation = await db
    .selectFrom('chat_conversations')
    .select(['id', 'kind', 'scope_type', 'scope_id'])
    .where('id', '=', conversationId)
    .executeTakeFirst()
  if (conversation == null) return false
  const marks = await marksFor(db, conversation, userId)
  if (marks.length > 0) await reconcileConversation(db, conversationId, now)
  const member = await db
    .selectFrom('chat_members')
    .select(['user_id'])
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .where('left_at', 'is', null)
    .executeTakeFirst()
  if (member == null) return false
  return await isEligible(db, userId, now)
}

export interface ChatReconcilerOptions {
  db: Kysely<Database>
  /** The process's feed, on the same database as `db`. */
  feed: ChangeFeed
  /** Notifies within this long are drained once. */
  debounceMs?: number
  /** How often the sweep runs. */
  sweepMs?: number
  now?: () => Date
  log?: (message: string) => void
}

export const CHAT_DIRTY_CHANNEL = 'chat_dirty'

/** The primary's reconciler: hears `chat_dirty`, drains, and the sweep. */
export class ChatReconciler {
  /** Settles once the channel is first in place, or that attempt has failed, and any drain has run. */
  readonly listening: Promise<void>
  private readonly db: Kysely<Database>
  private readonly debounceMs: number
  private readonly now: () => Date
  private readonly log: (message: string) => void
  private readonly stopListening: () => void
  private debounce: ReturnType<typeof setTimeout> | undefined
  private readonly sweepTimer: ReturnType<typeof setInterval>
  /** Work runs one piece at a time, in order. */
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: ChatReconcilerOptions) {
    this.db = options.db
    this.debounceMs = options.debounceMs ?? 1000
    this.now = options.now ?? (() => new Date())
    this.log =
      options.log ??
      (message => {
        console.error(`chat reconciler: ${message}`)
      })
    this.sweepTimer = setInterval(
      () => {
        this.sweep().catch(() => undefined)
      },
      options.sweepMs ?? 60 * 60 * 1000
    )
    this.sweepTimer.unref?.()
    const subscription = options.feed.subscribe(CHAT_DIRTY_CHANNEL, {
      onPayload: () => {
        this.notified()
      },
      // Whatever was marked while nobody listened.
      onListening: () => {
        this.drain().catch(() => undefined)
      }
    })
    this.stopListening = subscription.stop
    this.listening = subscription.listening.then(async () => {
      await this.queue
    })
  }

  /** Takes and reconciles every mark there is now. */
  async drain(): Promise<void> {
    await this.enqueue(async () => {
      await drainDirty(this.db, this.now(), this.log)
    })
  }

  /** The hourly pass, now. */
  async sweep(): Promise<void> {
    await this.enqueue(async () => {
      await sweep(this.db, this.now(), this.log)
    })
  }

  /** A `chat_dirty` notify: drains once the debounce is up. */
  notified(): void {
    if (this.closed || this.debounce != null) return
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      this.drain().catch(() => undefined)
    }, this.debounceMs)
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopListening()
    clearTimeout(this.debounce)
    clearInterval(this.sweepTimer)
    await this.queue
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.closed) return
      try {
        await work()
      } catch (error) {
        this.log(String(error))
      }
    })
    this.queue = next
    await next
  }
}

/** Starts the reconciler where `src/server/index.ts` starts the purge. */
export function startChatReconciler(
  db: Kysely<Database>,
  feed: ChangeFeed
): ChatReconciler {
  return new ChatReconciler({ db, feed })
}
