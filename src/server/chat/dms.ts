import { type Kysely, sql } from 'kysely'

import { ageOn } from '../../common/age'
import { compareUserIds } from '../../common/chatCrypto/userId'
import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import { openAddTeams } from '../access'
import type { Database } from '../db/database'
import { rowsOfPeople, survivors } from '../teams/teamStaff'
import {
  audienceOf,
  fullTeams,
  isUnder13,
  leagueRoleIds,
  NAMING_KINDS,
  seasonStaffIds,
  teamStaffIds
} from './audiences'
import {
  closeConversation,
  currentMembers,
  inTransaction,
  joinMembers,
  leaveMembers,
  notifyChat
} from './membershipLog'

/**
 * Direct messages: who may name whom, the pair rule, and the MAAPP rule.
 *
 * **Naming.** The server checks the creator against each person they name,
 * and an adder against each person added; anything else is `notCandidate`.
 *
 * - A **player with an account** P (an `is_player` membership, an account,
 *   and not under 13) may be named only by P's guardians, P's staff (team
 *   staff of P's teams, season staff of their seasons, role holders on
 *   those seasons' leagues), and another player with an account who shares
 *   a season (or a team) with P.
 * - A **fan of T** who shares no Staff, Members, Season Staff, All Staff or
 *   Org chat with the creator may be named by T's team staff, the All Staff
 *   of a season T plays in (season staff included), and role holders on its
 *   league.
 * - A **guardian of P**, and **P's staff**, may always be named by P: naming
 *   between a player and their staff goes both ways.
 * - **Anyone else** may be named by someone they share one of those five
 *   chats with.
 * - **Included adults** for a player in the DM may be named by anyone who
 *   may name that player, for that DM.
 *
 * Nobody who is not eligible (an account, not under 13) names or is named.
 * So a person whose only tie is a follow names nobody: they share none of
 * those chats, and are nobody's staff.
 *
 * **The pair rule.** For every player with an account P in a DM, every other
 * member is P's staff, a player with an account sharing a season with P, or
 * P's guardian or adult family member. A refusal is `notCandidate`.
 *
 * **The MAAPP rule.** For a covered player P (under 18 by the age rule, or
 * with no birth month, on a team in a season of a league with
 * `safesport_lao`) and every adult A in the DM who is not P's guardian or
 * adult family member, the DM also holds an included adult for P other than
 * A. An adult is anyone who is not a player, or a player 18 or older whose
 * birth month is more than 48 months before P's (any 18-or-older player when
 * P has no birth month); a player with no birth month never is. Included
 * adults are P's guardians, P's adult family members, and the adults among
 * P's staff. A refusal is `conflict` with `adultRequired` and `playerIds`.
 */

/** A DM is created with 2 to 20 members and never grows past 20. */
export const DM_MAX_MEMBERS = 20

/** The close-in-age exception: no more than 4 years older. */
const CLOSE_IN_AGE_MONTHS = 48

interface UserRow {
  id: string
  account: boolean
  birthYear: number | null
  birthMonth: number | null
}

/** Why a DM's membership is not allowed. */
export interface RuleBreak {
  rule: 'pairRule' | 'adultRequired'
  playerIds: string[]
}

/**
 * What the DM rules need to know about people, read once per request or
 * transaction and kept.
 */
export class DmFacts {
  private readonly rows = new Map<string, UserRow | null>()
  private readonly teams = new Map<string, string[]>()
  private readonly seasons = new Map<string, string[]>()
  private readonly staff = new Map<string, Set<string>>()
  private readonly kin = new Map<
    string,
    { guardians: Set<string>; family: Set<string> }
  >()

  constructor(
    readonly db: Kysely<Database>,
    readonly now: Date
  ) {}

  /** Reads these users' rows at once, for the checks that follow. */
  async load(userIds: string[]): Promise<void> {
    const missing = [...new Set(userIds)].filter(id => !this.rows.has(id))
    if (missing.length === 0) return
    const rows = await this.db
      .selectFrom('users')
      .select([
        'id',
        'merged_into',
        'login_enabled',
        'disabled_at',
        'birth_year',
        'birth_month'
      ])
      .where('id', 'in', missing)
      .execute()
    for (const id of missing) this.rows.set(id, null)
    for (const row of rows) {
      this.rows.set(row.id, {
        id: row.id,
        account:
          row.merged_into == null &&
          row.disabled_at == null &&
          row.login_enabled,
        birthYear: row.birth_year,
        birthMonth: row.birth_month
      })
    }
    const players = await this.db
      .selectFrom('memberships')
      .select(['user_id', 'team_id'])
      .where('user_id', 'in', missing)
      .where('is_player', '=', true)
      .execute()
    for (const id of missing) this.teams.set(id, [])
    for (const row of players) this.teams.get(row.user_id)?.push(row.team_id)
  }

  private async row(userId: string): Promise<UserRow | null> {
    await this.load([userId])
    return this.rows.get(userId) ?? null
  }

  /** An account, and not under 13. */
  async eligible(userId: string): Promise<boolean> {
    const row = await this.row(userId)
    return (
      row != null &&
      row.account &&
      !isUnder13(row.birthYear, row.birthMonth, this.now)
    )
  }

  /** The teams this person plays on. */
  async playerTeams(userId: string): Promise<string[]> {
    await this.load([userId])
    return this.teams.get(userId) ?? []
  }

  /**
   * The teams that stand to this person as theirs: not one holding them only
   * by an add their side may still reject. A message cannot be unsent, so
   * such a team is nobody's staff, however the rest of chat counts them a
   * player.
   */
  async settledTeams(userId: string): Promise<string[]> {
    const teams = await this.playerTeams(userId)
    if (teams.length === 0) return teams
    const held = await openAddTeams(
      this.db,
      await rowsOfPeople(this.db, [userId])
    )
    return teams.filter(team => !held.includes(team))
  }

  async isPlayer(userId: string): Promise<boolean> {
    return (await this.playerTeams(userId)).length > 0
  }

  /** A player who is an account and not under 13. */
  async playerWithAccount(userId: string): Promise<boolean> {
    return (await this.isPlayer(userId)) && (await this.eligible(userId))
  }

  /** The seasons these teams play in. */
  async seasonsOf(teamIds: string[]): Promise<string[]> {
    const missing = teamIds.filter(id => !this.seasons.has(id))
    if (missing.length > 0) {
      const rows = await this.db
        .selectFrom('season_teams')
        .select(['season_id', 'team_id'])
        .where('team_id', 'in', missing)
        .execute()
      for (const id of missing) this.seasons.set(id, [])
      for (const row of rows) this.seasons.get(row.team_id)?.push(row.season_id)
    }
    return [...new Set(teamIds.flatMap(id => this.seasons.get(id) ?? []))]
  }

  /**
   * P's staff: team staff of every team P plays on, the season staff of
   * every season those teams are in, and role holders on those seasons'
   * leagues (part of season staff). Survivors, eligible or not.
   */
  async staffOf(playerId: string): Promise<Set<string>> {
    const held = this.staff.get(playerId)
    if (held != null) return held
    const teams = await this.settledTeams(playerId)
    const seasons = await this.seasonsOf(teams)
    const raw = [
      ...(await teamStaffIds(this.db, teams)),
      ...(await seasonStaffIds(this.db, seasons))
    ]
    const staff = new Set((await survivors(this.db, raw)).values())
    this.staff.set(playerId, staff)
    return staff
  }

  /**
   * P's immediate coaches: direct `admin` or `coach` on a team P plays on,
   * owners and managers included. Survivors.
   */
  async coachesOf(playerId: string): Promise<Set<string>> {
    const teams = await this.settledTeams(playerId)
    if (teams.length === 0) return new Set()
    const roles = await this.db
      .selectFrom('scope_roles')
      .select(['user_id'])
      .where('scope_type', '=', 'team')
      .where('scope_id', 'in', teams)
      .where('role', 'in', ['admin', 'coach'])
      .execute()
    const owners = await this.db
      .selectFrom('memberships')
      .select(['user_id'])
      .where('team_id', 'in', teams)
      .where('role', 'in', ['owner', 'manager'])
      .execute()
    const survivorOf = await survivors(
      this.db,
      [...roles, ...owners].map(row => row.user_id)
    )
    return new Set(survivorOf.values())
  }

  /** P's guardians and adult family members who are eligible. */
  async relativesOf(
    playerId: string
  ): Promise<{ guardians: Set<string>; family: Set<string> }> {
    const held = this.kin.get(playerId)
    if (held != null) return held
    // Every row that is the player: a link names the row they had when it
    // was made.
    const rows = await this.db
      .selectFrom('user_links')
      .select(['user_id', 'kind'])
      .where('related_user_id', 'in', await rowsOfPeople(this.db, [playerId]))
      .where('kind', 'in', ['guardian', 'family'])
      .execute()
    const survivorOf = await survivors(
      this.db,
      rows.map(row => row.user_id)
    )
    const guardians = new Set<string>()
    const family = new Set<string>()
    for (const row of rows) {
      const id = survivorOf.get(row.user_id)
      if (id == null || id === playerId || !(await this.eligible(id))) continue
      if (row.kind === 'guardian') guardians.add(id)
      else family.add(id)
    }
    for (const id of guardians) family.delete(id)
    const kin = { guardians, family }
    this.kin.set(playerId, kin)
    return kin
  }

  /** Whether two players share a team or a season. */
  async sharesSeason(a: string, b: string): Promise<boolean> {
    const teamsA = await this.settledTeams(a)
    const teamsB = await this.settledTeams(b)
    if (teamsA.some(team => teamsB.includes(team))) return true
    const seasonsA = await this.seasonsOf(teamsA)
    const seasonsB = await this.seasonsOf(teamsB)
    return seasonsA.some(season => seasonsB.includes(season))
  }

  /** Whether A counts as an adult beside player P, for the MAAPP rule. */
  async isAdultFor(adultId: string, playerId: string): Promise<boolean> {
    if (!(await this.isPlayer(adultId))) return true
    const adult = await this.row(adultId)
    if (adult?.birthYear == null || adult.birthMonth == null) return false
    if (ageOn(adult.birthYear, adult.birthMonth, this.now) < 18) return false
    const player = await this.row(playerId)
    if (player?.birthYear == null || player.birthMonth == null) return true
    const months = (year: number, month: number): number => year * 12 + month
    return (
      months(player.birthYear, player.birthMonth) -
        months(adult.birthYear, adult.birthMonth) >
      CLOSE_IN_AGE_MONTHS
    )
  }

  /**
   * A player with an account who is under 18 (or has no birth month), on a
   * team in a season of a league that is a SafeSport LAO.
   */
  async covered(playerId: string): Promise<boolean> {
    if (!(await this.playerWithAccount(playerId))) return false
    const row = await this.row(playerId)
    if (
      row?.birthYear != null &&
      row.birthMonth != null &&
      ageOn(row.birthYear, row.birthMonth, this.now) >= 18
    ) {
      return false
    }
    const seasons = await this.seasonsOf(await this.playerTeams(playerId))
    if (seasons.length === 0) return false
    const lao = await this.db
      .selectFrom('seasons')
      .innerJoin('leagues', 'leagues.id', 'seasons.league_id')
      .select(['leagues.id'])
      .where('seasons.id', 'in', seasons)
      .where('leagues.safesport_lao', '=', true)
      .executeTakeFirst()
    return lao != null
  }

  /** P's guardians, adult family members, and the adults among P's staff. */
  async includedAdults(playerId: string): Promise<Set<string>> {
    const { guardians, family } = await this.relativesOf(playerId)
    const adults = new Set([...guardians, ...family])
    for (const id of await this.staffOf(playerId)) {
      if (id === playerId) continue
      if (!(await this.eligible(id))) continue
      if (await this.isAdultFor(id, playerId)) adults.add(id)
    }
    return adults
  }

  /** Whether two people share a Staff, Members, Season Staff, All Staff or Org chat. */
  async shareNamingChat(a: string, b: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('chat_members as mine')
      .innerJoin(
        'chat_members as theirs',
        'theirs.conversation_id',
        'mine.conversation_id'
      )
      .innerJoin(
        'chat_conversations',
        'chat_conversations.id',
        'mine.conversation_id'
      )
      .select(['mine.conversation_id'])
      .where('mine.user_id', '=', a)
      .where('theirs.user_id', '=', b)
      .where('mine.left_at', 'is', null)
      .where('theirs.left_at', 'is', null)
      .where('chat_conversations.kind', 'in', [...NAMING_KINDS])
      .executeTakeFirst()
    return row != null
  }

  /**
   * Whether C may name X as a fan of a team: C is the team's staff, in the
   * All Staff of a season it plays in, or holds a role on that season's
   * league.
   */
  async mayNameFan(creatorId: string, fanId: string): Promise<boolean> {
    const follows = await this.db
      .selectFrom('team_follows')
      .select(['team_id'])
      .where('user_id', '=', fanId)
      .execute()
    const teams = await fullTeams(
      this.db,
      follows.map(row => row.team_id)
    )
    if (teams.length === 0) return false
    const staff = await survivors(this.db, await teamStaffIds(this.db, teams))
    if ([...staff.values()].includes(creatorId)) return true
    for (const season of await this.seasonsOf(teams)) {
      const allStaff = await audienceOf(
        this.db,
        'seasonAllStaff',
        season,
        this.now
      )
      if (allStaff.has(creatorId)) return true
    }
    return false
  }

  /** Whether C may name player P. */
  async mayNamePlayer(creatorId: string, playerId: string): Promise<boolean> {
    if (creatorId === playerId) return true
    const { guardians } = await this.relativesOf(playerId)
    if (guardians.has(creatorId)) return true
    if ((await this.staffOf(playerId)).has(creatorId)) return true
    return (
      (await this.playerWithAccount(creatorId)) &&
      (await this.sharesSeason(creatorId, playerId))
    )
  }

  /**
   * Whether C may name X in a DM whose players with accounts are
   * `dmPlayers` (for the included-adult rule).
   */
  async mayName(
    creatorId: string,
    targetId: string,
    dmPlayers: string[] = []
  ): Promise<boolean> {
    if (creatorId === targetId) return false
    if (!(await this.eligible(creatorId))) return false
    if (!(await this.eligible(targetId))) return false
    if (await this.playerWithAccount(targetId)) {
      return await this.mayNamePlayer(creatorId, targetId)
    }
    for (const playerId of dmPlayers) {
      if (playerId === targetId) continue
      if (!(await this.mayNamePlayer(creatorId, playerId))) continue
      if ((await this.includedAdults(playerId)).has(targetId)) return true
    }
    if (await this.playerWithAccount(creatorId)) {
      const { guardians } = await this.relativesOf(creatorId)
      if (guardians.has(targetId)) return true
      // Naming is two-way between a player and their staff: whoever may
      // start a DM with player P, P may start one with them.
      if ((await this.staffOf(creatorId)).has(targetId)) return true
    }
    if (await this.shareNamingChat(creatorId, targetId)) return true
    return await this.mayNameFan(creatorId, targetId)
  }

  /** The players with accounts among these people. */
  async playersAmong(userIds: string[]): Promise<string[]> {
    await this.load(userIds)
    const players: string[] = []
    for (const id of userIds) {
      if (await this.playerWithAccount(id)) players.push(id)
    }
    return players
  }

  /** The players whose pair rule this membership breaks. */
  async pairRuleBreaks(members: string[]): Promise<string[]> {
    const broken: string[] = []
    for (const playerId of await this.playersAmong(members)) {
      const staff = await this.staffOf(playerId)
      const { guardians, family } = await this.relativesOf(playerId)
      for (const other of members) {
        if (other === playerId) continue
        if (staff.has(other) || guardians.has(other) || family.has(other)) {
          continue
        }
        if (
          (await this.playerWithAccount(other)) &&
          (await this.sharesSeason(playerId, other))
        ) {
          continue
        }
        broken.push(playerId)
        break
      }
    }
    return broken
  }

  /** The covered players whose MAAPP rule this membership breaks. */
  async maappBreaks(members: string[]): Promise<string[]> {
    const broken: string[] = []
    for (const playerId of await this.playersAmong(members)) {
      if (!(await this.covered(playerId))) continue
      const { guardians, family } = await this.relativesOf(playerId)
      const included = await this.includedAdults(playerId)
      for (const adult of members) {
        if (adult === playerId) continue
        if (guardians.has(adult) || family.has(adult)) continue
        if (!(await this.isAdultFor(adult, playerId))) continue
        const another = members.some(
          other => other !== adult && other !== playerId && included.has(other)
        )
        if (!another) {
          broken.push(playerId)
          break
        }
      }
    }
    return broken
  }

  /** The first rule this membership breaks, pair rule first. */
  async ruleBreak(members: string[]): Promise<RuleBreak | undefined> {
    const pair = await this.pairRuleBreaks(members)
    if (pair.length > 0) return { rule: 'pairRule', playerIds: pair }
    const maapp = await this.maappBreaks(members)
    if (maapp.length > 0) return { rule: 'adultRequired', playerIds: maapp }
    return undefined
  }
}

/** Refuses with the reason each rule is known by to the client. */
function refuse(broken: RuleBreak): never {
  if (broken.rule === 'pairRule') {
    throw forbidden('Not found', {
      reason: 'notCandidate',
      playerIds: broken.playerIds
    })
  }
  throw conflict('This message needs another adult in it', {
    reason: 'adultRequired',
    playerIds: broken.playerIds
  })
}

/** Checks that `actor` may name each of `named` into `members`. */
async function mustName(
  facts: DmFacts,
  actor: string,
  named: string[],
  members: string[]
): Promise<void> {
  if (!(await facts.eligible(actor))) {
    throw forbidden('Not found', { reason: 'notCandidate', userIds: named })
  }
  const players = await facts.playersAmong(members)
  const refused: string[] = []
  for (const id of named) {
    if (!(await facts.mayName(actor, id, players))) refused.push(id)
  }
  if (refused.length > 0) {
    throw forbidden('Not found', { reason: 'notCandidate', userIds: refused })
  }
}

/** These ids once each, without `self`. */
function uniqueOthers(userIds: string[], self: string): string[] {
  return [...new Set(userIds)].filter(id => id !== self)
}

export interface DmCreated {
  conversationId: string
  created: boolean
}

/**
 * Starts a DM between `creatorId` and `userIds`, or answers the open
 * one-to-one the two already have.
 */
export async function createDm(
  db: Kysely<Database>,
  creatorId: string,
  userIds: string[],
  now: Date = new Date()
): Promise<DmCreated> {
  const others = uniqueOthers(userIds, creatorId)
  if (others.length < 1 || others.length + 1 > DM_MAX_MEMBERS) {
    throw badRequest(
      `A message is between 2 and ${DM_MAX_MEMBERS} people, you included`,
      { reason: 'dmSize' }
    )
  }
  return await inTransaction(db, async trx => {
    const facts = new DmFacts(trx, now)
    const members = [creatorId, ...others]
    await facts.load(members)
    await mustName(facts, creatorId, others, members)
    const broken = await facts.ruleBreak(members)
    if (broken != null) refuse(broken)

    if (others.length === 1) {
      const pair = [creatorId, others[0]].sort(compareUserIds)
      // One one-to-one per pair at a time, however many ask at once.
      await sql`select pg_advisory_xact_lock(hashtext(${`dm:${pair.join(':')}`}))`.execute(
        trx
      )
      const open = await openOneToOne(trx, pair[0], pair[1])
      if (open != null) return { conversationId: open, created: false }
    }

    const conversationId = makeId('conversation')
    await trx
      .insertInto('chat_conversations')
      .values({ id: conversationId, kind: 'dm', created_by: creatorId })
      .execute()
    await joinMembers(trx, conversationId, members, creatorId, 'created', now)
    await notifyChat(trx, conversationId, 'members')
    return { conversationId, created: true }
  })
}

/** The open DM whose members now are exactly these two, if there is one. */
async function openOneToOne(
  trx: Kysely<Database>,
  a: string,
  b: string
): Promise<string | undefined> {
  const { rows } = await sql<{ id: string }>`
    select c.id
    from chat_conversations c
    where c.kind = 'dm'
      and c.closed_at is null
      and (
        select count(*) = 2 and bool_and(m.user_id in (${a}, ${b}))
        from chat_members m
        where m.conversation_id = c.id and m.left_at is null
      )
    order by c.created_at
    limit 1
  `.execute(trx)
  return rows[0]?.id
}

/** Locks a DM's row and answers it, or 404 when it is not a DM. */
async function lockDm(
  trx: Kysely<Database>,
  conversationId: string
): Promise<{ id: string; closed: boolean }> {
  const row = await trx
    .selectFrom('chat_conversations')
    .select(['id', 'closed_at'])
    .where('id', '=', conversationId)
    .where('kind', '=', 'dm')
    .forUpdate()
    .executeTakeFirst()
  if (row == null) throw notFound()
  return { id: row.id, closed: row.closed_at != null }
}

/** Adds people to a DM the adder is in. Adding a member again changes nothing. */
export async function addDmMembers(
  db: Kysely<Database>,
  conversationId: string,
  adderId: string,
  userIds: string[],
  now: Date = new Date()
): Promise<string[]> {
  return await inTransaction(db, async trx => {
    const dm = await lockDm(trx, conversationId)
    const current = await currentMembers(trx, conversationId)
    if (!current.includes(adderId)) throw notFound()
    if (dm.closed) {
      throw conflict('This conversation is closed', { reason: 'closed' })
    }
    const added = uniqueOthers(userIds, adderId).filter(
      id => !current.includes(id)
    )
    if (added.length === 0) return []
    if (current.length + added.length > DM_MAX_MEMBERS) {
      throw badRequest(`A message holds at most ${DM_MAX_MEMBERS} people`, {
        reason: 'dmSize'
      })
    }
    const facts = new DmFacts(trx, now)
    const members = [...current, ...added]
    await facts.load(members)
    await mustName(facts, adderId, added, members)
    const broken = await facts.ruleBreak(members)
    if (broken != null) refuse(broken)
    await joinMembers(trx, conversationId, added, adderId, 'added', now)
    await notifyChat(trx, conversationId, 'members')
    return added
  })
}

/**
 * The caller leaves a DM. Always allowed; when the people left then break
 * the pair rule or the MAAPP rule, the same transaction closes it.
 */
export async function leaveDm(
  db: Kysely<Database>,
  conversationId: string,
  userId: string,
  now: Date = new Date()
): Promise<{ closed: boolean }> {
  return await inTransaction(db, async trx => {
    const dm = await lockDm(trx, conversationId)
    const current = await currentMembers(trx, conversationId)
    if (!current.includes(userId)) throw notFound()
    await leaveMembers(trx, conversationId, [userId], userId, 'left', now)
    let closed = dm.closed
    if (!closed) {
      const facts = new DmFacts(trx, now)
      const remaining = current.filter(id => id !== userId)
      const broken = await facts.ruleBreak(remaining)
      if (broken != null) {
        await closeForBreak(trx, conversationId, broken, userId, now)
        closed = true
      }
    }
    await notifyChat(trx, conversationId, 'members')
    return { closed }
  })
}

async function closeForBreak(
  trx: Kysely<Database>,
  conversationId: string,
  broken: RuleBreak,
  actorUserId: string | null,
  now: Date
): Promise<void> {
  await closeConversation(
    trx,
    conversationId,
    {
      userId: [...broken.playerIds].sort(compareUserIds)[0],
      actorUserId,
      reason: broken.rule
    },
    now
  )
}

/**
 * The reconciler's check of one DM: it removes every member who is no
 * longer eligible (`notEligible`), then closes the DM when those left break
 * the pair rule or the MAAPP rule. It never adds anybody.
 */
export async function recheckDm(
  db: Kysely<Database>,
  conversationId: string,
  now: Date = new Date()
): Promise<{ removed: string[]; closed: boolean }> {
  return await inTransaction(db, async trx => {
    const dm = await lockDm(trx, conversationId)
    const current = await currentMembers(trx, conversationId)
    const facts = new DmFacts(trx, now)
    await facts.load(current)
    const removed: string[] = []
    for (const id of current) {
      if (!(await facts.eligible(id))) removed.push(id)
    }
    await leaveMembers(trx, conversationId, removed, null, 'notEligible', now)
    let closed = false
    if (!dm.closed) {
      const remaining = current.filter(id => !removed.includes(id))
      const broken = await facts.ruleBreak(remaining)
      if (broken != null) {
        await closeForBreak(trx, conversationId, broken, null, now)
        closed = true
      }
    }
    if (removed.length > 0 || closed) {
      await notifyChat(trx, conversationId, 'members')
    }
    return { removed, closed }
  })
}

/**
 * The chat half of a merge (`closeInto`). Keys never move between user ids,
 * so the closed row's sessions and chat devices are revoked, and in each of
 * its open DMs the survivor joins (`merged`, with a grant request when the
 * survivor has an identity) and the closed row leaves (`merged`, which flags
 * a new epoch). The reconciler then re-checks those DMs' rules.
 */
export async function mergeChats(
  db: Kysely<Database>,
  closing: string,
  keeping: string,
  now: Date = new Date()
): Promise<string[]> {
  await db
    .updateTable('auth_sessions')
    .set({ revoked_at: now })
    .where('user_id', '=', closing)
    .where('revoked_at', 'is', null)
    .execute()
  await db
    .updateTable('chat_devices')
    .set({ revoked_at: now, session_id: null })
    .where('user_id', '=', closing)
    .where('revoked_at', 'is', null)
    .execute()
  const dms = await db
    .selectFrom('chat_members')
    .innerJoin(
      'chat_conversations',
      'chat_conversations.id',
      'chat_members.conversation_id'
    )
    .select(['chat_conversations.id'])
    .where('chat_members.user_id', '=', closing)
    .where('chat_members.left_at', 'is', null)
    .where('chat_conversations.kind', '=', 'dm')
    .where('chat_conversations.closed_at', 'is', null)
    .orderBy('chat_conversations.id')
    .execute()
  for (const { id } of dms) {
    await inTransaction(db, async trx => {
      await lockDm(trx, id)
      const current = await currentMembers(trx, id)
      if (!current.includes(keeping)) {
        await joinMembers(trx, id, [keeping], null, 'merged', now)
      }
      await leaveMembers(trx, id, [closing], null, 'merged', now)
      await notifyChat(trx, id, 'members')
    })
  }
  return dms.map(dm => dm.id)
}

export interface Candidate {
  userId: string
  /** How they stand to the player(s), for the included-adult sheet. */
  label?: string
}

/**
 * Everybody `callerId` may name, by the rules above, and could be in a DM
 * with under the pair rule. Empty for a person whose only tie is a follow.
 */
export async function dmCandidateIds(
  db: Kysely<Database>,
  callerId: string,
  now: Date = new Date()
): Promise<string[]> {
  const facts = new DmFacts(db, now)
  if (!(await facts.eligible(callerId))) return []
  const pool = new Set<string>()
  const add = (ids: Iterable<string>): void => {
    for (const id of ids) pool.add(id)
  }

  const coMembers = await db
    .selectFrom('chat_members as mine')
    .innerJoin(
      'chat_members as theirs',
      'theirs.conversation_id',
      'mine.conversation_id'
    )
    .innerJoin(
      'chat_conversations',
      'chat_conversations.id',
      'mine.conversation_id'
    )
    .select(['theirs.user_id'])
    .distinct()
    .where('mine.user_id', '=', callerId)
    .where('mine.left_at', 'is', null)
    .where('theirs.left_at', 'is', null)
    .where('chat_conversations.kind', 'in', [...NAMING_KINDS])
    .execute()
  add(coMembers.map(row => row.user_id))

  // Players the caller is staff, a guardian or a season-mate of, and fans
  // of the teams the caller is staff over.
  const teams = new Set<string>()
  const roles = await db
    .selectFrom('scope_roles')
    .select(['scope_type', 'scope_id'])
    .where('user_id', '=', callerId)
    .execute()
  const owned = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', callerId)
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  for (const row of owned) teams.add(row.team_id)
  const seasons = new Set<string>()
  const leagues = new Set<string>()
  for (const row of roles) {
    if (row.scope_type === 'team') teams.add(row.scope_id)
    if (row.scope_type === 'season') seasons.add(row.scope_id)
    if (row.scope_type === 'league') leagues.add(row.scope_id)
  }
  if (leagues.size > 0) {
    const rows = await db
      .selectFrom('seasons')
      .select(['id'])
      .where('league_id', 'in', [...leagues])
      .execute()
    for (const row of rows) seasons.add(row.id)
  }
  const ownTeams = await facts.settledTeams(callerId)
  for (const season of await facts.seasonsOf([...teams, ...ownTeams])) {
    seasons.add(season)
  }
  for (const team of ownTeams) teams.add(team)
  if (seasons.size > 0) {
    const rows = await db
      .selectFrom('season_teams')
      .select(['team_id'])
      .where('season_id', 'in', [...seasons])
      .execute()
    for (const row of rows) teams.add(row.team_id)
  }
  if (teams.size > 0) {
    const players = await db
      .selectFrom('memberships')
      .select(['user_id'])
      .where('team_id', 'in', [...teams])
      .where('is_player', '=', true)
      .execute()
    add(players.map(row => row.user_id))
    const fans = await db
      .selectFrom('team_follows')
      .select(['user_id'])
      .where('team_id', 'in', [...teams])
      .execute()
    add(fans.map(row => row.user_id))
  }
  // From every row that is the caller; each child is resolved with the rest.
  const wards = await db
    .selectFrom('user_links')
    .select(['related_user_id'])
    .where('user_id', 'in', await rowsOfPeople(db, [callerId]))
    .where('kind', '=', 'guardian')
    .execute()
  add(wards.map(row => row.related_user_id))
  if (await facts.isPlayer(callerId)) {
    const { guardians } = await facts.relativesOf(callerId)
    add(guardians)
    add(await facts.staffOf(callerId))
  }

  const survivorOf = await survivors(db, [...pool])
  const ids = [...new Set(survivorOf.values())].filter(id => id !== callerId)
  await facts.load(ids)
  const named: string[] = []
  for (const id of ids) {
    if (!(await facts.mayName(callerId, id))) continue
    // Somebody the pair rule keeps out of every DM with the caller (a
    // player and a parent who is not theirs) is no candidate either.
    if ((await facts.pairRuleBreaks([callerId, id])).length > 0) continue
    named.push(id)
  }
  return named
}

/**
 * The adults `callerId` may include beside these players, with how each
 * stands to them. Without a search: the players' guardians, adult family
 * members and immediate coaches. With one (`all`): every included adult.
 * Never the caller. The caller must be allowed to name every player.
 */
export async function includedAdultIds(
  db: Kysely<Database>,
  callerId: string,
  playerIds: string[],
  all: boolean,
  now: Date = new Date()
): Promise<Candidate[]> {
  const facts = new DmFacts(db, now)
  await facts.load([callerId, ...playerIds])
  const refused: string[] = []
  for (const playerId of playerIds) {
    if (
      !(await facts.playerWithAccount(playerId)) ||
      !(await facts.mayName(callerId, playerId))
    ) {
      refused.push(playerId)
    }
  }
  if (refused.length > 0) {
    throw forbidden('Not found', { reason: 'notCandidate', userIds: refused })
  }

  const labels = new Map<string, string>()
  const offer = (id: string, label: string): void => {
    if (id === callerId || playerIds.includes(id) || labels.has(id)) return
    labels.set(id, label)
  }
  for (const playerId of playerIds) {
    const { guardians, family } = await facts.relativesOf(playerId)
    for (const id of guardians) offer(id, 'Guardian')
    for (const id of family) offer(id, 'Family')
    const included = await facts.includedAdults(playerId)
    const coaches = await facts.coachesOf(playerId)
    const staffLabels = await staffLabelsFor(db, facts, playerId)
    for (const id of coaches) {
      if (included.has(id)) offer(id, staffLabels.get(id) ?? 'Coach')
    }
    if (!all) continue
    for (const id of included) offer(id, staffLabels.get(id) ?? 'Staff')
  }
  return [...labels].map(([userId, label]) => ({ userId, label }))
}

const ROLE_WORDS: Record<string, string> = {
  admin: 'Admin',
  owner: 'Admin',
  manager: 'Admin',
  coach: 'Coach',
  scorekeeper: 'Scorekeeper',
  songkeeper: 'Songkeeper',
  videographer: 'Videographer'
}

/**
 * How each of a player's staff stands to them: `Coach · Hawks` for a team
 * role, `Season staff`, or `League`. The strongest first.
 */
async function staffLabelsFor(
  db: Kysely<Database>,
  facts: DmFacts,
  playerId: string
): Promise<Map<string, string>> {
  const teams = await facts.settledTeams(playerId)
  const seasons = await facts.seasonsOf(teams)
  const labels = new Map<string, string>()
  const set = async (userId: string, label: string): Promise<void> => {
    const id = (await survivors(db, [userId])).get(userId)
    if (id != null && !labels.has(id)) labels.set(id, label)
  }
  if (teams.length > 0) {
    const names = new Map(
      (
        await db
          .selectFrom('teams')
          .select(['id', 'name'])
          .where('id', 'in', teams)
          .execute()
      ).map(row => [row.id, row.name])
    )
    const owners = await db
      .selectFrom('memberships')
      .select(['user_id', 'team_id', 'role'])
      .where('team_id', 'in', teams)
      .where('role', 'in', ['owner', 'manager'])
      .execute()
    const roles = await db
      .selectFrom('scope_roles')
      .select(['user_id', 'scope_id as team_id', 'role'])
      .where('scope_type', 'in', ['team'])
      .where('scope_id', 'in', teams)
      .execute()
    const order = ['owner', 'manager', 'admin', 'coach', 'scorekeeper']
    const rank = (role: string): number => {
      const at = order.indexOf(role)
      return at < 0 ? order.length : at
    }
    const sorted = [...owners, ...roles].sort(
      (a, b) => rank(a.role) - rank(b.role)
    )
    for (const row of sorted) {
      await set(
        row.user_id,
        `${ROLE_WORDS[row.role] ?? 'Staff'} · ${names.get(row.team_id) ?? ''}`
      )
    }
  }
  if (seasons.length > 0) {
    const seasonRoles = await db
      .selectFrom('scope_roles')
      .select(['user_id'])
      .where('scope_type', '=', 'season')
      .where('scope_id', 'in', seasons)
      .execute()
    for (const row of seasonRoles) await set(row.user_id, 'Season staff')
    const leagues = await db
      .selectFrom('seasons')
      .select(['league_id'])
      .where('id', 'in', seasons)
      .execute()
    const leagueIds = leagues.flatMap(row =>
      row.league_id == null ? [] : [row.league_id]
    )
    for (const userId of await leagueRoleIds(db, leagueIds)) {
      await set(userId, 'League')
    }
  }
  return labels
}
