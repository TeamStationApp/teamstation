import { type Kysely, sql } from 'kysely'

import {
  DEFAULT_SPONSOR_SAMPLE_KEY,
  defaultSponsorSettings,
  type SponsorSettings
} from '../../common/nodeSettings'
import type { SampleVideo } from '../../common/sponsors/types'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import { deleteObject } from '../media/images'
import { playbackAnswer, type PlaybackDeps } from '../media/playbackAnswer'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import { mediaUrl } from './credits'

/** The previews play 30:00–32:00 of a recording at least this long. */
const LATE_WINDOW: [number, number] = [1800, 1920]
/** Or its first two minutes. */
const SAMPLE_SEC = 120

/** Which seconds of a recording `durationSec` long the previews play. */
export function sampleWindow(durationSec: number): [number, number] {
  if (durationSec >= LATE_WINDOW[1]) return [...LATE_WINDOW]
  return [0, Math.min(SAMPLE_SEC, durationSec)]
}

/**
 * The video the league's previews play: its newest recording with a
 * home-plate angle (a title with the word "home"), else its newest recording
 * of any title, from a game in one of its seasons or with one of its teams.
 * Another league's footage is never used. With none, or when the chosen
 * recording's files are not there, the node's sample video: the one a node
 * administrator uploaded (`sponsors.sampleKey`), else the default clip. The
 * previews place the logo and reel by the node's `settings`.
 */
export async function sampleVideoFor(
  db: Kysely<Database>,
  deps: PlaybackDeps,
  leagueId: string,
  settings: SponsorSettings = defaultSponsorSettings,
  now: number = Date.now()
): Promise<SampleVideo> {
  const overlay = { logo: settings.logo, reel: settings.reel }
  const recording = await db
    .selectFrom('videos')
    .innerJoin('games', 'games.id', 'videos.game_id')
    .leftJoin('seasons', 'seasons.id', 'games.season_id')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'videos.id as id',
      'videos.storage as storage',
      'videos.kind as kind',
      'videos.duration_sec as durationSec',
      'videos.space_secret as spaceSecret',
      'videos.codecs as codecs'
    ])
    .where(eb =>
      eb.and([
        isRealVideo(eb),
        eb('videos.hidden', '=', false),
        eb('videos.duration_sec', '>', 0),
        eb.or([
          eb('seasons.league_id', '=', leagueId),
          eb('home.league_id', '=', leagueId),
          eb('away.league_id', '=', leagueId)
        ])
      ])
    )
    .orderBy(sql`videos.title ~* '\\mhome\\M'`, 'desc')
    .orderBy(sql`coalesce(videos.start_at, videos.created_at)`, 'desc')
    .orderBy('videos.id')
    .limit(1)
    .executeTakeFirst()
  if (recording?.durationSec != null) {
    const answer = await playbackAnswer(deps, recording, now)
    if (!answer.unavailable && answer.url != null)
      return {
        kind: 'recording',
        videoId: recording.id,
        url: answer.url,
        window: sampleWindow(recording.durationSec),
        overlay
      }
  }
  return {
    kind: 'node',
    url: mediaUrl(deps.space, settings.sampleKey ?? DEFAULT_SPONSOR_SAMPLE_KEY),
    window: [0, SAMPLE_SEC],
    overlay
  }
}

/** A node administrator's upload: `sponsors/sample/<YYYY-MM-DD>-<id>.mp4`. */
const UPLOADED_SAMPLE_KEY =
  /^sponsors\/sample\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+\.mp4$/

/**
 * Deletes the uploaded sample video a save replaced, once the save is
 * stored: a new upload, or Reset to defaults. Only a node administrator's
 * upload (`sponsors/sample/<YYYY-MM-DD>-<id>.mp4`) is deleted, never the
 * default clip, and never the key the node points at now. A delete that
 * fails is logged: the save stands, and the object stays.
 */
export async function dropReplacedSample(
  space: SpaceSettings,
  replaced: string | null,
  current: string | null,
  log: (message: string) => void = console.error
): Promise<boolean> {
  if (
    replaced == null ||
    replaced === current ||
    replaced === DEFAULT_SPONSOR_SAMPLE_KEY ||
    !UPLOADED_SAMPLE_KEY.test(replaced) ||
    !spaceConfigured(space)
  )
    return false
  try {
    await deleteObject({ space, key: replaced })
    return true
  } catch (error) {
    log(
      `Deleting the replaced sponsor sample ${replaced} failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}
