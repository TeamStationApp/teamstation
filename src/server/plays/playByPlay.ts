import type { Router } from 'express'
import type { Kysely } from 'kysely'

import { describePlay } from '../../common/describePlay'
import { membersOnly, notFound, unauthorized } from '../../common/errors'
import { eventTypeName, normalizeEventType } from '../../common/gumboEventTypes'
import { canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { creditsForHighlight } from '../events/credits'
import { HIGHLIGHT_EVENT_COLUMNS, leadFor } from '../highlights'
import { imageUrl, TILE_SIZE } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { stillUrl } from '../media/stills'
import { warmVideoStills } from '../media/videoStills'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import type { HighlightSettings } from '../settings'
import { highlightSettings } from '../settings'

/** How long before the next scoring play a clip stops. */
export const CLIP_TAIL_SEC = 5

/**
 * Home runs, doubles, triples, and double plays. A clip of one of these
 * starts at the highlight rewind and runs until `CLIP_TAIL_SEC` before the
 * next scoring play.
 */
const CLIP_TYPES: ReadonlySet<string> = new Set([
  'double',
  'triple',
  'home_run',
  'double_play',
  'grounded_into_double_play',
  'strikeout_double_play',
  'sac_fly_double_play',
  'sac_bunt_double_play',
  'cs_double_play',
  'runner_double_play'
])

/** Bookkeeping, not an at-bat and not a play the list recounts. */
const SKIP_TYPES: ReadonlySet<string> = new Set([
  'batter_timeout',
  'mound_visit',
  'no_pitch',
  'pitching_substitution',
  'offensive_substitution',
  'defensive_switch',
  'umpire_substitution',
  'pitcher_switch',
  'game_advisory',
  'defensive_substitution',
  'injury',
  'os_ruling_pending_prior',
  'os_ruling_pending_primary',
  'at_bat_start',
  'final_score',
  'score_correction',
  'ts_batting_order',
  'pitcher_step_off',
  'ejection'
])

export interface PlayByPlayCredit {
  eventType: string
  label: string
  credit: { name: string; role: string; position: string | null } | null
  creditUserId: number | null
}

export interface PlayByPlayEvent {
  id: string
  atBatIndex: number
  eventType: string | null
  inning: number | null
  halfInning: string | null
  awayScore: number | null
  homeScore: number | null
  isScoringPlay: boolean
  startTime: Date | null
  timeNudgeSec: number
  hidden: boolean
  outs: number | null
  credits: PlayByPlayCredit[]
  avatarUrl: string | null
}

export interface PlayClipVideo {
  id: string
  startAt: Date | null
  syncOffsetSec: number
  durationSec: number | null
}

export interface PlayScoreLine {
  awayLabel: string
  awayScore: number
  homeLabel: string
  homeScore: number
  /** The side that was batting, whose figure is drawn stronger. */
  batting: 'away' | 'home'
}

export interface PlayClip {
  startOffsetSec: number
  endOffsetSec: number | null
  stillUrl: string | null
}

export interface PlayRow {
  eventId: string
  outcome: string
  sentence: string
  outsLabel: string | null
  avatarUrl: string | null
  batterName: string | null
  score: PlayScoreLine | null
  clip: PlayClip | null
}

export interface PlayInning {
  heading: string
  plays: PlayRow[]
}

export interface PlayByPlay {
  videoId: string | null
  prelude: { time: string; place: string | null } | null
  innings: PlayInning[]
}

interface PlayMoment {
  event: PlayByPlayEvent
  playMs: number | null
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function heading(half: string, inning: number): string {
  const side = half === 'bottom' ? 'Bottom' : 'Top'
  return `${side} ${ordinal(inning)}`
}

function outsLabel(outs: number | null): string | null {
  if (outs == null || outs < 1) return null
  return outs === 1 ? '1 out' : `${outs} outs`
}

function batterOf(event: PlayByPlayEvent): PlayByPlayCredit | undefined {
  return event.credits.find(credit => credit.credit?.role === 'batter')
}

/**
 * The line under the pill. A strikeout credited to the batter is that batter
 * striking out; the shared sentence reads a batter's strikeout credit as a
 * dropped third strike, which is a different play.
 */
function sentenceFor(event: PlayByPlayEvent): string {
  const type =
    event.eventType == null ? '' : normalizeEventType(event.eventType)
  const batter = batterOf(event)
  const name = batter?.credit?.name ?? ''
  if ((type === 'strikeout' || type === 'strike_out') && name !== '') {
    return `${name} strikes out.`
  }
  return describePlay({
    eventType: event.eventType,
    credits: event.credits
  })
}

/** Seconds from the video's start, one decimal, matching a highlight seek. */
function toOffset(
  atMs: number,
  videoStartMs: number,
  syncOffsetSec: number
): number {
  return Math.round(((atMs - videoStartMs) / 1000 + syncOffsetSec) * 10) / 10
}

function playMs(event: PlayByPlayEvent, lagSec: number): number | null {
  if (event.startTime == null) return null
  return event.startTime.getTime() + event.timeNudgeSec * 1000 - lagSec * 1000
}

function isClip(eventType: string | null): boolean {
  if (eventType == null) return false
  return CLIP_TYPES.has(normalizeEventType(eventType))
}

function clipFor(
  moment: PlayMoment,
  later: PlayMoment[],
  video: PlayClipVideo | null,
  settings: HighlightSettings,
  stillFor?: (playOffsetSec: number) => string | null
): PlayClip | null {
  if (video?.startAt == null || moment.playMs == null) return null
  if (!isClip(moment.event.eventType)) return null
  const videoStartMs = video.startAt.getTime()
  const lead = leadFor(moment.event.eventType, settings)
  const startMs = moment.playMs - lead * 1000
  const startOffsetSec = Math.max(
    0,
    toOffset(startMs, videoStartMs, video.syncOffsetSec)
  )
  const playOffsetSec = toOffset(
    moment.playMs,
    videoStartMs,
    video.syncOffsetSec
  )
  if (playOffsetSec < 0) return null
  if (video.durationSec != null && playOffsetSec > video.durationSec)
    return null

  const next = later.find(
    item => item.event.isScoringPlay && item.playMs != null
  )
  let endOffsetSec: number | null
  if (next?.playMs != null) {
    endOffsetSec = toOffset(
      next.playMs - CLIP_TAIL_SEC * 1000,
      videoStartMs,
      video.syncOffsetSec
    )
  } else {
    endOffsetSec = video.durationSec
  }
  if (endOffsetSec != null && endOffsetSec <= startOffsetSec) {
    endOffsetSec = Math.min(
      video.durationSec ?? startOffsetSec + 8,
      startOffsetSec + 8
    )
  }
  return {
    startOffsetSec,
    endOffsetSec,
    stillUrl: stillFor?.(playOffsetSec) ?? null
  }
}

/**
 * The Plays tab: every recounted at-bat, in order, and a clip on a home
 * run, double, triple, or double play.
 *
 * A clip starts where a highlight starts — the scorekeeper's tap, minus the
 * lag, minus the rewind for that play type — and stops five seconds before
 * the next scoring play. There is no win probability.
 */
export function buildPlayByPlay(input: {
  events: PlayByPlayEvent[]
  video: PlayClipVideo | null
  settings: HighlightSettings
  awayLabel: string
  homeLabel: string
  prelude: { time: string; place: string | null } | null
  stillFor?: (playOffsetSec: number) => string | null
}): PlayByPlay {
  const shown = input.events
    .filter(event => !event.hidden)
    .filter(event => {
      const type =
        event.eventType == null ? '' : normalizeEventType(event.eventType)
      return !SKIP_TYPES.has(type)
    })
    .sort((a, b) => a.atBatIndex - b.atBatIndex)

  const moments: PlayMoment[] = shown.map(event => ({
    event,
    playMs: playMs(event, input.settings.lagSec)
  }))

  const innings: PlayInning[] = []
  let previousScore: { away: number; home: number } | null = null
  for (let index = 0; index < moments.length; index += 1) {
    const moment = moments[index]
    const event = moment.event
    const half = event.halfInning === 'bottom' ? 'bottom' : 'top'
    const inning = event.inning
    if (inning == null) continue
    const title = heading(half, inning)
    let group = innings[innings.length - 1]
    if (group?.heading !== title) {
      group = { heading: title, plays: [] }
      innings.push(group)
    }
    const batter = batterOf(event)
    const away = event.awayScore
    const home = event.homeScore
    const changed =
      typeof away === 'number' &&
      typeof home === 'number' &&
      (previousScore == null
        ? event.isScoringPlay
        : away !== previousScore.away || home !== previousScore.home)
    if (typeof away === 'number' && typeof home === 'number') {
      previousScore = { away, home }
    }
    group.plays.push({
      eventId: event.id,
      outcome: eventTypeName(event.eventType),
      sentence: sentenceFor(event),
      outsLabel: outsLabel(event.outs),
      avatarUrl: event.avatarUrl,
      batterName: batter?.credit?.name ?? null,
      score:
        changed && typeof away === 'number' && typeof home === 'number'
          ? {
              awayLabel: input.awayLabel,
              awayScore: away,
              homeLabel: input.homeLabel,
              homeScore: home,
              batting: half === 'bottom' ? 'home' : 'away'
            }
          : null,
      clip: clipFor(
        moment,
        moments.slice(index + 1),
        input.video,
        input.settings,
        input.stillFor
      )
    })
  }

  return {
    videoId: input.video?.id ?? null,
    prelude: input.prelude,
    innings
  }
}

function outsOf(gumbo: unknown): number | null {
  if (gumbo == null || typeof gumbo !== 'object') return null
  const count = (gumbo as { count?: { outs?: unknown } }).count
  const outs = count?.outs
  return typeof outs === 'number' &&
    Number.isInteger(outs) &&
    outs >= 0 &&
    outs <= 3
    ? outs
    : null
}

function clock(startAt: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(startAt)
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(startAt)
  }
}

function labelOf(name: string, shortName: string | null): string {
  const short = shortName?.trim() ?? ''
  return short === '' ? name : short
}

/**
 * `GET /games/:gameId/plays`. Members of either side. A finalized game's
 * Plays tab reads it; the list is the at-bats, and a clip rides on a home
 * run, double, triple, or double play.
 */
export function registerPlayRoutes(
  router: Router,
  db: Kysely<Database>,
  media: MediaContext
): void {
  router.get(
    '/games/:gameId/plays',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const asked = req.query.videoId
      const videoId = typeof asked === 'string' && asked !== '' ? asked : null

      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const game = await db
        .selectFrom('games')
        .select([
          'home_team_id as homeTeamId',
          'away_team_id as awayTeamId',
          'season_id as seasonId',
          'start_at as startAt',
          'venue',
          'timezone'
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()
      const sides = await db
        .selectFrom('teams')
        .select(['id', 'name', 'short_name as shortName'])
        .where('id', 'in', [game.homeTeamId, game.awayTeamId])
        .execute()
      const sideName = (
        id: string
      ): { name: string; shortName: string | null } => {
        const side = sides.find(row => row.id === id)
        return { name: side?.name ?? '', shortName: side?.shortName ?? null }
      }
      const homeSide = sideName(game.homeTeamId)
      const awaySide = sideName(game.awayTeamId)
      if (
        !canSeeGame(scopes, {
          homeTeamId: game.homeTeamId,
          awayTeamId: game.awayTeamId,
          seasonId: game.seasonId
        })
      ) {
        throw membersOnly()
      }

      let videoQuery = db
        .selectFrom('videos')
        .select([
          'id',
          'storage',
          'start_at as startAt',
          'sync_offset_sec as syncOffsetSec',
          'duration_sec as durationSec'
        ])
        .where('game_id', '=', gameId)
        .where('hidden', '=', false)
      if (videoId != null) videoQuery = videoQuery.where('id', '=', videoId)
      const video = await videoQuery
        .orderBy('start_at', 'asc')
        .executeTakeFirst()

      const rows = await db
        .selectFrom('events')
        .select(HIGHLIGHT_EVENT_COLUMNS)
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute()
      const credits = await creditsForHighlight(
        db,
        rows.map(row => row.id)
      )
      const userIds = [
        ...new Set(
          [...credits.values()].flatMap(list =>
            (list ?? [])
              .filter(credit => credit.credit?.role === 'batter')
              .map(credit => credit.creditUserId)
              .filter((id): id is number => id != null)
          )
        )
      ]
      const avatars = new Map<number, string | null>()
      if (userIds.length > 0) {
        const people = await db
          .selectFrom('users')
          .select(['id', 'avatar_path as avatarPath'])
          .where('id', 'in', userIds)
          .execute()
        for (const person of people) {
          avatars.set(
            Number(person.id),
            imageUrl(media.space, person.avatarPath, TILE_SIZE)
          )
        }
      }

      const settings = await highlightSettings(db)
      const clipVideo =
        video == null
          ? null
          : {
              id: video.id,
              startAt: video.startAt == null ? null : new Date(video.startAt),
              syncOffsetSec: video.syncOffsetSec,
              durationSec: video.durationSec
            }
      const warmed: Array<{ playOffsetSec: number }> = []
      const built = buildPlayByPlay({
        awayLabel: labelOf(awaySide.name, awaySide.shortName),
        homeLabel: labelOf(homeSide.name, homeSide.shortName),
        settings,
        video: clipVideo,
        prelude:
          game.startAt == null
            ? null
            : {
                time: clock(new Date(game.startAt), game.timezone),
                place: game.venue
              },
        stillFor:
          clipVideo == null
            ? undefined
            : atSec => {
                warmed.push({ playOffsetSec: atSec })
                return stillUrl(media, clipVideo.id, atSec)
              },
        events: rows.map(row => {
          const list = credits.get(row.id) ?? []
          const batter = list.find(credit => credit.credit?.role === 'batter')
          return {
            id: row.id,
            atBatIndex: row.atBatIndex,
            eventType: row.eventType,
            inning: row.inning,
            halfInning: row.halfInning,
            awayScore: row.awayScore,
            homeScore: row.homeScore,
            isScoringPlay: row.isScoringPlay === true,
            startTime: row.startTime == null ? null : new Date(row.startTime),
            timeNudgeSec: row.timeNudgeSec,
            hidden: row.hidden,
            outs: outsOf(row.gumbo),
            avatarUrl:
              batter?.creditUserId == null
                ? null
                : (avatars.get(batter.creditUserId) ?? null),
            credits: list.map(credit => ({
              eventType: credit.eventType,
              label: credit.label,
              credit: credit.credit,
              creditUserId: credit.creditUserId
            }))
          }
        })
      })
      res.json(built)
      if (video != null && warmed.length > 0) {
        warmVideoStills(media, video.storage, video.id, warmed).catch(
          () => undefined
        )
      }
    })
  )
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
