import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

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
 * Jensen Puey is why. An import issues a player id per team, so five teams
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
 * Closes one row into another: the merge itself.
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
 */
export async function closeInto(
  db: Kysely<Database>,
  closing: string,
  keeping: string
): Promise<number> {
  if (closing === keeping) return 0

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
      // only for null left `Dominic Mason` with `''` and threw away the #12
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
  return moved
}

/**
 * The surviving row takes the better of the two names.
 *
 * Which row survives is decided by how much history is on it, and the row a
 * scorer used all season is usually the one somebody typed as a bare first
 * name. So the fuller history and the fuller name are often on different rows,
 * and closing one into the other turned `Carson Roper` into `Carson` on eight
 * children at once.
 *
 * Fuller means a longer surname that actually reads as one. `Lanson (pool
 * Player)` is longer than `Lanson` and is not a better name for a child.
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
 */
export async function tidyClosedRows(db: Kysely<Database>): Promise<number> {
  const stranded = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select(['memberships.user_id as userId', 'users.merged_into as keeping'])
    .where('users.merged_into', 'is not', null)
    .distinct()
    .execute()

  let moved = 0
  for (const row of stranded) {
    if (row.keeping == null) continue
    // Through the chain, not one step: a row can be closed into a row that was
    // itself closed later.
    const person = await onePerson(db, row.userId)
    moved += await closeInto(db, row.userId, person.userId)
  }
  return moved
}

/** Who each of these ids is now, for a read that has rows rather than a name. */
export async function survivorsOf(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Map<string, string>> {
  const survivors = new Map<string, string>()
  if (userIds.length === 0) return survivors
  const rows = await db
    .selectFrom('users')
    .select(['id', 'merged_into'])
    .where('id', 'in', [...new Set(userIds)])
    .execute()

  const closedInto = new Map<string, string>()
  for (const row of rows) {
    if (row.merged_into != null) closedInto.set(row.id, row.merged_into)
  }
  for (const row of rows) {
    let id = row.id
    const walked = new Set<string>([id])
    while (true) {
      const next = closedInto.get(id)
      if (next == null || walked.has(next)) break
      walked.add(next)
      id = next
      // The chain can leave the batch, and then one more lookup settles it.
      if (!closedInto.has(id)) {
        const beyond = await db
          .selectFrom('users')
          .select(['merged_into'])
          .where('id', '=', id)
          .executeTakeFirst()
        if (beyond?.merged_into == null) break
        closedInto.set(id, beyond.merged_into)
      }
    }
    survivors.set(row.id, id)
  }
  return survivors
}

/**
 * Pairs who were both in the same game, which is two children.
 *
 * The strongest evidence there is against a merge, and it comes from the play
 * itself rather than from a name. One child is one person on a field: two rows
 * that were both named on a play in one game are two boys.
 *
 * Every part counts, not just batting. `Lincoln` batted four times while
 * `Lincoln Skipper` fielded in the same game with no stat line at all, and a
 * test that only read plate appearances made them one child. The one shape
 * this still allows is a scorer re-adding somebody mid-season — `Adrian Hardy`
 * has a new row that bats and an old one with an empty line, and the two are
 * never named on a play together.
 *
 * Returned as a set of `a|b` pairs, both ways round, so a caller can ask about
 * a candidate without another query. Ask about **every** pair in a group and
 * not just the two rows in front of you: `Wesley Boren` was closed into
 * another `Wesley Boren` and that one into `Wesley`, and the two ends of the
 * chain both batted on 11 April — a pairwise test at each step saw nothing.
 */
export async function bothPlayedTogether(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Set<string>> {
  const together = new Set<string>()
  if (userIds.length < 2) return together

  const wanted = [...new Set(userIds)]
  const byGame = new Map<string, string[]>()
  const note = (gameId: string, userId: string): void => {
    const held = byGame.get(gameId) ?? []
    if (!held.includes(userId)) held.push(userId)
    byGame.set(gameId, held)
  }

  // Everybody named on a play, in any part: batting, pitching, fielding, on
  // base. This is the one that catches a boy who only took the field.
  for (const row of await db
    .selectFrom('event_players')
    .innerJoin('events', 'events.id', 'event_players.event_id')
    .select(['events.game_id as gameId', 'event_players.user_id as userId'])
    .where('event_players.user_id', 'in', wanted)
    .execute()) {
    note(row.gameId, row.userId)
  }

  // And anybody with a figure in a game, for a game whose plays we never
  // tagged. An empty line is a lineup slot rather than an appearance.
  for (const row of await db
    .selectFrom('game_player_stats')
    .select(['game_id', 'user_id', 'pa', 'pitch_outs'])
    .where('user_id', 'in', wanted)
    .execute()) {
    if (row.pa === 0 && row.pitch_outs === 0) continue
    note(row.game_id, row.user_id)
  }
  for (const players of byGame.values()) {
    for (const one of players) {
      for (const other of players) {
        if (one !== other) together.add(`${one}|${other}`)
      }
    }
  }
  return together
}
