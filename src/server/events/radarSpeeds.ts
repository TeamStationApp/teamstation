import { setTimeout } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { captureException } from '@sentry/node'
import type { Kysely } from 'kysely'

import type { RadarSettings } from '../../common/nodeSettings'
import {
  type RadarReading,
  radarTargets,
  withRadarSpeeds
} from '../../common/scoring/radarSpeeds'
import type { Database } from '../db/database'
import { radarSettings } from '../nodeSettings'
import { notifyGameChange } from '../socket/gameChanges'

/** Query only the requested pitches' windows, using explicit packet metadata. */
export async function radarReadings(
  db: Kysely<Database>,
  gameId: string,
  plays: unknown[],
  settings: RadarSettings
): Promise<RadarReading[]> {
  const targets = plays.flatMap(radarTargets)
  if (targets.length === 0) return []
  const from = Math.min(
    ...targets.map(
      t =>
        t.at -
        (t.inPlay ? settings.inPlayWindowSec : settings.pitchWindowSec) * 1000
    )
  )
  const until = Math.max(
    ...targets.map(t => t.at + (t.inPlay ? 0 : settings.pitchWindowSec * 1000))
  )
  const rows = await db
    .selectFrom('scoreboard_log')
    .select(['at', 'version', 'radar'])
    .where('game_id', '=', gameId)
    .where('radar', 'is not', null)
    .where('at', '>=', new Date(from))
    .where('at', '<=', new Date(until))
    .execute()
  return rows.map(row => ({
    ...(row.radar as object),
    at: new Date(row.at).getTime(),
    version: Number(row.version)
  }))
}

/** Re-read under the scoring lock: never revive an undone or replaced pitch. */
export async function refreshRadarSpeeds(
  db: Kysely<Database>,
  gameId: string
): Promise<void> {
  await db.transaction().execute(async trx => {
    const game = await trx
      .selectFrom('games')
      .select(['scoringOwner', 'currentPlay'])
      .where('id', '=', gameId)
      .forUpdate()
      .executeTakeFirst()
    if (game?.scoringOwner !== 'teamstation') return
    const rows = await trx
      .selectFrom('events')
      .select(['id', 'gumbo'])
      .where('gameId', '=', gameId)
      .where('source', '=', 'teamstation')
      .execute()
    const settings = await radarSettings(trx)
    const readings = await radarReadings(
      trx,
      gameId,
      [...rows.map(r => r.gumbo), game.currentPlay],
      settings
    )
    let changed = false
    for (const row of rows) {
      const gumbo = withRadarSpeeds(row.gumbo, readings, settings, row.gumbo)
      if (isDeepStrictEqual(gumbo, row.gumbo)) continue
      await trx
        .updateTable('events')
        .set({ gumbo, updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute()
      changed = true
    }
    const currentPlay = withRadarSpeeds(
      game.currentPlay,
      readings,
      settings,
      game.currentPlay
    )
    if (changed || !isDeepStrictEqual(currentPlay, game.currentPlay)) {
      await trx
        .updateTable('games')
        .set({ currentPlay, updated_at: new Date() })
        .where('id', '=', gameId)
        .execute()
      await notifyGameChange(trx, { game: gameId, kind: 'plays' })
    }
  })
}

/** A post also rechecks at the end of its future window. Packet arrivals
 * refresh independently, including after another worker or a restart. */
const refreshes = new WeakMap<Kysely<Database>, Map<string, AbortController>>()
export function scheduleRadarRefresh(
  db: Kysely<Database>,
  gameId: string,
  delay: number
): void {
  let pending = refreshes.get(db)
  if (pending == null) {
    pending = new Map()
    refreshes.set(db, pending)
  }
  pending.get(gameId)?.abort()
  const controller = new AbortController()
  pending.set(gameId, controller)
  setTimeout(delay, undefined, { ref: false, signal: controller.signal })
    .then(async () => {
      await refreshRadarSpeeds(db, gameId)
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) captureException(error)
    })
    .finally(() => {
      if (pending.get(gameId) === controller) pending.delete(gameId)
    })
}
