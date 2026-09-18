import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { locateVideoFile } from './locations'
import type { MediaContext } from './mediaContext'
import { mediaUrlPath } from './mediaTokens'
import { stillSecond, warmStills } from './stills'

/**
 * A frame of a game's video, for the card and the row that stand for it.
 *
 * Far enough in that the picture is a ball game. The opening seconds of a
 * recording are a lens cap, an empty field, or somebody walking in front of
 * the camera, and a list of those tells a reader nothing about which game is
 * which.
 */
const POSTER_SECOND = 150

/**
 * The second a list's picture is taken from.
 *
 * A hundred and fifty seconds in is two and a half minutes of baseball, which
 * is past the warm-up and into the first inning. A video shorter than five
 * minutes has no such second, so it gives up its middle instead — and the URL
 * a list asks for has to agree with the frame that was cut, which is the whole
 * reason this is a function rather than a number written twice.
 */
export function posterSecond(durationSec: number | null | undefined): number {
  return Math.min(POSTER_SECOND, (durationSec ?? 600) / 2)
}

/** Where a video's stills live, under the work directory. */
export function stillDirFor(videoId: string): string {
  return `work/stills/${videoId}`
}

/**
 * The signed URL of a game's poster, or null when there is nothing to show.
 *
 * The frame is cut lazily: the first person to open a list starts the work and
 * sees the plain plate, and everybody after that sees the picture. That is the
 * same bargain the highlight stills already make, and it keeps a list of
 * twenty games from blocking on twenty FFmpeg runs.
 */
export function posterUrl(
  media: MediaContext,
  videoId: string,
  atSec: number = POSTER_SECOND,
  now: number = Date.now()
): string {
  return (
    media.publicUrl +
    mediaUrlPath(
      media.mediaSecret,
      stillDirFor(videoId),
      `${stillSecond(atSec)}.jpg`,
      now
    )
  )
}

export interface PosterVideo {
  gameId: string
  videoId: string
  storage: 'peertube' | 'local' | 'spaces'
  durationSec: number | null
}

/**
 * One video per game to take the poster from: the first that is ready.
 *
 * `kind` orders `combined` before `program`, which is the wrong way round for
 * a picture — the multi-angle mosaic is four small pictures and reads as a
 * contact sheet at thumbnail size. The single view is the one to show.
 */
export async function postersFor(
  db: Kysely<Database>,
  gameIds: string[]
): Promise<Map<string, PosterVideo>> {
  if (gameIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('videos')
    .select(['id', 'game_id', 'storage', 'duration_sec', 'num_cameras'])
    .where('game_id', 'in', gameIds)
    .where('hidden', '=', false)
    .where('status', '=', 'ready')
    .execute()

  const best = new Map<string, { poster: PosterVideo; single: boolean }>()
  for (const row of rows) {
    if (row.game_id == null) continue
    const single = row.num_cameras <= 1
    const held = best.get(row.game_id)
    // A single view wins. Otherwise the first one found will do, and a second
    // mosaic is no better than the first.
    if (held != null && (held.single || !single)) continue
    best.set(row.game_id, {
      single,
      poster: {
        gameId: row.game_id,
        videoId: row.id,
        storage: row.storage,
        durationSec: row.duration_sec
      }
    })
  }
  return new Map([...best].map(([gameId, held]) => [gameId, held.poster]))
}

/**
 * Cuts the frames a list just asked for, after the answer has gone out.
 *
 * Failures are silent on purpose: a missing thumbnail is a plain plate, not an
 * error worth putting in front of somebody reading a schedule.
 */
export async function warmPosters(
  media: MediaContext,
  posters: PosterVideo[]
): Promise<void> {
  for (const poster of posters) {
    try {
      const videoPath = await locateVideoFile({
        mediaRoot: media.mediaRoot,
        storage: poster.storage,
        videoId: poster.videoId
      })
      if (videoPath == null) continue
      await warmStills({
        ffmpegPath: media.ffmpegPath,
        videoPath,
        workDir: media.workDir,
        videoId: poster.videoId,
        seconds: [posterSecond(poster.durationSec)]
      })
    } catch {
      // Nothing to say: the card draws its plate and the list is unaffected.
    }
  }
}
