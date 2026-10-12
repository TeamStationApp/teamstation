import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { asUserId } from '../../common/userIdNumber'
import { asWalkUpSong, type WalkUpSong } from '../../common/walkUpSong'
import { canKeepSongs, guardsPlayer, roleScopes } from '../access'
import type { Database, WalkUpSongsTable } from '../db/database'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { notifyGameChange } from '../socket/gameChanges'

/**
 * Each player's walk-up song on a team.
 *
 * A songkeeper or scorekeeper of the team — the flag set on the team, its
 * season or its league — an admin of any of those, a site admin, and a
 * guardian of the player, for their own child alone, may set or remove one.
 * Anybody else, and a target who is not a player on the team, is answered
 * 404. Both writes are audited, and both announce the change on the game
 * socket as `{ team, kind: 'walkUpSong', userId }`, which reaches every
 * subscribed game the team plays in, whatever its status or date.
 *
 * Reading the songs needs no route of its own: each roster entry carries
 * its player's song on that team.
 */
export function walkUpSongRoutes(db: Kysely<Database>): Router {
  const router = Router()

  /** The team and player a request names, once the caller may change them. */
  const songPlace = async (
    actor: { userId: number; isAdmin: boolean },
    params: Record<string, string | string[] | undefined>
  ): Promise<{ teamId: string; userId: number }> => {
    const teamId = pathParam(params.teamId)
    const userId = userIdParam(params.userId)
    const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
    if (
      !canKeepSongs(scopes, teamId) &&
      !(await guardsPlayer(db, actor.userId, userId))
    )
      throw notFound()
    const player = await db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('memberships.id')
      .where('memberships.team_id', '=', teamId)
      .where('memberships.user_id', '=', userId)
      .where('memberships.is_player', '=', true)
      .where('users.merged_into', 'is', null)
      .executeTakeFirst()
    if (player == null) throw notFound()
    return { teamId, userId }
  }

  router.put(
    '/teams/:teamId/players/:userId/walk-up-song',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { teamId, userId } = await songPlace(actor, req.params)
      const song = cleanBody(asWalkUpSong, req.body)

      const row = {
        team_id: teamId,
        user_id: userId,
        provider: song.provider,
        provider_id: song.providerId,
        isrc: song.isrc,
        title: song.title,
        artist: song.artist,
        album: song.album,
        artwork_url: song.artworkUrl,
        duration_ms: song.durationMs,
        start_ms: song.startMs,
        end_ms: song.endMs,
        set_by: actor.userId,
        set_at: new Date()
      }
      const before = await db.transaction().execute(async trx => {
        const was = await readWalkUpSong(trx, teamId, userId)
        await trx
          .insertInto('walk_up_songs')
          .values(row)
          .onConflict(conflict =>
            conflict.columns(['team_id', 'user_id']).doUpdateSet(row)
          )
          .execute()
        await notifyGameChange(trx, {
          team: teamId,
          kind: 'walkUpSong',
          userId
        })
        return was
      })

      setAudit(res.locals, {
        entityType: 'walkUpSong',
        entityId: userId,
        before: { teamId, song: before },
        after: { teamId, song }
      })
      res.json(song)
    })
  )

  router.delete(
    '/teams/:teamId/players/:userId/walk-up-song',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const { teamId, userId } = await songPlace(actor, req.params)

      const before = await db.transaction().execute(async trx => {
        const was = await readWalkUpSong(trx, teamId, userId)
        if (was == null) return null
        await trx
          .deleteFrom('walk_up_songs')
          .where('team_id', '=', teamId)
          .where('user_id', '=', userId)
          .execute()
        await notifyGameChange(trx, {
          team: teamId,
          kind: 'walkUpSong',
          userId
        })
        return was
      })

      // Removing a song nobody had set is the same answer, with nothing
      // announced: the socket's listeners already read no song.
      setAudit(res.locals, {
        entityType: 'walkUpSong',
        entityId: userId,
        before: { teamId, song: before },
        after: { teamId, song: null }
      })
      res.status(204).end()
    })
  )

  return router
}

type WalkUpSongRow = Pick<
  WalkUpSongsTable,
  | 'provider'
  | 'provider_id'
  | 'isrc'
  | 'title'
  | 'artist'
  | 'album'
  | 'artwork_url'
  | 'duration_ms'
  | 'start_ms'
  | 'end_ms'
>

const SONG_COLUMNS = [
  'provider',
  'provider_id',
  'isrc',
  'title',
  'artist',
  'album',
  'artwork_url',
  'duration_ms',
  'start_ms',
  'end_ms'
] as const

/** A stored row as the API sends it. */
function songOfRow(row: WalkUpSongRow): WalkUpSong {
  return asWalkUpSong({
    provider: row.provider,
    providerId: row.provider_id,
    isrc: row.isrc,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    durationMs: row.duration_ms,
    startMs: row.start_ms,
    endMs: row.end_ms
  })
}

/** A player's walk-up song on a team, or null for none. */
export async function readWalkUpSong(
  db: Kysely<Database>,
  teamId: string,
  userId: number
): Promise<WalkUpSong | null> {
  const row = await db
    .selectFrom('walk_up_songs')
    .select(SONG_COLUMNS)
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row == null ? null : songOfRow(row)
}

/** Every walk-up song on a team, by player. */
export async function teamWalkUpSongs(
  db: Kysely<Database>,
  teamId: string
): Promise<Map<number, WalkUpSong>> {
  const rows = await db
    .selectFrom('walk_up_songs')
    .select(['user_id', ...SONG_COLUMNS])
    .where('team_id', '=', teamId)
    .execute()
  return new Map(rows.map(row => [row.user_id, songOfRow(row)]))
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

function userIdParam(value: string | string[] | undefined): number {
  try {
    return asUserId(pathParam(value))
  } catch {
    throw notFound()
  }
}
