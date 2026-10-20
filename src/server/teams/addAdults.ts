import { type Kysely, sql, type Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import type { RoleFlag } from '../../common/roles'
import type {
  TeamAdultResult,
  TeamAdultRow,
  TeamAdultsCounts,
  TeamAdultsResponse,
  TeamMemberError,
  TeamMemberExternalId
} from '../../common/teamMembers'
import { guardiansOf, guardiansWhoCanAct } from '../access'
import { lockPlayerEdits, onePerson, survivorsOf } from '../admin/people'
import { addEmail } from '../auth/emails'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { externalIdLockKey } from '../db/externalIds'
import {
  claimExternalId,
  displayNameOf,
  externalIdHolder,
  heldIdError,
  insertUserWithId
} from './addPlayers'

/** What a confirmed member of staff is given on the team. Never `admin`. */
const STAFF_ROLES: readonly RoleFlag[] = ['coach', 'scorekeeper']

/**
 * Adds a team's parents, followers and staff by the ids another system has
 * for them. Nobody is mailed, and nothing is ever taken away.
 *
 * One transaction for the whole call, each row's external id and address
 * locked first, so two posts of the same adults at once make each person
 * once. Each adult is the user holding the external id (merges followed),
 * else the user holding the address, who gets the external id only from a
 * site administrator, else a new user; an address nobody holds is attached
 * by `attachEmail`'s rule. Then they gain what the row
 * asks that they lack: a membership, guardian links to the team's players,
 * and the coach and scorekeeper roles when they are staff.
 *
 * A guardian link is made only to a player who had no guardian who can sign
 * in when the call began (`guardiansWhoCanAct`: a parent imported with no
 * address takes no say), so every parent one import names for a new player
 * is linked, and never to the caller's own account: once a player has a
 * guardian, their guardians decide who else becomes one, and a team's staff
 * cannot make themselves one. A site administrator's import is not held to either.
 * What was refused is counted in `guardiansRefused`.
 */
export async function addAdults(
  db: Kysely<Database>,
  teamId: string,
  rows: TeamAdultRow[],
  caller: { userId: string; isAdmin: boolean }
): Promise<TeamAdultsResponse> {
  return await db.transaction().execute(async trx => {
    await lockPlayerEdits(trx)
    // Share the player import's ordering before either batch claims memberships.
    await lockKeys(trx, [`teamRoster:${teamId}`])
    await lockKeys(
      trx,
      rows.flatMap(row => [
        externalIdLockKey(row.externalId),
        ...(row.email == null ? [] : [`email:${row.email}`])
      ])
    )
    const results: TeamAdultResult[] = []
    const counts: TeamAdultsCounts = {
      created: 0,
      matched: 0,
      unchanged: 0,
      error: 0,
      guardianLinks: 0,
      guardiansRefused: 0,
      staff: 0
    }
    const links: GuardianLinking = {
      caller,
      callerId: (await onePerson(trx, caller.userId)).userId,
      guardedBefore: new Map()
    }
    for (const [index, row] of rows.entries()) {
      const result = await addAdult(trx, teamId, row, index, links)
      results.push(result)
      counts[result.result] += 1
      counts.guardianLinks += result.guardianLinks
      counts.guardiansRefused += result.guardiansRefused
      if (result.rolesAdded.length > 0) counts.staff += 1
    }
    return { results, counts }
  })
}

/**
 * What one call's guardian links are decided by: the caller, as the row they
 * sign in as, and whether each player had a guardian when the call began,
 * read the first time the call names them, before it links anybody to them.
 */
interface GuardianLinking {
  caller: { userId: string; isAdmin: boolean }
  callerId: string
  /**
   * Each player's guardians when the call first came to them: everyone
   * linked, and those of them who can sign in, who alone hold the say.
   */
  guardedBefore: Map<string, { linked: readonly string[]; acting: number }>
}

async function addAdult(
  trx: Transaction<Database>,
  teamId: string,
  row: TeamAdultRow,
  index: number,
  linking: GuardianLinking
): Promise<TeamAdultResult> {
  const { caller } = linking
  const refused = (error: TeamMemberError): TeamAdultResult => ({
    index,
    result: 'error',
    error,
    joined: false,
    guardianLinks: 0,
    guardiansMissing: 0,
    guardiansRefused: 0,
    rolesAdded: []
  })
  const holder = await externalIdHolder(trx, row.externalId)
  if (holder.held && 'entityType' in holder) {
    const { system, kind, id } = row.externalId
    return refused({
      code: 'conflict',
      message: `${system} ${kind} ${id} is already on a ${holder.entityType}`
    })
  }

  let userId: string
  let created = false
  let externalIdNotAttached = false
  let gained = false
  if (holder.held && 'userId' in holder) {
    userId = holder.userId
  } else {
    const byEmail =
      row.email == null ? undefined : await addressHolder(trx, row.email)
    if (byEmail != null) {
      userId = byEmail
      // Another system's id goes onto an account this call did not make
      // only when a site administrator says the account is theirs.
      if (caller.isAdmin) {
        const claimed = await claimExternalId(
          trx,
          userId,
          row.externalId,
          holder
        )
        if (!claimed) return refused(heldIdError(row.externalId))
        gained = true
      } else {
        externalIdNotAttached = true
      }
    } else {
      const made = await insertUserWithId(trx, row.externalId, holder, {
        displayName: displayNameOf(
          row.firstName,
          row.lastName,
          'Unknown adult'
        ),
        firstName: row.firstName,
        lastName: row.lastName,
        // By e-mail code, the way everybody signs in who has no password.
        loginEnabled: row.email != null
      })
      if (made == null) return refused(heldIdError(row.externalId))
      userId = made
      created = true
    }
  }

  let emailHeldElsewhere = false
  let emailNotAttached = false
  if (row.email != null) {
    const attached = await attachEmail(trx, userId, row.email, {
      created,
      callerIsAdmin: caller.isAdmin
    })
    if (attached === 'added') gained = true
    if (attached === 'heldElsewhere') emailHeldElsewhere = true
    if (attached === 'notAttached') emailNotAttached = true
  }

  const joined = await joinTeam(trx, teamId, userId)
  if (joined) gained = true
  const links = await linkGuardian(trx, teamId, userId, row.guardianOf, linking)
  const rolesAdded = row.staff
    ? await addStaffRoles(trx, teamId, userId, caller.userId)
    : []

  const result = created
    ? 'created'
    : gained || links.made > 0 || rolesAdded.length > 0
      ? 'matched'
      : 'unchanged'
  return {
    index,
    result,
    userId,
    joined,
    guardianLinks: links.made,
    guardiansMissing: links.missing,
    guardiansRefused: links.refused,
    rolesAdded,
    ...(emailHeldElsewhere ? { emailHeldElsewhere: true as const } : {}),
    ...(emailNotAttached ? { emailNotAttached: true as const } : {}),
    ...(externalIdNotAttached ? { externalIdNotAttached: true as const } : {})
  }
}

/**
 * Who holds an address: the account its row is on, or, for an account merged
 * away, the one it became. Undefined only when no row holds it, so an
 * address on a closed account never makes a new person.
 */
async function addressHolder(
  trx: Transaction<Database>,
  email: string
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('user_emails')
    .select(['user_id'])
    .where(eb => eb.fn('lower', ['email']), '=', email)
    .executeTakeFirst()
  if (row == null) return undefined
  return (await survivorsOf(trx, [row.user_id])).get(row.user_id) ?? row.user_id
}

/**
 * The row's address, attached as primary only to an account this call made,
 * or, when a site administrator calls, to one already here with no address
 * at all. An import by anybody else cannot add a way to sign in to an
 * account it did not make. An address somebody else holds stays theirs.
 *
 * `add` is `addEmail`, and a test's stand-in for it.
 */
export async function attachEmail(
  trx: Transaction<Database>,
  userId: string,
  email: string,
  about: { created: boolean; callerIsAdmin: boolean },
  add: typeof addEmail = addEmail
): Promise<'added' | 'theirs' | 'heldElsewhere' | 'notAttached'> {
  const holder = await addressHolder(trx, email)
  if (holder != null) {
    return holder === userId ? 'theirs' : 'heldElsewhere'
  }
  if (!about.created) {
    const any = await trx
      .selectFrom('user_emails')
      .select(['id'])
      .where('user_id', '=', userId)
      .executeTakeFirst()
    if (!about.callerIsAdmin || any != null) return 'notAttached'
  }
  // In a savepoint. Every writer of addresses here takes the address's
  // advisory lock, but one that takes none can still commit it after the
  // check above: `addEmail` then finds it held, or the unique index refuses
  // the insert, and either way only this address is given up, not the call.
  await sql`savepoint attach_email`.execute(trx)
  let added: Awaited<ReturnType<typeof addEmail>>
  try {
    added = await add(trx, userId, email, {
      isPrimary: true,
      source: 'import',
      verifiedAt: null
    })
  } catch (error) {
    if (!isAddressTaken(error)) throw error
    await sql`rollback to savepoint attach_email`.execute(trx)
    return 'heldElsewhere'
  }
  await sql`release savepoint attach_email`.execute(trx)
  if (added.added) return 'added'
  if (added.heldBy == null) return 'theirs'
  const heldBy =
    (await survivorsOf(trx, [added.heldBy])).get(added.heldBy) ?? added.heldBy
  return heldBy === userId ? 'theirs' : 'heldElsewhere'
}

/** Whether `error` is the unique index on addresses refusing a second. */
function isAddressTaken(error: unknown): boolean {
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return code === '23505' && constraint === 'user_emails_address'
}

/**
 * A membership of the team, as a `member`, if they have none. An existing one
 * is left as it is: its role is never raised.
 */
async function joinTeam(
  trx: Transaction<Database>,
  teamId: string,
  userId: string
): Promise<boolean> {
  const made = await trx
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userId,
      team_id: teamId,
      role: 'member',
      joined_at: new Date()
    })
    .onConflict(oc => oc.columns(['user_id', 'team_id']).doNothing())
    .returning('id')
    .executeTakeFirst()
  return made != null
}

/**
 * A guardian link to each named player of this team, made where absent. An
 * id that names nobody who plays for this team is counted as missing. Unless
 * a site administrator calls, a player who had a guardian before the call
 * gains no new one, and the caller is linked to nobody: both are counted as
 * refused. An adult who already guards the player is neither.
 */
async function linkGuardian(
  trx: Transaction<Database>,
  teamId: string,
  userId: string,
  guardianOf: TeamMemberExternalId[],
  linking: GuardianLinking
): Promise<{ made: number; missing: number; refused: number }> {
  let made = 0
  let missing = 0
  let refused = 0
  const adult = (await onePerson(trx, userId)).userId
  for (const externalId of guardianOf) {
    const holder = await externalIdHolder(trx, externalId)
    const playerId = holder.held && 'userId' in holder ? holder.userId : null
    const plays =
      playerId == null || playerId === userId
        ? undefined
        : await trx
            .selectFrom('memberships')
            .select(['id'])
            .where('user_id', '=', playerId)
            .where('team_id', '=', teamId)
            .where('is_player', '=', true)
            .executeTakeFirst()
    if (playerId == null || plays == null) {
      missing += 1
      continue
    }
    if (!linking.caller.isAdmin) {
      let before = linking.guardedBefore.get(playerId)
      if (before == null) {
        before = {
          linked: await guardiansOf(trx, [playerId]),
          acting: (await guardiansWhoCanAct(trx, [playerId])).length
        }
        linking.guardedBefore.set(playerId, before)
      }
      if (before.linked.includes(adult)) continue
      if (before.acting > 0 || adult === linking.callerId) {
        refused += 1
        continue
      }
    }
    const inserted = await trx
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userId,
        related_user_id: playerId,
        kind: 'guardian',
        can_manage: true,
        created_at: new Date()
      })
      .onConflict(oc =>
        oc.columns(['user_id', 'related_user_id', 'kind']).doNothing()
      )
      .executeTakeFirst()
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) made += 1
  }
  return { made, missing, refused }
}

/** Coach and scorekeeper on the team, where absent. Only ever added. */
async function addStaffRoles(
  trx: Transaction<Database>,
  teamId: string,
  userId: string,
  grantedBy: string
): Promise<RoleFlag[]> {
  const added: RoleFlag[] = []
  for (const role of STAFF_ROLES) {
    const inserted = await trx
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: 'team',
        scope_id: teamId,
        role,
        granted_by: grantedBy,
        granted_at: new Date()
      })
      .onConflict(oc =>
        oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
      )
      .executeTakeFirst()
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) added.push(role)
  }
  return added
}
