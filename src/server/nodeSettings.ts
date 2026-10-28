import type { Kysely } from 'kysely'

import {
  asDate,
  asHeight,
  asHoldSeconds,
  asPlacement,
  asRadarSettings,
  asReplaySettings,
  type BoardPlacement,
  defaultRadarSettings,
  defaultReplaySettings,
  defaultScoreboardSettings,
  type NodeSettings,
  type NodeSettingsUpdate,
  type RadarSettings,
  type ReplaySettings,
  type ScoreboardOverlay,
  type ScoreboardSettings,
  utcStartOf
} from '../common/nodeSettings'
import { requireNodeAdmin } from './admin/nodeAdministration'
import type { Actor } from './auth/sessions'
import type { Database } from './db/database'
import { forgetSettings, highlightSettings } from './settings'

/**
 * The node's settings in `system_settings`, one row per value, as the
 * highlights' have always been: `scoreboard.*` here, `highlights.*` in
 * `settings.ts`. A node administrator writes them all at once; each row
 * records who.
 */

const CACHE_MS = 30000

let cache: { at: number; value: ScoreboardSettings } | undefined

let replayCache: { at: number; value: ReplaySettings } | undefined

/** Forgets the cached scoreboard and replay settings. Called after a write. */
export function forgetScoreboardSettings(): void {
  cache = undefined
  replayCache = undefined
}

/**
 * The replay's settings, falling back to the default for a missing or
 * malformed row, cached for 30 s as the scoreboard's are. Anyone may read
 * them: a replay's pace is no secret.
 */
export async function replaySettings(
  db: Kysely<Database>,
  now: number = Date.now(),
  /** Read the rows even when the cache is current, and cache what they say. */
  fresh = false
): Promise<ReplaySettings> {
  if (!fresh && replayCache != null && now - replayCache.at < CACHE_MS)
    return replayCache.value
  const row = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', 'replay.pitchSec')
    .executeTakeFirst()
  let pitchSec = defaultReplaySettings.pitchSec
  if (row != null)
    try {
      pitchSec = asReplaySettings({ pitchSec: row.value }).pitchSec
    } catch {
      /* Keep the default for a malformed stored setting. */
    }
  const value = { pitchSec }
  replayCache = { at: now, value }
  return value
}

/**
 * The replay's pitch delay in seconds, for `GET /health`: no actor needed.
 * A read that fails answers the default and says nothing, so health still
 * answers what it would have.
 */
export async function replayPitchSec(db: Kysely<Database>): Promise<number> {
  try {
    return (await replaySettings(db)).pitchSec
  } catch {
    return defaultReplaySettings.pitchSec
  }
}

/**
 * The scoreboard settings, each falling back to its default when missing or
 * malformed: a bad row moves the board, it does not take players down.
 */
export async function scoreboardSettings(
  db: Kysely<Database>,
  now: number = Date.now(),
  /** Read the rows even when the cache is current, and cache what they say. */
  fresh = false
): Promise<ScoreboardSettings> {
  if (!fresh && cache != null && now - cache.at < CACHE_MS) return cache.value
  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value'])
    .where('key', 'like', 'scoreboard.%')
    .execute()
  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const or = <T>(read: () => T, fallback: T): T => {
    try {
      return read()
    } catch {
      return fallback
    }
  }
  const defaults = defaultScoreboardSettings
  const value: ScoreboardSettings = {
    overlayStartDate: or(
      () => asDate(byKey.get('scoreboard.overlayStartDate'), 'date'),
      defaults.overlayStartDate
    ),
    single: or(
      () => asPlacement(byKey.get('scoreboard.single'), 'single'),
      defaults.single
    ),
    landscape: or(
      () => asPlacement(byKey.get('scoreboard.landscape'), 'landscape'),
      defaults.landscape
    ),
    portraitHeight: or(
      () => asHeight(byKey.get('scoreboard.portraitHeight'), 'height'),
      defaults.portraitHeight
    ),
    speedHoldSec: or(
      () => asHoldSeconds(byKey.get('scoreboard.speedHoldSec'), 'hold'),
      defaults.speedHoldSec
    )
  }
  cache = { at: now, value }
  return value
}

/** Every node setting, for the node administration screen. */
export async function nodeSettings(
  db: Kysely<Database>,
  actor: Actor
): Promise<NodeSettings> {
  await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can see the node settings'
  )
  return {
    // Past this worker's cache: another may have taken the last save.
    scoreboard: await scoreboardSettings(db, Date.now(), true),
    radar: await radarSettings(db),
    highlights: await highlightSettings(db, true),
    replay: await replaySettings(db, Date.now(), true)
  }
}

/**
 * A node administrator sets every node setting at once; a save without
 * `replay` leaves the stored pitch delay as it is.
 */
export async function setNodeSettings(
  db: Kysely<Database>,
  actor: Actor,
  settings: NodeSettingsUpdate
): Promise<void> {
  const admin = await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can change the node settings'
  )
  const { scoreboard, highlights, radar, replay } = settings
  const rows: Array<[string, unknown]> = [
    ...(replay == null
      ? []
      : [['replay.pitchSec', replay.pitchSec] as [string, unknown]]),
    ['radar.pitchWindowSec', radar.pitchWindowSec],
    ['radar.inPlayWindowSec', radar.inPlayWindowSec],
    ['scoreboard.overlayStartDate', scoreboard.overlayStartDate],
    ['scoreboard.single', placement(scoreboard.single)],
    ['scoreboard.landscape', placement(scoreboard.landscape)],
    ['scoreboard.portraitHeight', scoreboard.portraitHeight],
    ['scoreboard.speedHoldSec', scoreboard.speedHoldSec],
    ['highlights.lagSec', highlights.lagSec],
    ['highlights.leadSec', highlights.leadSec],
    ['highlights.leadSecByEventType', highlights.leadSecByEventType],
    ['highlights.mergeWithinSec', highlights.mergeWithinSec]
  ]
  const now = new Date()
  await db.transaction().execute(async trx => {
    for (const [key, value] of rows) {
      // A jsonb column takes the value as JSON text: a bare string would be
      // read as JSON, not as the string.
      const json = JSON.stringify(value)
      await trx
        .insertInto('system_settings')
        .values({ key, value: json, updated_by: admin.userId })
        .onConflict(oc =>
          oc.column('key').doUpdateSet({
            value: json,
            updated_at: now,
            updated_by: admin.userId
          })
        )
        .execute()
    }
  })
  forgetScoreboardSettings()
  forgetSettings()
}

/** Read fresh so workers use the same matching windows after an admin edit. */
export async function radarSettings(
  db: Kysely<Database>
): Promise<RadarSettings> {
  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value'])
    .where('key', 'like', 'radar.%')
    .execute()
  const settings = { ...defaultRadarSettings }
  for (const row of rows) {
    const key = row.key.slice('radar.'.length)
    if (key === 'pitchWindowSec' || key === 'inPlayWindowSec') {
      try {
        settings[key] = asHoldSeconds(row.value, row.key)
      } catch {
        /* Keep the default for malformed stored settings. */
      }
    }
  }
  return asRadarSettings(settings)
}

function placement(value: BoardPlacement): BoardPlacement {
  return { x: value.x, y: value.y, height: value.height }
}

/**
 * Whether a game's board shows over its videos, and where: shown for a game
 * starting at or after the overlay start date's 00:00 UTC. Times are
 * compared in UTC; the game's time zone is only for showing its schedule.
 */
export async function scoreboardOverlayFor(
  db: Kysely<Database>,
  startAt: Date | string
): Promise<ScoreboardOverlay> {
  const settings = await scoreboardSettings(db)
  return {
    show: new Date(startAt).getTime() >= utcStartOf(settings.overlayStartDate),
    single: settings.single,
    landscape: settings.landscape,
    portraitHeight: settings.portraitHeight
  }
}

/** The pitch-speed hold in milliseconds, for the scoreboard hub. */
export async function speedHoldMs(db: Kysely<Database>): Promise<number> {
  // The hub asks every 30 s and keeps the answer, so it reads the rows: a
  // change another worker took reaches it on its next read.
  return (await scoreboardSettings(db, Date.now(), true)).speedHoldSec * 1000
}
