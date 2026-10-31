import type { Kysely, Transaction } from 'kysely'

import { HttpError } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { NewRosterPlayer } from '../../common/playerSettings'
import type {
  TeamMemberError,
  TeamMemberExternalId,
  TeamPlayerResult,
  TeamPlayerRow,
  TeamPlayersCounts,
  TeamPlayersResponse
} from '../../common/teamMembers'
import { asUserId } from '../../common/userId'
import { heldByOpenAdd } from '../access'
import { lockPlayerEdits, survivorsOf } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { externalIdLockKey, recordExternalId } from '../db/externalIds'
import { playerAddKey } from '../groups/noticePolicy'
import { realClock } from '../groups/requests'
import { noteScopeChange } from '../socket/syncRevision'
import { isDeleted } from '../users/deleted'
import { insertUser } from '../users/insertUser'
import { addByPolicy, teamName } from './addExistingPlayer'

/** Who holds an external id, as far as a person's row is concerned. */
export type ExternalIdHolder =
  /** Nobody. */
  | { held: false }
  /** A user, after following merges. */
  | { held: true; userId: string }
  /** Something that is not a user, which no person can take over. */
  | { held: true; entityType: string }
  /** A user row that is gone: the id names nobody, and is taken over. */
  | { held: true; orphanRowId: string }

export async function externalIdHolder(
  trx: Transaction<Database>,
  externalId: TeamMemberExternalId
): Promise<ExternalIdHolder> {
  const row = await trx
    .selectFrom('external_ids')
    .select(['id', 'entity_type', 'entity_id'])
    .where('system', '=', externalId.system)
    .where('kind', '=', externalId.kind)
    .where('external_id', '=', externalId.id)
    .executeTakeFirst()
  if (row == null) return { held: false }
  if (row.entity_type !== 'user') {
    return { held: true, entityType: row.entity_type }
  }
  let heldBy: string
  try {
    heldBy = asUserId(row.entity_id)
  } catch {
    return { held: true, orphanRowId: row.id }
  }
  // An orphaned external reference is reclaimable. Once a user exists,
  // however, an invalid merge chain must still fail rather than be reclaimed.
  const existing = await trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', heldBy)
    .executeTakeFirst()
  if (existing == null) return { held: true, orphanRowId: row.id }
  const userId = (await survivorsOf(trx, [heldBy])).get(heldBy)
  return userId == null
    ? { held: true, orphanRowId: row.id }
    : { held: true, userId }
}

/** Records the id on the user, or moves an orphaned row onto them. */
export async function claimExternalId(
  trx: Transaction<Database>,
  userId: string,
  externalId: TeamMemberExternalId,
  holder: ExternalIdHolder
): Promise<boolean> {
  if (holder.held && 'orphanRowId' in holder) {
    await trx
      .updateTable('external_ids')
      .set({ entity_id: String(userId) })
      .where('id', '=', holder.orphanRowId)
      .execute()
    return true
  }
  return await recordExternalId(trx, 'user', String(userId), externalId)
}

/** `first last`, or `fallback` when both are empty. */
export function displayNameOf(
  firstName: string,
  lastName: string,
  fallback: string
): string {
  const name = [firstName, lastName].filter(part => part !== '').join(' ')
  return name === '' ? fallback : name
}

/** What a new user row is made of. */
export interface NewUser {
  displayName: string
  firstName: string
  lastName: string
  loginEnabled: boolean
  bats?: TeamPlayerRow['bats']
  throws?: TeamPlayerRow['throws']
  /**
   * Where the hands came from. A hand written without one is an import.
   * A roster manager's create writes `manual`, so a later import leaves it.
   */
  batsSource?: 'import' | 'manual'
}

/** A row's answer when its external id turned out to be held after all. */
export function heldIdError(externalId: TeamMemberExternalId): TeamMemberError {
  const { system, kind, id } = externalId
  return {
    code: 'conflict',
    message: `${system} ${kind} ${id} is already held by something else`
  }
}

/** Create the identity before claiming its external reference in the same transaction. */
export async function insertUserWithId(
  trx: Transaction<Database>,
  externalId: TeamMemberExternalId,
  holder: ExternalIdHolder,
  values: NewUser
): Promise<string | undefined> {
  const userId = await insertRosterUser(trx, values)
  if (!(await claimExternalId(trx, userId, externalId, holder))) {
    await trx.deleteFrom('users').where('id', '=', userId).execute()
    return undefined
  }
  return userId
}

async function insertRosterUser(
  trx: Transaction<Database>,
  values: NewUser
): Promise<string> {
  const handed = values.bats != null || values.throws != null
  return await insertUser(trx, {
    display_name: values.displayName,
    first_name: values.firstName === '' ? null : values.firstName,
    last_name: values.lastName === '' ? null : values.lastName,
    login_enabled: values.loginEnabled,
    is_admin: false,
    bats: values.bats ?? null,
    throws: values.throws ?? null,
    bats_source: handed ? (values.batsSource ?? 'import') : null
  })
}

/**
 * Adds a team's players by the ids another system has for them.
 *
 * One transaction for the whole call, each row's external id locked first,
 * so two posts of the same roster at once make each person once. Rows are
 * applied in order; a row whose id is held by something other than a user is
 * that row's `conflict`, and the others still apply.
 */
export async function addPlayers(
  db: Kysely<Database>,
  actor: Actor,
  teamId: string,
  rows: TeamPlayerRow[]
): Promise<TeamPlayersResponse> {
  return await atomic(db, async trx => {
    await lockPlayerEdits(trx)
    // Adult and player batches can reach the same memberships through aliases.
    await lockKeys(trx, [`teamRoster:${teamId}`])
    await lockKeys(
      trx,
      rows.map(row => externalIdLockKey(row.externalId))
    )
    // Different aliases can name the same accounts in opposite roster order.
    // Lock every existing account before a membership trigger locks any one.
    // Foreign-key readers may still join adults without changing those accounts.
    const accounts = new Set<string>()
    for (const row of rows) {
      const holder = await externalIdHolder(trx, row.externalId)
      if (holder.held && 'userId' in holder) accounts.add(holder.userId)
    }
    // Before the accounts, as a roster add takes them.
    await lockKeys(trx, [...accounts].sort().map(playerAddKey))
    if (accounts.size > 0)
      await trx
        .selectFrom('users')
        .select('id')
        .where('id', 'in', [...accounts])
        .orderBy('id')
        .forNoKeyUpdate()
        .execute()
    const results: TeamPlayerResult[] = []
    const counts: TeamPlayersCounts = {
      created: 0,
      joined: 0,
      unchanged: 0,
      error: 0
    }
    for (const [index, row] of rows.entries()) {
      const result = await addPlayer(trx, actor, teamId, row, index)
      results.push(result)
      counts[result.result] += 1
    }
    return { results, counts }
  })
}

async function addPlayer(
  trx: Transaction<Database>,
  actor: Actor,
  teamId: string,
  row: TeamPlayerRow,
  index: number
): Promise<TeamPlayerResult> {
  const holder = await externalIdHolder(trx, row.externalId)
  if (holder.held && 'entityType' in holder) {
    const { system, kind, id } = row.externalId
    return {
      index,
      result: 'error',
      error: {
        code: 'conflict',
        message: `${system} ${kind} ${id} is already on a ${holder.entityType}`
      }
    }
  }

  let userId: string
  let created = false
  if (holder.held && 'userId' in holder) {
    userId = holder.userId
    if (!(await playsFor(trx, teamId, userId)))
      return await joinByPolicy(trx, actor, teamId, userId, row, index)
    // Their hands are their own while their side may reject an add.
    if (!(await heldByOpenAdd(trx, teamId, [userId])))
      await importHands(trx, userId, row)
  } else {
    const made = await insertUserWithId(trx, row.externalId, holder, {
      displayName: displayNameOf(row.firstName, row.lastName, 'Unknown player'),
      firstName: row.firstName,
      lastName: row.lastName,
      loginEnabled: false,
      bats: row.bats,
      throws: row.throws
    })
    if (made == null) {
      return { index, result: 'error', error: heldIdError(row.externalId) }
    }
    userId = made
    created = true
  }

  const joined = await makePlayer(trx, teamId, userId, row.jersey)
  return {
    index,
    result: created ? 'created' : joined ? 'joined' : 'unchanged',
    userId
  }
}

/**
 * Somebody who exists and is not on the team joins as any existing player
 * does (`addByPolicy`): at once with a notice their side may reject, or not
 * until their side accepts, which a row answers as an error.
 */
async function joinByPolicy(
  trx: Transaction<Database>,
  actor: Actor,
  teamId: string,
  userId: string,
  row: TeamPlayerRow,
  index: number
): Promise<TeamPlayerResult> {
  const refused = (message: string): TeamPlayerResult => ({
    index,
    result: 'error',
    error: { code: 'conflict', message }
  })
  if (await isDeleted(trx, userId)) return refused('That account was deleted')
  // A place on the team keeps its jersey, unless it had none.
  const place = await trx
    .selectFrom('memberships')
    .select('jersey')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  try {
    const added = await addByPolicy(
      trx,
      actor,
      {
        kind: 'playerAdd',
        mode: 'roster',
        userId,
        teamId,
        jersey: place?.jersey ?? row.jersey,
        positions: [],
        teamName: await teamName(trx, teamId)
      },
      realClock
    )
    if (added.kind === 'pending')
      return refused('Their side must accept this add first')
    // With nobody to tell, no add is open, and they are the team's own.
    if (added.requestId == null) await importHands(trx, userId, row)
    return { index, result: 'joined', userId }
  } catch (error) {
    if (error instanceof HttpError) return refused(error.message)
    throw error
  }
}

async function playsFor(
  trx: Transaction<Database>,
  teamId: string,
  userId: string
): Promise<boolean> {
  const row = await trx
    .selectFrom('memberships')
    .select('id')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .where('is_player', '=', true)
    .executeTakeFirst()
  return row != null
}

/**
 * Bats and throws, as migration 021 has every import write them: only where
 * the source is null or `import`, so a coach's `manual` value is never
 * replaced. Each hand sent replaces an imported one, a hand not sent is left
 * as it is, and the source becomes `import` only when a hand is written.
 */
async function importHands(
  trx: Transaction<Database>,
  userId: string,
  row: TeamPlayerRow
): Promise<void> {
  if (row.bats == null && row.throws == null) return
  await trx
    .updateTable('users')
    .set({
      ...(row.bats == null ? {} : { bats: row.bats }),
      ...(row.throws == null ? {} : { throws: row.throws }),
      bats_source: 'import',
      updated_at: new Date()
    })
    .where('id', '=', userId)
    .where('bats_source', 'is distinct from', 'manual')
    // A deleted account's hands went with it.
    .where('deleted_at', 'is', null)
    .execute()
}

/**
 * Makes the user a player of the team: a new `member` membership with the
 * jersey, or an existing one marked as a player, keeping its jersey unless it
 * has none. True when they were not a player here before.
 */
async function makePlayer(
  trx: Transaction<Database>,
  teamId: string,
  userId: string,
  jersey: string | null,
  positions?: readonly string[]
): Promise<boolean> {
  const membership = await trx
    .selectFrom('memberships')
    .select(['id', 'is_player', 'jersey'])
    .where('user_id', '=', userId)
    .where('team_id', '=', teamId)
    .executeTakeFirst()
  if (membership == null) {
    await trx
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member',
        is_player: true,
        jersey,
        ...(positions == null ? {} : { positions: [...positions] }),
        joined_at: new Date()
      })
      .execute()
    noteScopeChange(trx, { userId, teamId })
    return true
  }
  const fillJersey = membership.jersey == null && jersey != null
  if (membership.is_player && !fillJersey) return false
  await trx
    .updateTable('memberships')
    .set({ is_player: true, jersey: membership.jersey ?? jersey })
    .where('id', '=', membership.id)
    .execute()
  noteScopeChange(trx, { userId, teamId })
  return !membership.is_player
}

/**
 * A person created by a roster manager: a user who cannot sign in, with no
 * e-mail, and a player membership on the team. Hands are `manual`, so a
 * later roster import does not overwrite them. The user id is what a future
 * merge follows.
 */
export async function createRosterPlayer(
  db: Kysely<Database>,
  teamId: string,
  player: NewRosterPlayer,
  /** Told the new user id last, in the transaction that made it. */
  made?: (trx: Transaction<Database>, userId: string) => Promise<void>
): Promise<string> {
  return await atomic(db, async trx => {
    const handed = player.bats != null || player.throws != null
    const userId = await insertRosterUser(trx, {
      displayName: displayNameOf(player.firstName, player.lastName, 'Player'),
      firstName: player.firstName,
      lastName: player.lastName,
      loginEnabled: false,
      ...(player.bats == null ? {} : { bats: player.bats }),
      ...(player.throws == null ? {} : { throws: player.throws }),
      ...(handed ? { batsSource: 'manual' as const } : {})
    })
    await makePlayer(trx, teamId, userId, player.jersey, player.positions)
    await made?.(trx, userId)
    return userId
  })
}
