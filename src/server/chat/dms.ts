import { type Kysely, sql } from 'kysely'

import type { AgeBand } from '../../common/age'
import type { MessageReach } from '../../common/api'
import { compareUserIds } from '../../common/chatCrypto/userId'
import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import { openAddTeams } from '../access'
import type { Database } from '../db/database'
import { rowsOfPeople, survivors } from '../teams/teamStaff'
import { AGE_COLUMNS, bandOfRow } from '../users/age'
import { audienceOf, fullTeams, NAMING_KINDS, teamStaffIds } from './audiences'
import { assertDmAllowed, lockBlockPolicy } from './blocks'
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
 * Every rule protects **minors**: members whose age band (`ageBandOf`) is
 * 13 to 17, whether or not they play. Nobody under 13 is in a DM: they are
 * not eligible. Somebody with no age on file is treated as no minor.
 *
 * - **A minor's staff:** direct `admin`, `coach` or `assistant` roles on a
 *   team the minor plays on, and that team's `owner` and `manager`
 *   memberships. Not scorekeepers, songkeepers, season or league roles, and
 *   not a team that holds the minor only by an add their side may reject.
 * - **A minor's peers:** players who share a team or a season with them and
 *   are minors themselves, or adults born no more than 48 months before the
 *   minor, both birth months known. An adult with only `is_adult` is no
 *   peer.
 * - **A minor's relatives:** their guardians and family members whose band
 *   is adult. A guardian or family member who is not an adult does not
 *   count.
 *
 * **Naming.** The server checks the creator against each person they name,
 * and an adder against each person added; anything else is `notCandidate`.
 *
 * - A **minor** M may be named only by M's staff, peers and relatives.
 * - A minor may name their staff, peers and relatives, and anybody else the
 *   rules below allow, provided the pair rule holds.
 * - A **fan of T** who shares no Staff, Members, Season Staff, All Staff or
 *   Org chat with the creator may be named by T's team staff, the All Staff
 *   of a season T plays in (season staff included), and role holders on its
 *   league.
 * - **Anyone else** may be named by someone they share one of those five
 *   chats with.
 * - **Included adults** for a minor in the DM may be named by anyone who may
 *   name that minor, for that DM.
 *
 * Nobody who is not eligible (an account whose band is not under 13) names
 * or is named.
 *
 * **The pair rule.** For every minor M in a DM, every other member is M's
 * staff, peer or relative. A minor who plays on no team and has no guardian
 * so can be in no DM. A refusal is `notCandidate`.
 *
 * **The MAAPP rule.** For a covered minor M (on a team in a season of a
 * league with `safesport_lao`) and every adult A beside M in the DM who is
 * not M's relative, the DM also holds an included adult for M other than A.
 * An adult beside M is anyone whose band is adult, except an adult player
 * born no more than 48 months before M with both birth months known (the
 * close-in-age exception). Included adults are M's relatives and M's staff
 * who are adults beside M. A refusal is `conflict` with `adultRequired` and
 * `playerIds`.
 */

/** A DM is created with 2 to 20 members and never grows past 20. */
export const DM_MAX_MEMBERS = 20

/** The close-in-age exception: no more than 4 years older. */
const CLOSE_IN_AGE_MONTHS = 48

/** Direct team roles that make somebody a minor's staff. */
const MINOR_STAFF_ROLES = ['admin', 'coach', 'assistant'] as const

interface UserRow {
  id: string
  account: boolean
  birthYear: number | null
  birthMonth: number | null
  band: AgeBand
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
  private readonly settled = new Map<string, string[]>()
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

  /** Reads these users' rows and bands at once, for the checks that follow. */
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
        ...AGE_COLUMNS
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
        birthMonth: row.birth_month,
        band: bandOfRow(row, this.now)
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

  /** An account whose band is not `under13`. */
  async eligible(userId: string): Promise<boolean> {
    const row = await this.row(userId)
    return row != null && row.account && row.band !== 'under13'
  }

  /** The person's age band; `unknown` for nobody. */
  async band(userId: string): Promise<AgeBand> {
    return (await this.row(userId))?.band ?? 'unknown'
  }

  /** An eligible person aged 13 to 17. */
  async isMinor(userId: string): Promise<boolean> {
    return (
      (await this.eligible(userId)) && (await this.band(userId)) === 'minor'
    )
  }

  /** The minors among these people. */
  async minorsAmong(userIds: string[]): Promise<string[]> {
    await this.load(userIds)
    const minors: string[] = []
    for (const id of userIds) if (await this.isMinor(id)) minors.push(id)
    return minors
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
    const known = this.settled.get(userId)
    if (known != null) return known
    const teams = await this.playerTeams(userId)
    const held = teams.length === 0 ? [] : await openAddTeams(this.db, [userId])
    const settled = teams.filter(team => !held.includes(team))
    this.settled.set(userId, settled)
    return settled
  }

  /** Whether this person plays on any team. */
  async isPlayer(userId: string): Promise<boolean> {
    return (await this.playerTeams(userId)).length > 0
  }

  /** Whether this person has an account they can sign in with, at any age. */
  async hasAccount(userId: string): Promise<boolean> {
    return (await this.row(userId))?.account === true
  }

  /**
   * Whether `creatorId` may ask to message somebody for `playerId`, a player
   * who cannot use chat: their guardian, their teams' staff, or somebody who
   * may use chat and plays in a season with them.
   */
  async mayNamePlayer(creatorId: string, playerId: string): Promise<boolean> {
    if (creatorId === playerId) return false
    const { guardians } = await this.relativesOf(playerId)
    if (guardians.has(creatorId)) return true
    if ((await this.staffOf(playerId)).has(creatorId)) return true
    return (
      (await this.eligible(creatorId)) &&
      (await this.sharesSeason(creatorId, playerId))
    )
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
   * A minor's staff: direct `admin`, `coach` or `assistant` on a team they
   * play on, and that team's owners and managers. Survivors, eligible or
   * not.
   */
  async staffOf(minorId: string): Promise<Set<string>> {
    const held = this.staff.get(minorId)
    if (held != null) return held
    const teams = await this.settledTeams(minorId)
    let staff = new Set<string>()
    if (teams.length > 0) {
      const roles = await this.db
        .selectFrom('scope_roles')
        .select(['user_id'])
        .where('scope_type', '=', 'team')
        .where('scope_id', 'in', teams)
        .where('role', 'in', [...MINOR_STAFF_ROLES])
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
      staff = new Set(survivorOf.values())
    }
    staff.delete(minorId)
    this.staff.set(minorId, staff)
    return staff
  }

  /** A minor's guardians and family members who are eligible adults. */
  async relativesOf(
    minorId: string
  ): Promise<{ guardians: Set<string>; family: Set<string> }> {
    const held = this.kin.get(minorId)
    if (held != null) return held
    // Every row that is the minor: a link names the row they had when it
    // was made.
    const rows = await this.db
      .selectFrom('user_links')
      .select(['user_id', 'kind'])
      .where('related_user_id', 'in', await rowsOfPeople(this.db, [minorId]))
      .where('kind', 'in', ['guardian', 'family'])
      .execute()
    const survivorOf = await survivors(
      this.db,
      rows.map(row => row.user_id)
    )
    await this.load([...survivorOf.values()])
    const guardians = new Set<string>()
    const family = new Set<string>()
    for (const row of rows) {
      const id = survivorOf.get(row.user_id)
      if (id == null || id === minorId) continue
      if (!(await this.eligible(id)) || (await this.band(id)) !== 'adult')
        continue
      if (row.kind === 'guardian') guardians.add(id)
      else family.add(id)
    }
    for (const id of guardians) family.delete(id)
    const kin = { guardians, family }
    this.kin.set(minorId, kin)
    return kin
  }

  /** Whether two people share a team or a season they play in. */
  async sharesSeason(a: string, b: string): Promise<boolean> {
    const teamsA = await this.settledTeams(a)
    const teamsB = await this.settledTeams(b)
    if (teamsA.some(team => teamsB.includes(team))) return true
    const seasonsA = await this.seasonsOf(teamsA)
    const seasonsB = await this.seasonsOf(teamsB)
    return seasonsA.some(season => seasonsB.includes(season))
  }

  /**
   * Whether `olderId` was born no more than 48 months before `minorId`, both
   * birth months known.
   */
  private async closeInAge(olderId: string, minorId: string): Promise<boolean> {
    const older = await this.row(olderId)
    const minor = await this.row(minorId)
    if (
      older?.birthYear == null ||
      older.birthMonth == null ||
      minor?.birthYear == null ||
      minor.birthMonth == null
    )
      return false
    const months = (year: number, month: number): number => year * 12 + month
    return (
      months(minor.birthYear, minor.birthMonth) -
        months(older.birthYear, older.birthMonth) <=
      CLOSE_IN_AGE_MONTHS
    )
  }

  /**
   * Whether `otherId` is a minor's peer: a player sharing a team or a season
   * with them who is a minor, or an adult born no more than 48 months before
   * them with both birth months known.
   */
  async isPeer(minorId: string, otherId: string): Promise<boolean> {
    if (otherId === minorId || !(await this.eligible(otherId))) return false
    if (!(await this.sharesSeason(minorId, otherId))) return false
    const band = await this.band(otherId)
    if (band === 'minor') return true
    return band === 'adult' && (await this.closeInAge(otherId, minorId))
  }

  /** Whether `otherId` is a minor's staff, peer or relative. */
  async standsBy(minorId: string, otherId: string): Promise<boolean> {
    if ((await this.staffOf(minorId)).has(otherId)) return true
    const { guardians, family } = await this.relativesOf(minorId)
    if (guardians.has(otherId) || family.has(otherId)) return true
    return await this.isPeer(minorId, otherId)
  }

  /**
   * Whether A counts as an adult beside minor M, for the MAAPP rule: an adult
   * by band, but not an adult player born no more than 48 months before M,
   * both birth months known.
   */
  async isAdultFor(adultId: string, minorId: string): Promise<boolean> {
    if ((await this.band(adultId)) !== 'adult') return false
    if ((await this.playerTeams(adultId)).length === 0) return true
    return !(await this.closeInAge(adultId, minorId))
  }

  /** A minor on a team in a season of a league that is a SafeSport LAO. */
  async covered(minorId: string): Promise<boolean> {
    if (!(await this.isMinor(minorId))) return false
    const seasons = await this.seasonsOf(await this.playerTeams(minorId))
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

  /** A minor's relatives, and their staff who are eligible adults beside them. */
  async includedAdults(minorId: string): Promise<Set<string>> {
    const { guardians, family } = await this.relativesOf(minorId)
    const adults = new Set([...guardians, ...family])
    for (const id of await this.staffOf(minorId)) {
      if (!(await this.eligible(id))) continue
      if (await this.isAdultFor(id, minorId)) adults.add(id)
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

  /**
   * Whether C may name X in a DM whose minors are `dmMinors` (for the
   * included-adult rule).
   */
  async mayName(
    creatorId: string,
    targetId: string,
    dmMinors: string[] = []
  ): Promise<boolean> {
    if (creatorId === targetId) return false
    if (!(await this.eligible(creatorId))) return false
    if (!(await this.eligible(targetId))) return false
    if (await this.isMinor(targetId)) {
      return await this.standsBy(targetId, creatorId)
    }
    for (const minorId of dmMinors) {
      if (minorId === targetId) continue
      if (!(await this.standsBy(minorId, creatorId))) continue
      if ((await this.includedAdults(minorId)).has(targetId)) return true
    }
    // Naming is two-way between a minor and their staff, peers and
    // relatives: whoever may start a DM with minor M, M may start one with.
    if (
      (await this.isMinor(creatorId)) &&
      (await this.standsBy(creatorId, targetId))
    )
      return true
    if (await this.shareNamingChat(creatorId, targetId)) return true
    return await this.mayNameFan(creatorId, targetId)
  }

  /**
   * The minors whose pair rule this membership breaks. A member `underWay`
   * (already in the DM) who has no age breaks nothing yet: they read and
   * write nothing until they answer, and their answer re-checks the DM.
   * Anybody joining is judged in full.
   */
  async pairRuleBreaks(
    members: string[],
    underWay: ReadonlySet<string> = new Set()
  ): Promise<string[]> {
    const broken: string[] = []
    for (const minorId of await this.minorsAmong(members)) {
      for (const other of members) {
        if (other === minorId) continue
        if (underWay.has(other) && (await this.band(other)) === 'unknown')
          continue
        if (await this.standsBy(minorId, other)) continue
        broken.push(minorId)
        break
      }
    }
    return broken
  }

  /** The covered minors whose MAAPP rule this membership breaks. */
  async maappBreaks(members: string[]): Promise<string[]> {
    const broken: string[] = []
    for (const minorId of await this.minorsAmong(members)) {
      if (!(await this.covered(minorId))) continue
      const { guardians, family } = await this.relativesOf(minorId)
      const included = await this.includedAdults(minorId)
      for (const adult of members) {
        if (adult === minorId) continue
        if (guardians.has(adult) || family.has(adult)) continue
        if (!(await this.isAdultFor(adult, minorId))) continue
        const another = members.some(
          other => other !== adult && other !== minorId && included.has(other)
        )
        if (!another) {
          broken.push(minorId)
          break
        }
      }
    }
    return broken
  }

  /**
   * The first rule this membership breaks, pair rule first; `underWay` are
   * the members already in the DM (`pairRuleBreaks`).
   */
  async ruleBreak(
    members: string[],
    underWay: ReadonlySet<string> = new Set()
  ): Promise<RuleBreak | undefined> {
    const pair = await this.pairRuleBreaks(members, underWay)
    if (pair.length > 0) return { rule: 'pairRule', playerIds: pair }
    const maapp = await this.maappBreaks(members)
    if (maapp.length > 0) return { rule: 'adultRequired', playerIds: maapp }
    return undefined
  }

  /** Every minor either rule refuses among these members, all under way. */
  async refusedMinors(members: string[]): Promise<string[]> {
    return [
      ...new Set([
        ...(await this.pairRuleBreaks(members, new Set(members))),
        ...(await this.maappBreaks(members))
      ])
    ]
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
  const minors = await facts.minorsAmong(members)
  const refused: string[] = []
  for (const id of named) {
    if (!(await facts.mayName(actor, id, minors))) refused.push(id)
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
    await lockBlockPolicy(trx)
    const facts = new DmFacts(trx, now)
    const members = [creatorId, ...others]
    await assertDmAllowed(trx, members)
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
    await lockBlockPolicy(trx)
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
    await assertDmAllowed(trx, members)
    await facts.load(members)
    await mustName(facts, adderId, added, members)
    const broken = await facts.ruleBreak(members, new Set(current))
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
      const broken = await facts.ruleBreak(remaining, new Set(remaining))
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
 * longer eligible (`notEligible`), then closes the DM when fewer than two
 * are left, or those left break the pair rule or the MAAPP rule. A member
 * with no age breaks no pair rule here (`pairRuleBreaks`). It never adds
 * anybody, and hides nothing: only a first answer does (`recheckDmsOf`).
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
    const remaining = current.filter(id => !removed.includes(id))
    if (!dm.closed && removed.length > 0 && remaining.length < 2) {
      // Nobody is left to write to: a DM is between two people at least.
      await closeConversation(
        trx,
        conversationId,
        {
          userId: [...removed].sort(compareUserIds)[0],
          actorUserId: null,
          reason: 'notEligible'
        },
        now
      )
      closed = true
    } else if (!dm.closed) {
      const broken = await facts.ruleBreak(remaining, new Set(remaining))
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
 * A first answer's check of every DM `userId` is in now, run with the
 * answer, before the person can read anything: `recheckDm`, then, judged
 * beside everybody who has been in the DM, open or closed, the person's
 * history from before they answered (`hidden_before`) is hidden from them
 * when the rules refuse them as a minor there, or when, as anybody else,
 * they are why the rules refuse a minor there. Only a first answer hides:
 * a break that comes later leaves what was read where it was.
 */
export async function recheckDmsOf(
  db: Kysely<Database>,
  userId: string,
  now: Date = new Date()
): Promise<void> {
  const dms = await db
    .selectFrom('chat_members as m')
    .innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
    .select('c.id')
    .where('m.user_id', '=', userId)
    .where('m.left_at', 'is', null)
    .where('c.kind', '=', 'dm')
    .orderBy('c.id')
    .execute()
  for (const dm of dms) {
    await recheckDm(db, dm.id, now)
    const everyone = (
      await db
        .selectFrom('chat_members')
        .select('user_id')
        .distinct()
        .where('conversation_id', '=', dm.id)
        .execute()
    ).map(row => row.user_id)
    const facts = new DmFacts(db, now)
    const refused = await facts.refusedMinors(everyone)
    const without = new Set(
      await facts.refusedMinors(everyone.filter(id => id !== userId))
    )
    if (
      refused.includes(userId) ||
      refused.some(minorId => !without.has(minorId))
    )
      await hideHistoryBeforeAnswers(db, dm.id, [userId])
  }
}

/**
 * Sets `hidden_before` to the time each of these people gave their first
 * age, for those who gave it after they joined the conversation.
 */
async function hideHistoryBeforeAnswers(
  trx: Kysely<Database>,
  conversationId: string,
  userIds: string[]
): Promise<void> {
  if (userIds.length === 0) return
  await sql`
    update chat_members m
    set hidden_before = u.age_set_at
    from users u
    where m.conversation_id = ${conversationId}
      and m.user_id = u.id
      and m.user_id in (${sql.join(userIds)})
      and u.age_set_at is not null
      and u.age_set_at > m.joined_at
  `.execute(trx)
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
    .execute()
  // closeInto can retain every lock until its outer transaction commits.
  // Match grants and identity changes regardless of database collation.
  const ids = dms.map(dm => dm.id).sort()
  for (const id of ids) {
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
  return ids
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
  if (await facts.isMinor(callerId)) {
    const { guardians, family } = await facts.relativesOf(callerId)
    add(guardians)
    add(family)
    add(await facts.staffOf(callerId))
  }

  const survivorOf = await survivors(db, [...pool])
  const ids = [...new Set(survivorOf.values())].filter(id => id !== callerId)
  await facts.load(ids)
  const named: string[] = []
  for (const id of ids) {
    if (!(await facts.mayName(callerId, id))) continue
    // Somebody the pair rule keeps out of every DM with the caller (a
    // minor and a parent who is not theirs) is no candidate either.
    if ((await facts.pairRuleBreaks([callerId, id])).length > 0) continue
    named.push(id)
  }
  return named
}

/** How a viewer can message somebody, or null when they cannot. */
export type DmReach = MessageReach | null

/**
 * Whom to message instead of a player who cannot be messaged themselves,
 * and why they cannot: no account they can sign in with (`noAccount`), or
 * one, but under 13, too young for chat (`tooYoung`).
 */
export interface DmProxyIds {
  kind: 'guardians' | 'coaches'
  ids: string[]
  why: 'noAccount' | 'tooYoung'
}

/**
 * Whether `viewerId` may start a DM with `targetId` alone: the naming rule
 * and the pair rule, as `dmCandidateIds` applies them. Neither reads the block
 * policy, which `createDm` applies when the DM is made.
 */
async function reachable(
  facts: DmFacts,
  viewerId: string,
  targetId: string
): Promise<boolean> {
  return (
    (await facts.mayName(viewerId, targetId)) &&
    (await facts.pairRuleBreaks([viewerId, targetId])).length === 0
  )
}

/**
 * The people `viewerId` may message for player `playerId`, who cannot sign
 * in: their guardians and adult family members, or, with none of those the
 * viewer can reach, their current coaches. Never the viewer.
 */
async function proxiesFor(
  facts: DmFacts,
  viewerId: string,
  playerId: string
): Promise<DmProxyIds> {
  const keep = async (ids: Iterable<string>): Promise<string[]> => {
    const kept: string[] = []
    for (const id of ids)
      if (id !== viewerId && (await reachable(facts, viewerId, id)))
        kept.push(id)
    return kept
  }
  const { guardians, family } = await facts.relativesOf(playerId)
  const adults: string[] = [...guardians]
  for (const id of family)
    if (await facts.isAdultFor(id, playerId)) adults.push(id)
  const kin = await keep(adults)
  const why = (await facts.hasAccount(playerId)) ? 'tooYoung' : 'noAccount'
  if (kin.length > 0) return { kind: 'guardians', ids: kin, why }
  return {
    kind: 'coaches',
    ids: await keep(await facts.staffOf(playerId)),
    why
  }
}

/**
 * How `viewerId` can message `targetId`: `direct` when they may start a DM
 * with that person, `proxies` when that person is a player who cannot sign
 * in, whom the viewer may name as a player, and who has somebody the viewer
 * can message instead (`dmProxies`), and null otherwise.
 */
export async function dmReach(
  db: Kysely<Database>,
  viewerId: string,
  targetId: string,
  now: Date = new Date()
): Promise<DmReach> {
  const facts = new DmFacts(db, now)
  if (!(await facts.eligible(viewerId))) return null
  await facts.load([viewerId, targetId])
  return (await reachOf(facts, viewerId, targetId)).reach
}

async function reachOf(
  facts: DmFacts,
  viewerId: string,
  targetId: string
): Promise<{ reach: DmReach; proxies?: DmProxyIds }> {
  if (targetId === viewerId) return { reach: null }
  if (await facts.eligible(targetId))
    return {
      reach: (await reachable(facts, viewerId, targetId)) ? 'direct' : null
    }
  if (!(await facts.isPlayer(targetId))) return { reach: null }
  if (!(await facts.mayNamePlayer(viewerId, targetId))) return { reach: null }
  const proxies = await proxiesFor(facts, viewerId, targetId)
  return proxies.ids.length > 0
    ? { reach: 'proxies', proxies }
    : { reach: null }
}

/**
 * Whom `viewerId` may message for `playerId`, a player who cannot sign in,
 * or null when `dmReach` would not answer `proxies` for them.
 */
export async function dmProxies(
  db: Kysely<Database>,
  viewerId: string,
  playerId: string,
  now: Date = new Date()
): Promise<DmProxyIds | null> {
  const facts = new DmFacts(db, now)
  if (!(await facts.eligible(viewerId))) return null
  return (await reachOf(facts, viewerId, playerId)).proxies ?? null
}

/**
 * The adults `callerId` may include beside these minors, with how each
 * stands to them: their guardians, adult family members and adult staff (a
 * minor's staff is their own teams' coaches and admins). Never the caller.
 * The caller must be allowed to name every minor.
 */
export async function includedAdultIds(
  db: Kysely<Database>,
  callerId: string,
  playerIds: string[],
  now: Date = new Date()
): Promise<Candidate[]> {
  const facts = new DmFacts(db, now)
  await facts.load([callerId, ...playerIds])
  const refused: string[] = []
  for (const playerId of playerIds) {
    if (
      !(await facts.isMinor(playerId)) ||
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
    const staffLabels = await staffLabelsFor(db, facts, playerId)
    for (const id of await facts.staffOf(playerId)) {
      if (included.has(id)) offer(id, staffLabels.get(id) ?? 'Coach')
    }
  }
  return [...labels].map(([userId, label]) => ({ userId, label }))
}

const ROLE_WORDS: Record<string, string> = {
  admin: 'Admin',
  owner: 'Admin',
  manager: 'Admin',
  coach: 'Coach',
  assistant: 'Assistant'
}

/**
 * How each of a minor's staff stands to them: `Coach · Hawks`, the strongest
 * role first.
 */
async function staffLabelsFor(
  db: Kysely<Database>,
  facts: DmFacts,
  minorId: string
): Promise<Map<string, string>> {
  const teams = await facts.settledTeams(minorId)
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
      .where('role', 'in', [...MINOR_STAFF_ROLES])
      .execute()
    const order = ['owner', 'manager', 'admin', 'coach', 'assistant']
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
  return labels
}
