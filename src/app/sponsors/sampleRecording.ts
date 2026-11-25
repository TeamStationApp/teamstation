// The recording the logo and reel screens play behind a preview: the
// league's most recent game with a home camera angle, else the most recent
// one the administrator can see, found through the client's existing reads.
import type { TeamStationClient, VideoSummary } from '../../common/api'

/** The reads the walk uses, so a test can stand in for the server. */
export type SampleClient = Pick<
  TeamStationClient,
  'group' | 'seasonGamesPage' | 'game' | 'playback' | 'videoGames'
>

export type SampleRecording =
  | {
      kind: 'found'
      gameId: string
      videoId: string
      url: string
      durationSec: number
    }
  | { kind: 'none' }

/** How many games, newest first, each walk looks through. */
const GAMES_LOOKED_AT = 10

/** The window played: 30:00 to 32:00. */
const WINDOW_START_SEC = 30 * 60
const WINDOW_SEC = 2 * 60

/** A game's first video whose camera is a home angle and has a length. */
export function homeAngleOf(
  videos: readonly VideoSummary[]
): (VideoSummary & { durationSec: number }) | undefined {
  return videos.find(
    (video): video is VideoSummary & { durationSec: number } =>
      /\bhome\b/i.test(video.title) && video.durationSec != null
  )
}

/** The first of `gameIds` with a playable home angle. */
async function firstPlayable(
  client: SampleClient,
  gameIds: readonly string[]
): Promise<SampleRecording | null> {
  for (const gameId of gameIds) {
    try {
      const game = await client.game(gameId)
      const video = homeAngleOf(game.videos)
      if (video == null) continue
      const playback = await client.playback(video.id)
      if (playback.url == null || playback.unavailable) continue
      return {
        kind: 'found',
        gameId,
        videoId: video.id,
        url: playback.url,
        durationSec: video.durationSec
      }
    } catch {
      // A game that cannot be read is passed over for the next.
    }
  }
  return null
}

/** The league's games with video, newest first, across its seasons. */
async function leagueGames(
  client: SampleClient,
  leagueId: string
): Promise<string[]> {
  const league = await client.group({ kind: 'league', id: leagueId })
  const seasons = league.children.filter(child => child.kind === 'season')
  const pages = await Promise.all(
    seasons.map(
      async season =>
        await client
          .seasonGamesPage(season.id, {
            when: 'past',
            order: 'desc',
            hasVideo: true,
            limit: GAMES_LOOKED_AT
          })
          .then(page => page.items)
          .catch(() => [])
    )
  )
  return pages
    .flat()
    .filter(game => game.startAt != null)
    .sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? ''))
    .slice(0, GAMES_LOOKED_AT)
    .map(game => game.id)
}

/**
 * The league's newest playable home-angle recording; failing that, the
 * newest the administrator can see anywhere; failing that, `none`. A read
 * that fails counts as finding nothing there.
 */
export async function findSampleRecording(
  client: SampleClient,
  leagueId: string
): Promise<SampleRecording> {
  const inLeague = await leagueGames(client, leagueId)
    .then(async ids => await firstPlayable(client, ids))
    .catch(() => null)
  if (inLeague != null) return inLeague
  const anywhere = await client
    .videoGames({ sort: 'date', limit: GAMES_LOOKED_AT })
    .then(
      async games =>
        await firstPlayable(
          client,
          games.map(game => game.id)
        )
    )
    .catch(() => null)
  return anywhere ?? { kind: 'none' }
}

/**
 * The part of a recording the sample loops, in seconds: 30:00 to 32:00 of
 * one at least 32 minutes long, else its first two minutes (or all of it).
 */
export function sampleWindow(durationSec: number): [number, number] {
  if (durationSec >= WINDOW_START_SEC + WINDOW_SEC)
    return [WINDOW_START_SEC, WINDOW_START_SEC + WINDOW_SEC]
  return [0, Math.min(WINDOW_SEC, durationSec)]
}

/**
 * Where to seek the sample to at `time`: back to the window's start once it
 * reaches the end or is anywhere outside the window, else `null`.
 */
export function loopSeek(
  time: number,
  [start, end]: readonly [number, number]
): number | null {
  return time >= end || time < start ? start : null
}
