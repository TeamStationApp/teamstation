import { type Kysely, sql, type Transaction } from 'kysely'

import { conflict } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { signOutEverywhere } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { directAdminIds, requireDirectAdmin } from '../groups/adminGuard'
import { ensureGumboId, gumboIdOf } from '../users/insertUser'

/**
 * Every row that is one person.
 *
 * A merged account is closed rather than deleted — `users.merged_into` points
 * at whoever it became — and nothing moves underneath it: the plays, the stat
 * lines and the team memberships stay where they were written, under the id
 * that was current at the time. That is deliberate, because an id already
 * handed out has to keep resolving and because a merge has to be undoable.
 *
 * It means a read that wants everything a person has done cannot ask about one
 * id. It has to ask about all of them, which is what this is for: the survivor,
 * and every row that has been merged into them, however long the chain.
 *
 * Jordan Pujols is why. An import issues a player id per team, so five teams
 * over two years made five people out of one child, and each of his pages knew
 * about one fifth of him.
 */
export interface OnePerson {
  /** The row still open, which is the one to answer as. */
  userId: string
  /** That row and every one closed into it, for a query to sum over. */
  userIds: string[]
}

/** However deep a chain of merges can sensibly go before it is a mistake. */
const MAX_DEPTH = 16

export async function onePerson(
  db: Kysely<Database>,
  userId: string
): Promise<OnePerson> {
  // Up the chain to whoever is still open. A cycle would be a bug in whatever
  // wrote it; the guard means it cannot become a hung request.
  let survivor = userId
  const walked = new Set<string>([userId])
  for (let step = 0; step < MAX_DEPTH; step += 1) {
    const row = await db
      .selectFrom('users')
      .select(['merged_into'])
      .where('id', '=', survivor)
      .executeTakeFirst()
    const next = row?.merged_into
    if (next == null || walked.has(next)) break
    walked.add(next)
    survivor = next
  }

  // And back down it, gathering everybody who became them.
  const userIds = new Set<string>([survivor])
  let frontier = [survivor]
  for (let step = 0; step < MAX_DEPTH && frontier.length > 0; step += 1) {
    const rows = await db
      .selectFrom('users')
      .select(['id'])
      .where('merged_into', 'in', frontier)
      .execute()
    frontier = rows.map(row => row.id).filter(id => !userIds.has(id))
    for (const id of frontier) userIds.add(id)
  }

  return { userId: survivor, userIds: [...userIds] }
}

/**
 * The open row that `userId` is now: itself when it is open, otherwise the row
 * at the end of its chain of merges.
 *
 * Undefined when the walk does not reach an open row within `MAX_DEPTH`
 * steps — a loop, or a chain too long to be anything but a mistake — and when
 * there is no such row at all. Signing in follows this, so a row it cannot
 * settle is answered as nobody rather than as a closed row.
 */
export async function openRowOf(
  db: Kysely<Database>,
  userId: string
): Promise<string | undefined> {
  let at = userId
  for (let step = 0; step <= MAX_DEPTH; step += 1) {
    const row = await db
      .selectFrom('users')
      .select(['merged_into'])
      .where('id', '=', at)
      .executeTakeFirst()
    if (row == null) return undefined
    if (row.merged_into == null) return at
    at = row.merged_into
  }
  return undefined
}

/**
 * Closes one row into another: the merge itself.
 *
 * The closing row is signed out of everything at the same moment
 * (`signOutEverywhere`): every device signed in as it has to sign in again,
 * and the address it signs in with, either row's, lands on the row kept. Its
 * addresses stay where they are — a merge moves no data — and sign-in follows
 * `merged_into` from the address to the open row instead.
 *
 * The memberships move with it. A membership is a person on a team — the
 * jersey, the positions, the role — and leaving it under a closed row is what
 * took 31 children off six rosters the first time this ran: every roster asks
 * for people who are still open, so a child whose surviving row belonged to
 * another team simply vanished from the team they actually play for.
 *
 * Where the survivor is already on that team, the two rows are one row: the
 * survivor's is kept, and anything only the closing row had — a jersey, the
 * positions, being a player at all — is copied onto it first. Two rows for one
 * child on one team is the thing being undone, and a number nobody typed twice
 * should not be what it costs.
 *
 * Nothing is written when `keeping` has already been closed into `closing`,
 * directly or through other rows. The two are one person already, and closing
 * `closing` too would leave no row open: each would name the other, and every
 * walk up the chain would stop on whichever row it reached second. Doing
 * nothing rather than throwing, because every caller runs many merges one after
 * another, and `tidyClosedRows` has to pass by a loop that is already in the
 * data rather than stop the run it is part of.
 *
 * Each merge is one transaction holding one lock that every merge takes, so the
 * check and the writes cannot be split by another merge: two run at once in
 * opposite directions each passed the check and wrote the loop between them.
 * One lock for all merges rather than one per row, because a loop can run
 * through rows neither merge names.
 *
 * A caller already in a transaction has its own used, and it must be read
 * committed: under a stricter level the transaction's snapshot predates the
 * lock, the check reads the chain as it was before another merge committed,
 * and the loop is written anyway. Anything else is refused with an error. The
 * lock is then held until the caller's transaction ends, so every other merge
 * waits for it.
 *
 * `closed` says whether the row was closed: false for a row closed into itself
 * and for a merge refused because it would close a loop. `moved` counts the
 * team rows that went with it.
 */
export async function closeInto(
  db: Kysely<Database>,
  closing: string,
  keeping: string
): Promise<Merge> {
  const nothing: Merge = { closed: false, moved: 0 }
  if (closing === keeping) return nothing
  const merge = async (trx: Transaction<Database>): Promise<Merge> => {
    await lockKeys(trx, [
      'creation:parent-graph',
      'node:administration',
      MERGE_LOCK
    ])
    if (await closedInto(trx, keeping, closing)) return nothing
    const user = await trx
      .selectFrom('users')
      .select(['login_enabled', 'disabled_at', 'merged_into', 'is_admin'])
      .where('id', '=', closing)
      .executeTakeFirst()
    const active =
      user?.login_enabled === true &&
      user.disabled_at == null &&
      user.merged_into == null
    const roles = active
      ? await trx
          .selectFrom('scope_roles')
          .select(['scope_type', 'scope_id'])
          .where('user_id', '=', closing)
          .where('role', '=', 'admin')
          .execute()
      : []
    const owners = active
      ? await trx
          .selectFrom('memberships')
          .select('team_id')
          .where('user_id', '=', closing)
          .where('role', 'in', ['owner', 'manager'])
          .execute()
      : []
    const refs: GroupRef[] = [
      ...roles.map(row => ({ kind: row.scope_type, id: row.scope_id })),
      ...owners.map(row => ({ kind: 'team' as const, id: row.team_id }))
    ]
    const target = await trx
      .selectFrom('users')
      .select(['login_enabled', 'disabled_at', 'merged_into'])
      .where('id', '=', keeping)
      .executeTakeFirst()
    const targetActive =
      target?.login_enabled === true &&
      target.disabled_at == null &&
      target.merged_into == null
    // Refuse before writing so callers may safely catch a refusal inside an
    // existing read-committed transaction without committing an orphaned group.
    for (const ref of refs) {
      if (
        ref.kind === 'team' &&
        (
          await trx
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', ref.id)
            .executeTakeFirst()
        )?.kind === 'external'
      )
        continue
      if ((await directAdminIds(trx, ref)).some(id => id !== closing)) continue
      const retainedOwner =
        targetActive &&
        ref.kind === 'team' &&
        owners.some(row => row.team_id === ref.id) &&
        (await trx
          .selectFrom('memberships')
          .select('id')
          .where('user_id', '=', keeping)
          .where('team_id', '=', ref.id)
          .executeTakeFirst()) == null
      if (!retainedOwner)
        throw conflict(
          'Add another active direct administrator before merging the last one'
        )
    }
    if (
      active &&
      user.is_admin &&
      (
        await trx
          .selectFrom('users')
          .select('id')
          .where('is_admin', '=', true)
          .where('login_enabled', '=', true)
          .where('disabled_at', 'is', null)
          .where('merged_into', 'is', null)
          .where('id', '!=', closing)
          .execute()
      ).length === 0
    )
      throw conflict(
        'Add another active node administrator before merging the last one'
      )
    const final = (await survivorsOf(trx, [keeping])).get(keeping)!
    await trx
      .selectFrom('users')
      .select('id')
      .where('id', 'in', [...new Set([closing, keeping, final])])
      .orderBy('id')
      .forUpdate()
      .execute()
    if ((await gumboIdOf(trx, closing)) != null) {
      await ensureGumboId(trx, keeping)
      if (final !== keeping) await ensureGumboId(trx, final)
    }
    const moved = await moveAndClose(trx, closing, keeping)
    for (const ref of refs) await requireDirectAdmin(trx, ref)
    if (
      active &&
      user.is_admin &&
      (
        await trx
          .selectFrom('users')
          .select('id')
          .where('is_admin', '=', true)
          .where('login_enabled', '=', true)
          .where('disabled_at', 'is', null)
          .where('merged_into', 'is', null)
          .execute()
      ).length === 0
    )
      throw conflict(
        'Add another active node administrator before merging the last one'
      )
    return { closed: true, moved }
  }
  if (!db.isTransaction) return await db.transaction().execute(merge)

  const level = await sql<{
    level: string
  }>`select current_setting('transaction_isolation') as level`.execute(db)
  if (level.rows[0]?.level !== 'read committed') {
    throw new Error(
      `closeInto needs a read committed transaction, not ${level.rows[0]?.level}`
    )
  }
  return await merge(db as Transaction<Database>)
}

/** What one `closeInto` did. */
export interface Merge {
  /** Whether the row was closed: false when it was refused or a no-op. */
  closed: boolean
  /** The team rows that moved with it. */
  moved: number
}

/** The advisory lock every merge holds while it checks and writes. */
const MERGE_LOCK = 'users.closeInto'

/**
 * Roster writers take this before reading identities or locking any rows.
 * They may run together, but a merge must finish moving a person's rows
 * before another writer chooses their surviving account and membership.
 */
export async function lockPlayerEdits(
  trx: Transaction<Database>
): Promise<void> {
  await sql`select pg_advisory_xact_lock_shared(hashtextextended(${MERGE_LOCK}, 0))`.execute(
    trx
  )
}

/** The merge itself, once `closeInto` has the lock and has ruled out a loop. */
async function moveAndClose(
  db: Kysely<Database>,
  closing: string,
  keeping: string
): Promise<number> {
  const theirs = await db
    .selectFrom('memberships')
    .select(['id', 'team_id', 'jersey', 'positions', 'is_player'])
    .where('user_id', '=', closing)
    .execute()
  const already = new Map(
    (
      await db
        .selectFrom('memberships')
        .select(['id', 'team_id', 'jersey', 'positions', 'is_player'])
        .where('user_id', '=', keeping)
        .execute()
    ).map(row => [row.team_id, row])
  )

  let moved = 0
  for (const membership of theirs) {
    moved += 1
    const kept = already.get(membership.team_id)
    if (kept != null) {
      // One row out of two, and nothing only one of them knew is thrown away.
      const filled: {
        jersey?: string | null
        positions?: string[]
        is_player?: boolean
      } = {}
      // An empty string is a number nobody typed, the same as null: testing
      // only for null left `Dominic Smith` with `''` and threw away the #12
      // on the row that closed.
      const blank = (jersey: string | null): boolean =>
        jersey == null || jersey.trim() === ''
      if (blank(kept.jersey) && !blank(membership.jersey)) {
        filled.jersey = membership.jersey
      }
      if (kept.positions.length === 0 && membership.positions.length > 0) {
        filled.positions = membership.positions
      }
      if (!kept.is_player && membership.is_player) filled.is_player = true
      if (Object.keys(filled).length > 0) {
        await db
          .updateTable('memberships')
          .set(filled)
          .where('id', '=', kept.id)
          .execute()
      }
      await db
        .deleteFrom('memberships')
        .where('id', '=', membership.id)
        .execute()
      continue
    }
    await db
      .updateTable('memberships')
      .set({ user_id: keeping })
      .where('id', '=', membership.id)
      .execute()
    already.set(membership.team_id, {
      id: membership.id,
      team_id: membership.team_id,
      jersey: membership.jersey,
      positions: membership.positions,
      is_player: membership.is_player
    })
  }

  await keepTheFullerName(db, closing, keeping)

  await db
    .updateTable('users')
    .set({ merged_into: keeping })
    .where('id', '=', closing)
    .execute()
  await signOutEverywhere(db, closing)
  return moved
}

/**
 * Whether `row` has been closed into `into`, however many rows lie between.
 *
 * Followed to the end with no count of steps: a cap would let a chain longer
 * than it close a loop. A row seen twice ends the walk, so a loop already in
 * the data cannot hang it.
 */
async function closedInto(
  db: Kysely<Database>,
  row: string,
  into: string
): Promise<boolean> {
  const seen = new Set<string>([row])
  let at = row
  while (true) {
    const found = await db
      .selectFrom('users')
      .select(['merged_into'])
      .where('id', '=', at)
      .executeTakeFirst()
    const next = found?.merged_into
    if (next == null || seen.has(next)) return false
    if (next === into) return true
    seen.add(next)
    at = next
  }
}

/**
 * The surviving row takes the better of the two names.
 *
 * Which row survives is decided by how much history is on it, and the row a
 * scorer used all season is usually the one somebody typed as a bare first
 * name. So the fuller history and the fuller name are often on different rows,
 * and closing one into the other turned `Carson Kelly` into `Carson` on eight
 * children at once.
 *
 * Fuller means a longer surname that actually reads as one. `Lance (pool
 * Player)` is longer than `Lance` and is not a better name for a child.
 */
/** Whether one row's name is the better of the two to keep. */
export function isFullerName(
  from: { last_name: string | null },
  to: { last_name: string | null }
): boolean {
  const surname = (row: { last_name: string | null }): string => {
    const name = (row.last_name ?? '').trim()
    // Letters, and what a name is allowed to have in it. A bracket or a digit
    // means somebody left a note in the field rather than a surname.
    return /^\p{L}[\p{L}\s'’-]*$/u.test(name) ? name : ''
  }
  return surname(from).length > surname(to).length
}

export async function keepTheFullerName(
  db: Kysely<Database>,
  closing: string,
  keeping: string
): Promise<boolean> {
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'first_name', 'last_name'])
    .where('id', 'in', [closing, keeping])
    .execute()
  const from = rows.find(row => row.id === closing)
  const to = rows.find(row => row.id === keeping)
  if (from == null || to == null) return false

  if (!isFullerName(from, to)) return false

  await db
    .updateTable('users')
    .set({
      display_name: from.display_name,
      first_name: from.first_name,
      last_name: from.last_name,
      updated_at: new Date()
    })
    .where('id', '=', keeping)
    .execute()
  return true
}

/**
 * Moves what a merge left behind.
 *
 * Idempotent, and run every time the merge tool runs: rows closed before the
 * memberships moved with them are the reason a roster can be missing a child,
 * and there is no way to tell from the row itself whether it was tidied.
 *
 * Passes repeat until one moves nothing. A team row can land on a row that is
 * itself closed: `onePerson` stops counting after `MAX_DEPTH` rows, and another
 * merge can close the row a walk ended on before `closeInto` takes its lock.
 * The next pass moves it on. Every move goes up a chain that does not lead back
 * to the row it left (`closeInto` refuses that), so the passes end.
 *
 * `stranded` is what `strandedRows` finds afterwards: rows in, or closed into,
 * a `merged_into` loop, which `closeInto` will not add to and this does not
 * repair.
 */
export async function tidyClosedRows(
  db: Kysely<Database>
): Promise<{ moved: number; stranded: string[] }> {
  let moved = 0
  while (true) {
    let pass = 0
    for (const userId of await closedRowsHoldingTeams(db)) {
      // Through the chain, not one step: a row can be closed into a row that
      // was itself closed later.
      const person = await onePerson(db, userId)
      pass += (await closeInto(db, userId, person.userId)).moved
    }
    moved += pass
    if (pass === 0) break
  }
  return { moved, stranded: await strandedRows(db) }
}

/**
 * Closed rows that hold team rows a tidy cannot move: their chain, followed to
 * its end, reaches no open row. Read-only, so a dry run can show them too.
 * Each keeps a person off every roster until somebody opens the loop by hand.
 */
export async function strandedRows(db: Kysely<Database>): Promise<string[]> {
  const stranded: string[] = []
  for (const userId of await closedRowsHoldingTeams(db)) {
    if ((await openEnd(db, userId)) == null) stranded.push(userId)
  }
  return stranded.sort()
}

/** Every closed row that still holds a team row. */
async function closedRowsHoldingTeams(db: Kysely<Database>): Promise<string[]> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select(['memberships.user_id as userId'])
    .where('users.merged_into', 'is not', null)
    .distinct()
    .execute()
  return rows.map(row => row.userId)
}

/**
 * The open row at the end of `row`'s chain, followed with no count of steps,
 * or undefined when the chain comes back on itself before reaching one.
 */
async function openEnd(
  db: Kysely<Database>,
  row: string
): Promise<string | undefined> {
  const seen = new Set<string>([row])
  let at = row
  while (true) {
    const found = await db
      .selectFrom('users')
      .select(['merged_into'])
      .where('id', '=', at)
      .executeTakeFirst()
    const next = found?.merged_into
    if (next == null) return at
    if (seen.has(next)) return undefined
    seen.add(next)
    at = next
  }
}

/** The line a merge tool prints for the rows `strandedRows` finds. */
export function strandedNote(stranded: string[]): string | undefined {
  if (stranded.length === 0) return undefined
  const one = stranded.length === 1
  return (
    `${stranded.length} closed ${one ? 'row still holds' : 'rows still hold'} ` +
    `team rows, in a merge loop that leaves no row open: ` +
    `${stranded.join(', ')}. ` +
    `${one ? 'That person is' : 'Those people are'} on no roster until the ` +
    'loop is opened by hand.'
  )
}

export class UnresolvedAccount extends Error {}

/** Who each of these ids is now, for a read that has rows rather than a name. */
export async function survivorsOf(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Map<string, string>> {
  const next = new Map<string, string | null>()
  let pending = [...new Set(userIds)]
  while (pending.length > 0) {
    const rows = await db
      .selectFrom('users')
      .select(['id', 'merged_into'])
      .where('id', 'in', pending)
      .execute()
    if (rows.length !== pending.length)
      throw new UnresolvedAccount('Missing account in merge chain')
    for (const row of rows) next.set(row.id, row.merged_into)
    pending = [
      ...new Set(
        rows.flatMap(row =>
          row.merged_into == null || next.has(row.merged_into)
            ? []
            : [row.merged_into]
        )
      )
    ]
  }
  const survivors = new Map<string, string>()
  for (const source of userIds) {
    const seen = new Set<string>()
    let id = source
    while (next.get(id) != null) {
      if (seen.has(id)) throw new UnresolvedAccount('Cyclic account merge')
      seen.add(id)
      id = next.get(id)!
    }
    survivors.set(source, id)
  }
  return survivors
}

/**
 * Splits a group of rows into the fewest people who were never in a game
 * together.
 *
 * One pair sharing a game does not make every row in the group a stranger.
 * `Casey` and one `Casey Mize` both played on 11 April, which makes two
 * boys — but the other two `Casey Mize` rows share a game with nobody and
 * wear #10 and #4 on the same two teams as each other, and taking the whole
 * group apart turned one boy into three.
 *
 * Greedy and ordered by how much history each row carries, so the fullest row
 * anchors the first person and the rest join whoever they can. A row that
 * clashes with everybody ends up alone, which is what it should be.
 */
export function splitByClash(
  rows: Array<{ userId: string; weight: number }>,
  clashes: Set<string>
): string[][] {
  const order = [...rows].sort((a, b) => b.weight - a.weight)
  const people: string[][] = []
  for (const row of order) {
    const home = people.find(
      person => !person.some(held => clashes.has(`${held}|${row.userId}`))
    )
    if (home == null) people.push([row.userId])
    else home.push(row.userId)
  }
  return people
}
