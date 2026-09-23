import { Router } from 'express'
import type { Kysely } from 'kysely'

import type { SeasonGame } from '../../common/api'
import { notFound, unauthorized, unavailable } from '../../common/errors'
import { adminScopes, roleScopes, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { eventWindow, parseEventListQuery } from '../events/eventListQuery'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { scheduleOf, type ScheduleRow } from './seasons'

/**
 * Every game list is this one route.
 *
 * `scope=visible` is what the schedule shows. `scope=run` is the games this
 * account may score. `scope=film` is the games it may film. Season, time,
 * and the scoreboard being open are query parameters on the same URL.
 */

/** Two hours after the start the board stays open only while its key does. */
const SCOREBOARD_OPEN_MS = 2 * 3_600_000

export interface EventListStore {
  now: () => number
  exists: (gameId: string) => Promise<boolean>
}

export interface EventListItem extends SeasonGame {
  gameId: string
  homeLogoUrl: string | null
  awayLogoUrl: string | null
  liveState: 'none' | 'idle' | 'publishing' | 'ended'
}

/**
 * A game's cameras, folded into one state.
 *
 * Four cameras are still one row: if any is publishing the game is on.
 */
function liveStateOf(
  streams: Array<{ state: string }>
): EventListItem['liveState'] {
  if (streams.length === 0) return 'none'
  if (streams.some(one => one.state === 'publishing')) return 'publishing'
  if (streams.some(one => one.state === 'idle')) return 'idle'
  return 'ended'
}

/**
 * Open from the moment the game exists until two hours after the start, and
 * after that for as long as its key is still there. A cancelled game is not.
 */
function boardStillOpen(
  game: { startAt: string | null; status: string },
  keyExists: boolean,
  nowMs: number
): boolean {
  if (game.status === 'cancelled') return false
  const start = game.startAt == null ? Number.NaN : Date.parse(game.startAt)
  return keyExists || nowMs < start + SCOREBOARD_OPEN_MS
}

function scoreboardAway(error: unknown): boolean {
  return error instanceof Error && error.name === 'ScoreboardUnavailable'
}

async function withDirectorFields(
  db: Kysely<Database>,
  media: MediaContext,
  rows: ScheduleRow[]
): Promise<EventListItem[]> {
  const streams =
    rows.length === 0
      ? []
      : await db
          .selectFrom('live_streams')
          .select(['game_id as gameId', 'user_id as userId', 'state'])
          .where(
            'game_id',
            'in',
            rows.map(row => row.id)
          )
          .where('state', '<>', 'revoked')
          .execute()

  return rows.map(row => {
    const { homeLogoPath, awayLogoPath, ...game } = row
    const onThisGame = streams.filter(one => one.gameId === row.id)
    return {
      ...game,
      gameId: game.id,
      homeLogoUrl: imageUrl(media.space, homeLogoPath),
      awayLogoUrl: imageUrl(media.space, awayLogoPath),
      liveState: liveStateOf(onThisGame)
    }
  })
}

export function eventListRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  options: { store?: EventListStore } = {}
): Router {
  const router = Router()

  router.get(
    '/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const parsed = parseEventListQuery(req.query)
      const now = new Date()
      const window = eventWindow(parsed, now)

      const rows = await (async (): Promise<ScheduleRow[]> => {
        const shared = {
          seasonIds: parsed.seasonIds,
          externalIds: parsed.externalIds,
          played: window.played,
          since: window.since,
          until: window.until,
          untilInclusive: window.untilInclusive,
          upcoming: window.upcoming,
          past: window.past,
          future: window.future,
          now,
          order: window.order,
          omitCancelled: window.omitCancelled,
          // A closed board must not consume a slot, so the limit waits.
          limit: parsed.scoreboardOpen ? undefined : parsed.limit
        }
        if (parsed.scope === 'run') {
          const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
          return await scheduleOf(db, media, { ...shared, run: scopes })
        }
        if (parsed.scope === 'film') {
          const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
          return await scheduleOf(db, media, {
            ...shared,
            film: {
              teamIds: scopes.videographer.teamIds,
              isAdmin: scopes.isAdmin
            }
          })
        }
        const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
        if (parsed.seasonIds != null && !scopes.isAdmin) {
          for (const seasonId of parsed.seasonIds) {
            if (!scopes.seasonIds.has(seasonId)) throw notFound()
          }
        }
        return await scheduleOf(db, media, { ...shared, visible: scopes })
      })()

      let listed = rows
      if (parsed.scoreboardOpen) {
        const store = options.store
        if (store == null) throw unavailable('The scoreboard is unavailable')
        try {
          const nowMs = store.now()
          const open: ScheduleRow[] = []
          for (const row of rows) {
            if (parsed.limit != null && open.length >= parsed.limit) break
            if (boardStillOpen(row, await store.exists(row.id), nowMs)) {
              open.push(row)
            }
          }
          listed = open
        } catch (error) {
          if (scoreboardAway(error)) {
            throw unavailable('The scoreboard is unavailable')
          }
          throw error
        }
      }

      res.json(await withDirectorFields(db, media, listed))
    })
  )

  return router
}
