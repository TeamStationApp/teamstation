import { type Kysely, sql } from 'kysely'

import type { SponsorOverlay } from '../../common/nodeSettings'
import type { GameSponsors } from '../../common/sponsors/types'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { isRealVideo } from '../db/realVideos'
import type { SpaceSettings } from '../media/spacesHls'
import { creditsFor, mediaUrl } from './credits'
import { DEFAULT_SAMPLE_SETTINGS } from './sample'

/** How long a game is recorded before its logo uses a credit, in seconds. */
export const LOGO_CHARGE_SEC = 30 * 60

/** How often the placements not yet settled are looked at. */
export const LOGO_SETTLE_MS = 60 * 1000

/** The leagues of a game's two teams, home first; null for a team in none. */
async function gameLeagues(
  db: Kysely<Database>,
  gameId: string
): Promise<{ home: string | null; away: string | null } | null> {
  const row = await db
    .selectFrom('games')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select(['home.league_id as home', 'away.league_id as away'])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (row == null) return null
  return { home: row.home ?? null, away: row.away ?? null }
}

/**
 * When the game's first recording began: `startedAt`, or an earlier start of
 * one of its recordings already there. A logo accepted after the game began
 * is not the game's, whichever angle comes in later.
 */
async function firstRecordingAt(
  db: Kysely<Database>,
  gameId: string,
  startedAt: Date
): Promise<Date> {
  const row = await db
    .selectFrom('videos')
    .select(eb => eb.fn.min('videos.start_at').as('first'))
    .where('videos.game_id', '=', gameId)
    .where('videos.hidden', '=', false)
    .where('videos.start_at', 'is not', null)
    .where(isRealVideo)
    .executeTakeFirst()
  const first = row?.first == null ? null : new Date(row.first)
  return first != null && first.getTime() < startedAt.getTime()
    ? first
    : startedAt
}

/**
 * Gives a game, for each league its home and away teams belong to, that
 * league's next logo, round-robin in acceptance order, when its first
 * recording begins at `startedAt`. A game keeps the logo it was given: a
 * league that already has a row for the game is left alone, so a reconnect,
 * another angle or a second call changes nothing.
 *
 * Inside one transaction a league, holding its credits row, a logo is a
 * candidate when it is active, has games left of its allocation and was
 * accepted by the time the game began; the league's charged logos must be
 * below its game logo credits. With no candidate the game has no logo for
 * that league. Nothing is charged here: `settleGameLogos` does that once the
 * game has been recorded for 30 minutes.
 *
 * Answers the leagues it gave a logo to.
 */
export async function assignGameLogos(
  db: Kysely<Database>,
  gameId: string,
  startedAt: Date
): Promise<string[]> {
  const leagues = await gameLeagues(db, gameId)
  if (leagues == null) return []
  const began = await firstRecordingAt(db, gameId, startedAt)
  // Sorted, so two games of the same two leagues lock them in one order.
  const ids = [
    ...new Set(
      [leagues.home, leagues.away].filter((id): id is string => id != null)
    )
  ].sort()
  const given: string[] = []
  for (const leagueId of ids) {
    const assigned = await atomic(db, async trx => {
      const credits = await creditsFor(trx, leagueId, { lock: true })
      const held = await trx
        .selectFrom('game_sponsor_logos')
        .select('game_id')
        .where('game_id', '=', gameId)
        .where('league_id', '=', leagueId)
        .executeTakeFirst()
      if (held != null) return false
      const { used } = await trx
        .selectFrom('sponsor_logos')
        .select(sql<number>`coalesce(sum(used), 0)::int`.as('used'))
        .where('league_id', '=', leagueId)
        .executeTakeFirstOrThrow()
      if (used >= credits.logo_credits) return false
      const candidates = await trx
        .selectFrom('sponsor_logos')
        .select(['id', 'media_id', 'position'])
        .where('league_id', '=', leagueId)
        .where('active', '=', true)
        .whereRef('used', '<', 'allocation')
        .where('accepted_at', '<=', began)
        .orderBy('position')
        .execute()
      const chosen =
        candidates.find(each => each.position > credits.logo_turn) ??
        candidates[0]
      if (chosen == null) return false
      await trx
        .insertInto('game_sponsor_logos')
        .values({
          game_id: gameId,
          league_id: leagueId,
          logo_id: chosen.id,
          media_id: chosen.media_id
        })
        .execute()
      await trx
        .updateTable('league_sponsor_credits')
        .set({ logo_turn: chosen.position })
        .where('league_id', '=', leagueId)
        .execute()
      return true
    })
    if (assigned) given.push(leagueId)
  }
  return given
}

/**
 * Deletes a logo deactivated while games were showing it, once none is left
 * to settle and none charged it: unused after all, its allocation returns.
 */
async function dropUnusedInactive(
  db: Kysely<Database>,
  logoId: string | null
): Promise<void> {
  if (logoId == null) return
  await db
    .deleteFrom('sponsor_logos')
    .where('id', '=', logoId)
    .where('active', '=', false)
    .where('used', '=', 0)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('game_sponsor_logos')
            .select('game_sponsor_logos.game_id')
            .whereRef('game_sponsor_logos.logo_id', '=', 'sponsor_logos.id')
            .where('game_sponsor_logos.settled_at', 'is', null)
        )
      )
    )
    .execute()
}

/** What one sweep did. */
export interface SettledLogos {
  /** Placements that used a credit. */
  charged: number
  /** Placements settled without one: a short game, or a logo used up. */
  free: number
}

/**
 * Settles each game logo not yet settled, one transaction a placement,
 * claimed with `for update skip locked` so two sweeps at once settle it once.
 *
 * - Recorded for 30 minutes or more — the longest of the game's recordings,
 *   by its length once known, or while it is still live from its start to
 *   now while its camera publishes, and only to the camera's last publish
 *   while it is away (a stream in its reconnect grace may never come back) —
 *   it uses one of its logo's games (and so one of the league's credits),
 *   when the logo has one left; a logo used up first settles it free.
 * - Shorter, with nothing of the game live or still processing, it is
 *   settled free.
 * - Otherwise it waits for the next sweep.
 *
 * A settled placement is never looked at again, so a later angle that runs
 * past 30 minutes charges nothing. A logo deactivated while games showed it
 * is deleted once the last of them settles free, its allocation returned.
 */
export async function settleGameLogos(
  db: Kysely<Database>,
  now: Date
): Promise<SettledLogos> {
  const open = await db
    .selectFrom('game_sponsor_logos')
    .select(['game_id', 'league_id'])
    .where('settled_at', 'is', null)
    .orderBy('assigned_at')
    .execute()
  const settled: SettledLogos = { charged: 0, free: 0 }
  for (const { game_id: gameId, league_id: leagueId } of open) {
    const outcome = await atomic(db, async trx => {
      const placement = await trx
        .selectFrom('game_sponsor_logos')
        .select('logo_id')
        .where('game_id', '=', gameId)
        .where('league_id', '=', leagueId)
        .where('settled_at', 'is', null)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (placement == null) return null
      // A camera made and never used is a hidden placeholder: not a recording.
      const videos = await trx
        .selectFrom('videos')
        .select(['id', 'status', 'duration_sec', 'start_at'])
        .select(eb => isRealVideo(eb).as('real'))
        .where('game_id', '=', gameId)
        .where('hidden', '=', false)
        .execute()
      const streams = await trx
        .selectFrom('live_streams')
        .select(['video_id', 'state', 'last_published_at'])
        .where('game_id', '=', gameId)
        .where('video_id', 'is not', null)
        .execute()
      /**
       * How far a live video has got: now while a camera publishes it (or no
       * stream feeds it), else its camera's last publish. A publisher that
       * left stays `live` through the reconnect grace and may never return.
       */
      const liveUntil = (videoId: string): number | null => {
        const feeds = streams.filter(stream => stream.video_id === videoId)
        if (
          feeds.length === 0 ||
          feeds.some(stream => stream.state === 'publishing')
        )
          return now.getTime()
        const published = feeds.flatMap(stream =>
          stream.last_published_at == null
            ? []
            : [new Date(stream.last_published_at).getTime()]
        )
        return published.length === 0 ? null : Math.max(...published)
      }
      const recordedSec = Math.max(
        0,
        ...videos
          .filter(video => video.real === true)
          .map(video => {
            const length = video.duration_sec ?? 0
            if (video.status !== 'live' || video.start_at == null) return length
            const until = liveUntil(video.id)
            if (until == null) return length
            const since = (until - new Date(video.start_at).getTime()) / 1000
            return Math.max(length, since)
          })
      )
      const settle = async (charged: boolean): Promise<void> => {
        await trx
          .updateTable('game_sponsor_logos')
          .set({ settled_at: now, charged })
          .where('game_id', '=', gameId)
          .where('league_id', '=', leagueId)
          .where('settled_at', 'is', null)
          .execute()
      }
      if (recordedSec >= LOGO_CHARGE_SEC) {
        const used =
          placement.logo_id == null
            ? 0n
            : (
                await trx
                  .updateTable('sponsor_logos')
                  .set(eb => ({ used: eb('used', '+', 1) }))
                  .where('id', '=', placement.logo_id)
                  .whereRef('used', '<', 'allocation')
                  .executeTakeFirst()
              ).numUpdatedRows
        await settle(used > 0n)
        if (used > 0n) return 'charged'
        await dropUnusedInactive(trx, placement.logo_id)
        return 'free'
      }
      if (
        videos.some(
          video => video.status === 'live' || video.status === 'processing'
        )
      )
        return null
      await settle(false)
      await dropUnusedInactive(trx, placement.logo_id)
      return 'free'
    })
    if (outcome != null) settled[outcome]++
  }
  return settled
}

/**
 * What a game's players draw. In this version the sponsorship is the home
 * team's league's, or the away team's when home is in no league: the logo
 * that league gave the game, if any, and its track of reels in start order.
 * A league that gave the game neither answers none.
 */
export async function gameSponsorsFor(
  db: Kysely<Database>,
  space: SpaceSettings,
  gameId: string,
  overlay: SponsorOverlay = DEFAULT_SAMPLE_SETTINGS.overlay
): Promise<GameSponsors> {
  const none: GameSponsors = { leagueId: null, logo: null, reels: [], overlay }
  const leagues = await gameLeagues(db, gameId)
  const leagueId = leagues?.home ?? leagues?.away ?? null
  if (leagueId == null) return none
  const logo = await db
    .selectFrom('game_sponsor_logos')
    .innerJoin(
      'sponsor_media',
      'sponsor_media.id',
      'game_sponsor_logos.media_id'
    )
    .select([
      'sponsor_media.object_key as key',
      'sponsor_media.width as width',
      'sponsor_media.height as height'
    ])
    .where('game_sponsor_logos.game_id', '=', gameId)
    .where('game_sponsor_logos.league_id', '=', leagueId)
    .executeTakeFirst()
  const reels = await db
    .selectFrom('game_reel_placements')
    .innerJoin(
      'sponsor_media',
      'sponsor_media.id',
      'game_reel_placements.media_id'
    )
    .select([
      'game_reel_placements.id as id',
      'game_reel_placements.reel_id as reelId',
      'game_reel_placements.starts_at as startsAt',
      'game_reel_placements.duration_ms as durationMs',
      'sponsor_media.object_key as key',
      'sponsor_media.width as width',
      'sponsor_media.height as height'
    ])
    .where('game_reel_placements.game_id', '=', gameId)
    .where('game_reel_placements.league_id', '=', leagueId)
    .orderBy('game_reel_placements.starts_at')
    .orderBy('game_reel_placements.id')
    .execute()
  if (logo == null && reels.length === 0) return none
  return {
    leagueId,
    logo:
      logo == null
        ? null
        : {
            url: mediaUrl(space, logo.key),
            width: logo.width,
            height: logo.height
          },
    reels: reels.map(reel => ({
      id: reel.id,
      // A reel since removed keeps its placements: its media are pinned.
      reelId: reel.reelId ?? '',
      url: mediaUrl(space, reel.key),
      width: reel.width,
      height: reel.height,
      startMs: new Date(reel.startsAt).getTime(),
      durationMs: reel.durationMs
    })),
    overlay
  }
}
