import { type Kysely, sql } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { withHalfOuts } from '../../common/scoring/linescore'
import { type CompleteHalf, completeHalves } from '../../common/sponsors/halves'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { creditsFor } from './credits'

/** How long game audio takes to fade under a reel, and back. */
export const REEL_FADE_MS = 1000

/** After a half-inning ends, how long until its reel starts. */
export const HALF_REEL_DELAY_MS = 10 * 1000

/** How long an end waits for an undo before its reel is placed: the fade starts then. */
export const HALF_WAIT_MS = HALF_REEL_DELAY_MS - REEL_FADE_MS

/** How late after its official start a game may still get its pre-game reel. */
export const PREGAME_GRACE_MS = 5 * 60 * 1000

/** How many players a sponsored team needs for its pre-game reel. */
export const PREGAME_PLAYERS = 9

/** How often the reel sweeps look for slots. */
export const REEL_SWEEP_MS = 1000

/** One league's track of reels in a game. */
export interface ReelTrack {
  leagueId: string
  /** The game's teams in this league. */
  teamIds: string[]
  /** Some team of the track has nine players: the pre-game reel may play. */
  ready: boolean
}

/**
 * A game's reel tracks: one for each league its home and away teams belong
 * to, in league id order. A track's teams are the game's teams in that
 * league, both when they share one, and it is ready for the pre-game reel
 * when one of them has nine players.
 */
export async function gameTracks(
  db: Kysely<Database>,
  gameId: string
): Promise<ReelTrack[]> {
  const game = await db
    .selectFrom('games')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.home_team_id as homeId',
      'games.away_team_id as awayId',
      'home.league_id as home',
      'away.league_id as away'
    ])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (game == null) return []
  const sides = [
    { teamId: game.homeId, leagueId: game.home ?? null },
    { teamId: game.awayId, leagueId: game.away ?? null }
  ].filter(
    (side): side is { teamId: string; leagueId: string } =>
      side.teamId != null && side.leagueId != null
  )
  const leagues = [...new Set(sides.map(side => side.leagueId))].sort()
  const teamIds = [...new Set(sides.map(side => side.teamId))]
  const players =
    teamIds.length === 0
      ? []
      : await db
          .selectFrom('memberships')
          .select(['team_id', sql<number>`count(*)::int`.as('players')])
          .where('team_id', 'in', teamIds)
          .where('is_player', '=', true)
          .groupBy('team_id')
          .execute()
  const playersOf = new Map(players.map(row => [row.team_id, row.players]))
  return leagues.map(leagueId => {
    const ids = [
      ...new Set(
        sides
          .filter(side => side.leagueId === leagueId)
          .map(side => side.teamId)
      )
    ]
    return {
      leagueId,
      teamIds: ids,
      ready: ids.some(id => (playersOf.get(id) ?? 0) >= PREGAME_PLAYERS)
    }
  })
}

/** The game is being recorded now: one of its real videos is live. */
export async function hasLiveRecording(
  db: Kysely<Database>,
  gameId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('videos')
    .select('id')
    .where('game_id', '=', gameId)
    .where('status', '=', 'live')
    .where('hidden', '=', false)
    .executeTakeFirst()
  return row != null
}

/** Where a reel goes: before the game, or after a half-inning. */
export type ReelSlot =
  { slot: 'pregame' } | { slot: 'half'; inning: number; half: 'top' | 'bottom' }

/**
 * Places the league's next reel in a game's slot, starting at `startsAt`:
 * under the league's credits lock, the first active reel with broadcasts
 * left after the last one placed, round-robin in acceptance order, while the
 * league's broadcasts are below its reel credits. One placement is one
 * broadcast, and so one of the reel's and one of the league's credits.
 *
 * With no candidate nothing is placed. A slot already placed is kept, and
 * nothing more is used. Answers the placement's id, or null.
 */
export async function placeReel(
  db: Kysely<Database>,
  gameId: string,
  leagueId: string,
  slot: ReelSlot,
  startsAt: Date
): Promise<string | null> {
  return await atomic(db, async trx => {
    const credits = await creditsFor(trx, leagueId, { lock: true })
    const { used } = await trx
      .selectFrom('sponsor_reels')
      .select(sql<number>`coalesce(sum(used), 0)::int`.as('used'))
      .where('league_id', '=', leagueId)
      .executeTakeFirstOrThrow()
    if (used >= credits.reel_credits) return null
    const candidates = await trx
      .selectFrom('sponsor_reels')
      .select(['id', 'media_id', 'position', 'duration_ms'])
      .where('league_id', '=', leagueId)
      .where('active', '=', true)
      .whereRef('used', '<', 'allocation')
      .orderBy('position')
      .execute()
    const chosen =
      candidates.find(each => each.position > credits.reel_turn) ??
      candidates[0]
    if (chosen == null) return null
    const id = makeId('reelPlacement')
    const placed = await trx
      .insertInto('game_reel_placements')
      .values({
        id,
        game_id: gameId,
        league_id: leagueId,
        reel_id: chosen.id,
        media_id: chosen.media_id,
        slot: slot.slot,
        inning: slot.slot === 'half' ? slot.inning : null,
        half: slot.slot === 'half' ? slot.half : null,
        starts_at: startsAt,
        duration_ms: chosen.duration_ms
      })
      .onConflict(oc => oc.doNothing())
      .returning('id')
      .executeTakeFirst()
    if (placed == null) return null
    await trx
      .updateTable('sponsor_reels')
      .set(eb => ({ used: eb('used', '+', 1) }))
      .where('id', '=', chosen.id)
      .execute()
    await trx
      .updateTable('league_sponsor_credits')
      .set({ reel_turn: chosen.position })
      .where('league_id', '=', leagueId)
      .execute()
    return id
  })
}

/**
 * Places the pre-game reels due at `now`, run every second. A game gets one
 * for each of its tracks once that track is ready for it (a sponsored team
 * with nine players), whether or not the other track's is placed yet,
 * from a second before its official start (`games.start_at`) to five minutes
 * after, while it is being recorded live and nothing has been scored. It
 * starts at the official start, or a second from now when the stream began
 * late, so the fade that starts now ends as the reel begins. Answers the
 * games given a reel.
 */
export async function placePregameReels(
  db: Kysely<Database>,
  now: Date
): Promise<string[]> {
  const games = await db
    .selectFrom('games')
    .select(['games.id', 'games.start_at'])
    .where('games.start_at', '<=', new Date(now.getTime() + REEL_FADE_MS))
    .where('games.start_at', '>=', new Date(now.getTime() - PREGAME_GRACE_MS))
    .where(eb =>
      eb.exists(
        eb
          .selectFrom('videos')
          .select('videos.id')
          .whereRef('videos.game_id', '=', 'games.id')
          .where('videos.status', '=', 'live')
          .where('videos.hidden', '=', false)
      )
    )
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('events')
            .select('events.id')
            .whereRef('events.gameId', '=', 'games.id')
            .where('events.hidden', '=', false)
        )
      )
    )
    .execute()
  const placed: string[] = []
  for (const game of games) {
    const startAt = new Date(game.start_at).getTime()
    const startsAt = new Date(Math.max(startAt, now.getTime() + REEL_FADE_MS))
    // Each track has its own: one placed already leaves the other to come.
    const had = await db
      .selectFrom('game_reel_placements')
      .select('league_id')
      .where('game_id', '=', game.id)
      .where('slot', '=', 'pregame')
      .execute()
    const done = new Set(had.map(row => row.league_id))
    let any = false
    for (const track of await gameTracks(db, game.id)) {
      if (!track.ready || done.has(track.leagueId)) continue
      // Every second of the window: a league with no reel to place (every
      // league at launch) takes no credits lock and writes nothing.
      if (!(await anyReelLeft(db, [track.leagueId]))) continue
      const id = await placeReel(
        db,
        game.id,
        track.leagueId,
        { slot: 'pregame' },
        startsAt
      )
      any ||= id != null
    }
    if (any) placed.push(game.id)
  }
  return placed
}

/**
 * The halves a game's plays have ended, and the newest of those plays' at-bat
 * index (null with none). A stored play an undo has reopened, the at-bat
 * being scored again (`games.currentPlay`), is not over, so the half it
 * ended is not either until it closes again.
 */
async function endedPlays(
  db: Kysely<Database>,
  gameId: string
): Promise<{ halves: CompleteHalf[]; last: number | null }> {
  const game = await db
    .selectFrom('games')
    .select('currentPlay')
    .where('id', '=', gameId)
    .executeTakeFirst()
  const current = game?.currentPlay as {
    about?: { atBatIndex?: unknown }
  } | null
  const reopened = current?.about?.atBatIndex
  const kept = (await readPlays(db, gameId)).filter(
    row => row.atBatIndex !== reopened
  )
  return {
    halves: completeHalves(
      withHalfOuts(kept.map(row => row.gumbo as GumboPlay))
    ),
    last: kept.at(-1)?.atBatIndex ?? null
  }
}

async function endedHalves(
  db: Kysely<Database>,
  gameId: string
): Promise<CompleteHalf[]> {
  return (await endedPlays(db, gameId)).halves
}

/**
 * Whether a league of the game's teams has an active reel with broadcasts
 * left: two indexed reads, so a write to a game no reel can follow reads no
 * plays.
 */
async function hasReelLeft(
  db: Kysely<Database>,
  gameId: string
): Promise<boolean> {
  const game = await db
    .selectFrom('games')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select(['home.league_id as home', 'away.league_id as away'])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  const leagues = [game?.home, game?.away].filter(
    (id): id is string => id != null
  )
  return await anyReelLeft(db, leagues)
}

/**
 * Whether one of these leagues has an active reel with broadcasts left, read
 * without a lock: `placeReel` asks again under the league's credits lock, so
 * this only keeps a league with nothing to place from taking that lock.
 */
async function anyReelLeft(
  db: Kysely<Database>,
  leagues: string[]
): Promise<boolean> {
  if (leagues.length === 0) return false
  const row = await db
    .selectFrom('sponsor_reels')
    .select('id')
    .where('league_id', 'in', leagues)
    .where('active', '=', true)
    .whereRef('used', '<', 'allocation')
    .executeTakeFirst()
  return row != null
}

const halfKey = (half: { inning: number; half: string }): string =>
  `${half.inning}:${half.half}`

/**
 * What a committed write to a game means for its half-inning reels, called
 * after each one (the `onGameWritten` hook). A game no league of its teams
 * has a reel with broadcasts left for is not looked at: no lock, no plays
 * read. Otherwise, with the halves the plays have ended and the ends already
 * seen:
 *
 * - an end waiting or skipped whose half is no longer ended, or no longer by
 *   the same play, was undone, and is forgotten; one placed stays;
 * - a half newly ended, alone, the game's newest, by its newest play, while
 *   the game is recorded live, waits nine seconds for an undo (`fade_at`);
 *   any other newly ended half (two at once, an older one, one later plays
 *   have followed, one with no live recording) is skipped for good;
 * - an end already seen is never written again, so another write inside the
 *   nine seconds leaves the wait as it was.
 *
 * Answers the halves that began waiting.
 */
export async function noteHalfInnings(
  db: Kysely<Database>,
  gameId: string,
  now: Date
): Promise<CompleteHalf[]> {
  if (!(await hasReelLeft(db, gameId))) return []
  return await atomic(db, async trx => {
    // One write's look at a game at a time, so two posts agree on what is new.
    await lockKeys(trx, [`halfEnds:${gameId}`])
    const { halves: ended, last } = await endedPlays(trx, gameId)
    const seen = await trx
      .selectFrom('game_half_ends')
      .select(['inning', 'half', 'at_bat_index', 'state'])
      .where('game_id', '=', gameId)
      .execute()
    const endedBy = new Map(ended.map(half => [halfKey(half), half]))
    const undone = seen.filter(row => {
      if (row.state === 'placed') return false
      return endedBy.get(halfKey(row))?.atBatIndex !== row.at_bat_index
    })
    for (const row of undone)
      await trx
        .deleteFrom('game_half_ends')
        .where('game_id', '=', gameId)
        .where('inning', '=', row.inning)
        .where('half', '=', row.half)
        .execute()
    const kept = new Set(
      seen.filter(row => !undone.includes(row)).map(row => halfKey(row))
    )
    const fresh = ended.filter(half => !kept.has(halfKey(half)))
    if (fresh.length === 0) return []
    const newest = ended.at(-1)
    // By the newest play: a half that ended before the game had a reel to
    // follow it, with plays since, is long over.
    const waits =
      fresh.length === 1 &&
      halfKey(fresh[0]) === halfKey(newest!) &&
      fresh[0].atBatIndex === last &&
      (await hasLiveRecording(trx, gameId))
    await trx
      .insertInto('game_half_ends')
      .values(
        fresh.map(half => ({
          game_id: gameId,
          inning: half.inning,
          half: half.half,
          at_bat_index: half.atBatIndex,
          state: waits ? ('waiting' as const) : ('skipped' as const),
          fade_at: waits ? new Date(now.getTime() + HALF_WAIT_MS) : null
        }))
      )
      .onConflict(oc => oc.doNothing())
      .execute()
    return waits ? fresh : []
  })
}

/**
 * The hook a committed write to a game calls, fire and forget: it notes the
 * game's half-inning ends (`noteHalfInnings`), and a failure is only logged.
 */
export function halfInningHook(options: {
  db: Kysely<Database>
  log: (message: string) => void
  now?: () => Date
}): (gameId: string) => void {
  const now = options.now ?? (() => new Date())
  return gameId => {
    noteHalfInnings(options.db, gameId, now()).catch((error: unknown) => {
      options.log(
        `sponsor reels: game ${gameId} half-innings not noted: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
}

/**
 * Places the half-inning reels whose nine seconds are up at `now`, run every
 * second. Each end waiting is claimed (`for update skip locked`, so two
 * sweeps place it once), and the plays are read again: a half still ended by
 * the same play gets a reel on every track, starting a second after its
 * fade, ten seconds after the play, and is marked placed; one undone since
 * is forgotten. Answers the games given a reel.
 */
export async function placeDueReels(
  db: Kysely<Database>,
  now: Date
): Promise<string[]> {
  const due = await db
    .selectFrom('game_half_ends')
    .select(['game_id', 'inning', 'half'])
    .where('state', '=', 'waiting')
    .where('fade_at', '<=', now)
    .orderBy('fade_at')
    .execute()
  const placed = new Set<string>()
  for (const end of due) {
    const any = await atomic(db, async trx => {
      const row = await trx
        .selectFrom('game_half_ends')
        .select(['at_bat_index', 'fade_at'])
        .where('game_id', '=', end.game_id)
        .where('inning', '=', end.inning)
        .where('half', '=', end.half)
        .where('state', '=', 'waiting')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (row?.fade_at == null) return false
      const still = (await endedHalves(trx, end.game_id)).some(
        half =>
          halfKey(half) === halfKey(end) && half.atBatIndex === row.at_bat_index
      )
      const where = trx
        .updateTable('game_half_ends')
        .where('game_id', '=', end.game_id)
        .where('inning', '=', end.inning)
        .where('half', '=', end.half)
      if (!still) {
        await trx
          .deleteFrom('game_half_ends')
          .where('game_id', '=', end.game_id)
          .where('inning', '=', end.inning)
          .where('half', '=', end.half)
          .execute()
        return false
      }
      const startsAt = new Date(new Date(row.fade_at).getTime() + REEL_FADE_MS)
      let any = false
      for (const track of await gameTracks(trx, end.game_id)) {
        const id = await placeReel(
          trx,
          end.game_id,
          track.leagueId,
          { slot: 'half', inning: end.inning, half: end.half },
          startsAt
        )
        any ||= id != null
      }
      await where.set({ state: 'placed' }).execute()
      return any
    })
    if (any) placed.add(end.game_id)
  }
  return [...placed]
}
