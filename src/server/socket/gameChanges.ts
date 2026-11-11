import {
  asArray,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'
import { type Kysely, sql } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { asUserId } from '../../common/userId'
import { anyOf } from '../db/anyOf'
import type { Database } from '../db/database'

/**
 * The channel every write that changes a game announces itself on.
 *
 * Each worker holds one `LISTEN` on it (`fanout.ts`) and passes a change on to
 * the sockets it has subscribed to that game, so a write in one worker reaches
 * a viewer connected to another. A notify is delivered when its transaction
 * commits, so a write that rolls back announces nothing.
 */
export const GAME_CHANGES_CHANNEL = 'game_changes'

/** What a game's own writes announce. */
export type GameNotifyKind = 'playEdits' | 'game' | 'lineups' | 'plans'

/**
 * A change to a game's stored plays. A live post that leaves stored plays
 * names the digests it took the game from and to and the indexes it put and
 * took away, and leaves the publicly named frame in Valkey under
 * `playEditsKey`. Every other writer, and a post that changed too much to
 * name or changed the game's name scope, sends only the game and its
 * generation: read the game again. Such a post also names the `digest` it
 * left, so its own sender, who holds that, reads nothing. A post names the
 * `namesDigest` of the book it named its plays from (`NameBook.digest`)
 * either way: a lapsed hold can rename a player with nothing written, and a
 * viewer holding another book's names reads again.
 */
export interface PlayEditsNotice {
  game: string
  kind: 'playEdits'
  generation: number
  fromDigest?: string
  digest?: string
  namesDigest?: string
  indexes?: number[]
  removed?: number[]
}

/**
 * The payloads: one game's change, or a player's song on one team. A game
 * plan's save names its team as `teamId`, never `team`, which is the song's:
 * the plan is the game's own change, and only its viewers hear it.
 */
export type GameChangePayload =
  | { game: string; kind: 'game' }
  | { game: string; kind: 'lineups' }
  | { game: string; kind: 'plans'; teamId: string }
  | PlayEditsNotice
  | { team: string; kind: 'walkUpSong'; userId: string }

/**
 * A worker from before `playEdits` sends `{ game, kind: 'plays' }`, which
 * meant read the plays again, so a viewer on this worker still hears a pitch
 * scored through an older one while both run. It is read as the re-read form,
 * under a generation no game has (they count up from 0), so delivery answers
 * it with the game's own. This covers one direction of a rolling deploy only:
 * an older worker refuses every `playEdits` notice as one that does not read,
 * so its viewers hear no pitch scored through a newer worker, and miss them
 * until the rollout ends and they are on new workers.
 */
// Remove once no worker older than `playEdits` runs: the release after it.
const asLegacyPlays = (raw: unknown): PlayEditsNotice => ({
  game: asObject({ game: asString, kind: asLiteral('plays') })(raw).game,
  kind: 'playEdits',
  generation: -1
})

export const asGameChangePayload = asEither(
  asLegacyPlays,
  asObject({
    game: asString,
    kind: asLiteral('playEdits'),
    generation: asNumber,
    fromDigest: asOptional(asString),
    digest: asOptional(asString),
    namesDigest: asOptional(asString),
    indexes: asOptional(asArray(asNumber)),
    removed: asOptional(asArray(asNumber))
  }),
  asObject({
    game: asString,
    kind: asLiteral('game', 'lineups')
  }),
  asObject({
    game: asString,
    kind: asLiteral('plans'),
    teamId: asString
  }),
  asObject({
    team: asString,
    kind: asLiteral('walkUpSong'),
    userId: asUserId
  })
)

/**
 * The most indexes, put and removed together, a notice names. A post that
 * writes more sends the read-again form: a notify must stay small, and a
 * change that large is read whole anyway.
 */
export const MAX_NOTICE_INDEXES = 200

/** How long a post's frame waits in Valkey for the workers to deliver it. */
export const PLAY_EDITS_TTL_MS = 60_000

/**
 * Where a post leaves its publicly named frame (under the cache's prefix).
 * The key names both digests and the book's, so a frame left by a post that
 * rolled back describes the same change, named the same way, as any later
 * commit between those digests under that book.
 */
export function playEditsKey(notice: {
  game: string
  generation: number
  fromDigest: string
  digest: string
  namesDigest: string
}): string {
  return `playEdits:${notice.game}:${notice.generation}:${notice.fromDigest}:${notice.digest}:${notice.namesDigest}`
}

/** Announces a change, inside the caller's transaction. */
export async function notifyGameChange(
  db: Kysely<Database>,
  payload: GameChangePayload
): Promise<void> {
  await sql`select pg_notify(${GAME_CHANGES_CHANNEL}, ${JSON.stringify(payload)})`.execute(
    db
  )
}

/**
 * Announces that a game's plays changed and are to be read again, with the
 * game's play generation as the transaction leaves it, in one statement.
 */
export async function notifyPlaysChanged(
  db: Kysely<Database>,
  gameId: string
): Promise<void> {
  await sql`
    select pg_notify(
      ${GAME_CHANGES_CHANNEL},
      json_build_object(
        'game', id, 'kind', 'playEdits', 'generation', play_generation
      )::text
    )
    from games where id = ${gameId}
  `.execute(db)
}

/**
 * Has the viewers of every game in progress that these people play in, or
 * these teams play, read its plays again, in one statement. A game's viewers
 * are sent only the plays a post wrote, so a change to how its players are
 * named (a rename, a team's name format) would otherwise reach the plays
 * already held only when they next read the whole game. A person plays in a
 * game through its `event_players` or a membership on either team.
 */
export async function notifyLiveGamesRenamed(
  db: Kysely<Database>,
  of: { users?: readonly string[]; teams?: readonly string[] }
): Promise<void> {
  const users = of.users ?? []
  const teams = of.teams ?? []
  if (users.length === 0 && teams.length === 0) return
  await db
    .selectFrom('games')
    .select(
      sql`pg_notify(
        ${GAME_CHANGES_CHANNEL},
        json_build_object(
          'game', games.id, 'kind', 'playEdits',
          'generation', games.play_generation
        )::text
      )`.as('told')
    )
    .where('games.status', '=', 'inProgress')
    .where(eb =>
      eb.or([
        eb('games.home_team_id', '=', anyOf(teams)),
        eb('games.away_team_id', '=', anyOf(teams)),
        eb.exists(
          eb
            .selectFrom('memberships')
            .select('memberships.id')
            .where('memberships.user_id', '=', anyOf(users))
            .where(member =>
              member.or([
                member(
                  'memberships.team_id',
                  '=',
                  member.ref('games.home_team_id')
                ),
                member(
                  'memberships.team_id',
                  '=',
                  member.ref('games.away_team_id')
                )
              ])
            )
        ),
        eb.exists(
          eb
            .selectFrom('event_players')
            .innerJoin('events', 'events.id', 'event_players.event_id')
            .innerJoin(
              'gumbo_ids',
              'gumbo_ids.gumbo_id',
              'event_players.gumbo_id'
            )
            .select('event_players.id')
            .whereRef('events.gameId', '=', 'games.id')
            .where('gumbo_ids.user_id', '=', anyOf(users))
        )
      ])
    )
    .execute()
}
