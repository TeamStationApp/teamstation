import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * Pairs who were on the field at the same time, which is two children.
 *
 * The strongest evidence there is against a merge, and it comes from the play
 * itself rather than from a name. One child is one person: two rows named on
 * plays in **the same half-inning** were both out there at once.
 *
 * The half-inning is what makes this sharp rather than merely broad. A scorer
 * re-adding somebody mid-season leaves two rows in one game — the old one
 * fields early, the new one bats later — and they are never in the same half.
 * `Jameson Kerins` was *pitching* in the top of the second while `Jameson`
 * fielded behind him, which no child can do; `Lucas` and `Lucas Flores` never
 * share a half, and a game where one holds an empty line beside the other is
 * the re-added shape rather than two boys.
 *
 * A number settles nothing here, whatever it looks like: eleven numbers on the
 * server are worn by two different children on one team.
 *
 * The figures are asked as well, because a game whose plays we never tagged
 * has no half-innings to compare — two rows that both batted in one game are
 * two boys however little else we hold.
 *
 * Returned as a set of `a|b` pairs, both ways round, so a caller can ask about
 * a candidate without another query. Ask about **every** pair in a group and
 * not just the two rows in front of you: `Wesley Boren` was closed into
 * another `Wesley Boren` and that one into `Wesley`, and the two ends of the
 * chain both batted on 11 April — a pairwise test at each step saw nothing.
 */
export async function bothPlayedTogether(
  db: Kysely<Database>,
  userIds: number[]
): Promise<Set<string>> {
  const together = new Set<string>()
  if (userIds.length < 2) return together

  const wanted = [...new Set(userIds)]
  const byGame = new Map<string, number[]>()
  const note = (gameId: string, userId: number): void => {
    const held = byGame.get(gameId) ?? []
    if (!held.includes(userId)) held.push(userId)
    byGame.set(gameId, held)
  }

  // Everybody named on a play, in any part: batting, pitching, fielding, on
  // base — gathered per half-inning, which is the window a child can only be
  // in one place in.
  for (const row of await db
    .selectFrom('event_players')
    .innerJoin('events', 'events.id', 'event_players.event_id')
    .select([
      'events.gameId as gameId',
      'events.inning as inning',
      'events.halfInning as half',
      'event_players.user_id as userId'
    ])
    .where('event_players.user_id', 'in', wanted)
    .execute()) {
    note(`${row.gameId} ${row.inning ?? ''} ${row.half ?? ''}`, row.userId)
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
