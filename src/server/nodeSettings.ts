import type { Kysely } from 'kysely'
import type { PoolClient, QueryResult } from 'pg'

import { asHttpsUrl } from '../common/distribution'
import { unavailable } from '../common/errors'
import {
  appStoreProduct,
  asDate,
  asFraction,
  asHeight,
  asHoldSeconds,
  asPlacement,
  asRadarSettings,
  asReplaySettings,
  asSponsorSettings,
  type BoardPlacement,
  defaultRadarSettings,
  defaultReplaySettings,
  defaultScoreboardSettings,
  defaultSponsorSettings,
  type DistributionSettings,
  LOGO_PLACEMENTS,
  type LogoPlacement,
  type NodeSettings,
  type NodeSettingsUpdate,
  type RadarSettings,
  REEL_LAYOUTS,
  type ReelPlacement,
  type ReplaySettings,
  type ScoreboardOverlay,
  type ScoreboardSettings,
  type SponsorOverlay,
  type SponsorSettings,
  type SponsorSettingsUpdate,
  utcStartOf
} from '../common/nodeSettings'
import { requireNodeAdmin } from './admin/nodeAdministration'
import type { Actor } from './auth/sessions'
import type { Database, PooledDatabase } from './db/database'
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

let distributionCache: { at: number; value: DistributionSettings } | undefined

let sponsorCache: { at: number; value: SponsorSettings } | undefined

/**
 * Forgets the cached scoreboard, replay, about-screen links and sponsor
 * settings. Called after a write.
 */
export function forgetScoreboardSettings(): void {
  cache = undefined
  replayCache = undefined
  distributionCache = undefined
  sponsorCache = undefined
}

/** The `system_settings` key the node's uploaded sample video's object is under. */
export const SPONSOR_SAMPLE_SETTING = 'sponsors.sampleKey'

/**
 * Where sponsor logos and reels sit in each layout, and the node's sample
 * video: `sponsors.logo.<placement>`, `sponsors.reel.<layout>` and
 * `sponsors.sampleKey`. Each falls back to its default when missing or
 * malformed, so a bad row moves a logo, it does not take players down.
 * Cached for 30 s as the scoreboard's are.
 */
export async function sponsorSettings(
  db: Kysely<Database>,
  now: number = Date.now(),
  /** Read the rows even when the cache is current, and cache what they say. */
  fresh = false
): Promise<SponsorSettings> {
  if (!fresh && sponsorCache != null && now - sponsorCache.at < CACHE_MS)
    return sponsorCache.value
  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value'])
    .where('key', 'like', 'sponsors.%')
    .execute()
  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const defaults = defaultSponsorSettings
  const logo = (name: (typeof LOGO_PLACEMENTS)[number]): LogoPlacement => {
    try {
      const raw = byKey.get(`sponsors.logo.${name}`) as Record<string, unknown>
      return {
        side: asFraction(raw.side, 'side'),
        top: asFraction(raw.top, 'top'),
        maxWidth: asHeight(raw.maxWidth, 'maxWidth'),
        maxHeight: asHeight(raw.maxHeight, 'maxHeight')
      }
    } catch {
      return defaults.logo[name]
    }
  }
  const reel = (layout: (typeof REEL_LAYOUTS)[number]): ReelPlacement => {
    try {
      const raw = byKey.get(`sponsors.reel.${layout}`) as Record<
        string,
        unknown
      >
      return {
        maxWidth: asHeight(raw.maxWidth, 'maxWidth'),
        maxHeight: asHeight(raw.maxHeight, 'maxHeight')
      }
    } catch {
      return defaults.reel[layout]
    }
  }
  let sampleKey = defaults.sampleKey
  try {
    sampleKey = asSponsorSettings({
      ...defaults,
      sampleKey: byKey.get(SPONSOR_SAMPLE_SETTING) ?? null
    }).sampleKey
  } catch {
    /* Keep the default clip for a malformed stored key. */
  }
  const value: SponsorSettings = {
    logo: Object.fromEntries(
      LOGO_PLACEMENTS.map(name => [name, logo(name)])
    ) as SponsorOverlay['logo'],
    reel: Object.fromEntries(
      REEL_LAYOUTS.map(layout => [layout, reel(layout)])
    ) as SponsorOverlay['reel'],
    sampleKey
  }
  sponsorCache = { at: now, value }
  return value
}

/**
 * Where every player places a sponsor's logo and reel, for `GameSponsors`
 * and the previews. Read past this worker's cache, as the scoreboard's
 * overlay is: a save another worker took moves the next game opened.
 */
export async function sponsorOverlay(
  db: Kysely<Database>
): Promise<SponsorOverlay> {
  const { logo, reel } = await sponsorSettings(db, Date.now(), true)
  return { logo, reel }
}

/**
 * The stored sample key, locked until the transaction ends so two saves at
 * once each replace a different one. Null for none, or a malformed row.
 */
async function lockedSampleKey(trx: Kysely<Database>): Promise<string | null> {
  const row = await trx
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', SPONSOR_SAMPLE_SETTING)
    .forUpdate()
    .executeTakeFirst()
  return typeof row?.value === 'string' ? row.value : null
}

/**
 * A node administrator's uploaded sample video becomes the node's, or
 * `null` puts the default clip back. Answers the node's settings now and the
 * key it replaced (null for none), for the caller to delete once saved.
 */
export async function setSponsorSampleKey(
  db: Kysely<Database>,
  actor: Actor,
  sampleKey: string | null
): Promise<{ settings: SponsorSettings; replaced: string | null }> {
  const admin = await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can change the sponsor sample video'
  )
  const json = JSON.stringify(sampleKey)
  const replaced = await db.transaction().execute(async trx => {
    const previous = await lockedSampleKey(trx)
    await trx
      .insertInto('system_settings')
      .values({
        key: SPONSOR_SAMPLE_SETTING,
        value: json,
        updated_by: admin.userId
      })
      .onConflict(oc =>
        oc.column('key').doUpdateSet({
          value: json,
          updated_at: new Date(),
          updated_by: admin.userId
        })
      )
      .execute()
    return previous
  })
  forgetScoreboardSettings()
  return {
    settings: await sponsorSettings(db, Date.now(), true),
    replaced
  }
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
/**
 * The about screen's links. Anyone signed in may read them. A missing or
 * malformed row is an empty string, which hides that button. Cached for 30 s.
 */
export async function distributionSettings(
  db: Kysely<Database>,
  now: number = Date.now(),
  fresh = false
): Promise<DistributionSettings> {
  if (
    !fresh &&
    distributionCache != null &&
    now - distributionCache.at < CACHE_MS
  )
    return distributionCache.value
  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value'])
    .where('key', 'in', [
      'distribution.betaBuildsUrl',
      'distribution.appStoreUrl',
      'distribution.iosAppStoreUrl'
    ])
    .execute()
  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const read = (key: string): string => {
    const raw = byKey.get(key)
    if (typeof raw !== 'string' || raw === '') return ''
    try {
      return asHttpsUrl(raw)
    } catch {
      return ''
    }
  }
  const value: DistributionSettings = {
    betaBuildsUrl: read('distribution.betaBuildsUrl'),
    appStoreUrl: read('distribution.appStoreUrl'),
    iosAppStoreUrl:
      appStoreProduct(byKey.get('distribution.iosAppStoreUrl'))?.url ?? ''
  }
  distributionCache = { at: now, value }
  return value
}

const bannerLookups = new WeakMap<PooledDatabase, Promise<string | null>>()

/**
 * Nothing is cached, so a page load sees a save from any worker as soon as
 * the next read starts. Requests that arrive while a read is out share it
 * instead: a flood of page loads holds at most one request-pool connection
 * per process, and a load may get a value at most that one read old.
 */
export async function iosAppBannerId(
  db: PooledDatabase
): Promise<string | null> {
  let lookup = bannerLookups.get(db)
  if (lookup == null) {
    lookup = readIosAppBannerId(db).finally(() => {
      bannerLookups.delete(db)
    })
    bannerLookups.set(db, lookup)
  }
  return await lookup
}

async function readIosAppBannerId(db: PooledDatabase): Promise<string | null> {
  const pool = db.pool
  const timedOut = unavailable('The App Store link lookup timed out')
  // Optional metadata must not queue behind other work when the pool is full.
  if (
    pool.totalCount >= pool.options.max &&
    pool.idleCount <= pool.waitingCount
  )
    throw timedOut
  const signal = AbortSignal.timeout(750)
  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(timedOut)
      },
      { once: true }
    )
  })
  const checkout = pool.connect().then(client => {
    if (signal.aborted) client.release()
    return client
  })
  let client: PoolClient | undefined
  // Only a query the deadline abandoned can still be running on the client.
  // A server error such as the statement timeout leaves it idle and reusable,
  // and the pool itself drops a client whose connection broke.
  let settled = false
  try {
    client = await Promise.race([checkout, deadline])
    // One simple-query message runs both statements in an implicit transaction.
    // SET LOCAL therefore bounds the indexed read on the same pooler backend.
    const batch = await Promise.race([
      client
        .query(
          `set local statement_timeout = '600ms';
        select value from system_settings where key = 'distribution.iosAppStoreUrl'`
        )
        .finally(() => {
          settled = true
        }),
      deadline
    ])
    // pg returns one result per statement in a simple-query batch.
    const [, setting] = batch as unknown as Array<
      QueryResult<{ value: unknown }>
    >
    return appStoreProduct(setting.rows[0]?.value)?.appId ?? null
  } catch (error) {
    if ((error as { code?: string })?.code === '57014') throw timedOut
    throw error
  } finally {
    client?.release(!settled)
  }
}

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
    tvLandscape: or(
      () => asPlacement(byKey.get('scoreboard.tvLandscape'), 'tvLandscape'),
      defaults.tvLandscape
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
    replay: await replaySettings(db, Date.now(), true),
    distribution: await distributionSettings(db, Date.now(), true),
    jev: { configured: (await jevKey(db)) != null },
    sponsors: await sponsorSettings(db, Date.now(), true)
  }
}

/** The `system_settings` key Jev's API key is stored under. */
export const JEV_KEY_SETTING = 'jev.apiKey'

/** The longest Jev key a node administrator may set. */
export const JEV_KEY_MAX = 512

/**
 * The node's Jev API key, or null when none is set. Read on every call, with
 * no cache, so a save reaches every worker at once. Never returned by a
 * route and never logged.
 */
export async function jevKey(db: Kysely<Database>): Promise<string | null> {
  const row = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', JEV_KEY_SETTING)
    .executeTakeFirst()
  const value: unknown = row?.value
  return typeof value === 'string' && value !== '' ? value : null
}

/** A node administrator sets or replaces the Jev key; the row records who. */
export async function setJevKey(
  db: Kysely<Database>,
  actor: Actor,
  apiKey: string
): Promise<void> {
  const admin = await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can set the Jev key'
  )
  const json = JSON.stringify(apiKey)
  await db
    .insertInto('system_settings')
    .values({ key: JEV_KEY_SETTING, value: json, updated_by: admin.userId })
    .onConflict(oc =>
      oc.column('key').doUpdateSet({
        value: json,
        updated_at: new Date(),
        updated_by: admin.userId
      })
    )
    .execute()
}

/** A node administrator clears the Jev key, so search ranks without Jev. */
export async function clearJevKey(
  db: Kysely<Database>,
  actor: Actor
): Promise<void> {
  await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can remove the Jev key'
  )
  await db
    .deleteFrom('system_settings')
    .where('key', '=', JEV_KEY_SETTING)
    .execute()
}

/**
 * A node administrator sets every node setting at once; a save without
 * `replay` leaves the stored pitch delay as it is. Answers the uploaded
 * sample video a save that put the default clip back replaced (null for
 * none), for the caller to delete once saved.
 */
export async function setNodeSettings(
  db: Kysely<Database>,
  actor: Actor,
  settings: NodeSettingsUpdate
): Promise<{ replacedSampleKey: string | null }> {
  const admin = await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can change the node settings'
  )
  const { scoreboard, highlights, radar, replay, distribution, sponsors } =
    settings
  const rows: Array<[string, unknown]> = [
    ...(sponsors == null ? [] : sponsorRows(sponsors)),
    ...(replay == null
      ? []
      : [['replay.pitchSec', replay.pitchSec] as [string, unknown]]),
    ...(distribution == null
      ? []
      : [
          ['distribution.betaBuildsUrl', distribution.betaBuildsUrl] as [
            string,
            unknown
          ],
          ['distribution.appStoreUrl', distribution.appStoreUrl] as [
            string,
            unknown
          ]
        ]),
    ['radar.pitchWindowSec', radar.pitchWindowSec],
    ['radar.inPlayWindowSec', radar.inPlayWindowSec],
    ['scoreboard.overlayStartDate', scoreboard.overlayStartDate],
    ['scoreboard.single', placement(scoreboard.single)],
    ['scoreboard.landscape', placement(scoreboard.landscape)],
    ...(scoreboard.tvLandscape === undefined
      ? []
      : [
          ['scoreboard.tvLandscape', placement(scoreboard.tvLandscape)] as [
            string,
            unknown
          ]
        ]),
    ['scoreboard.portraitHeight', scoreboard.portraitHeight],
    ['scoreboard.speedHoldSec', scoreboard.speedHoldSec],
    ['highlights.lagSec', highlights.lagSec],
    ['highlights.leadSec', highlights.leadSec],
    ['highlights.leadSecByEventType', highlights.leadSecByEventType],
    ['highlights.mergeWithinSec', highlights.mergeWithinSec],
    ['highlights.tailSec', highlights.tailSec]
  ]
  if (distribution?.iosAppStoreUrl !== undefined)
    rows.push(['distribution.iosAppStoreUrl', distribution.iosAppStoreUrl])
  const now = new Date()
  const replacedSampleKey = await db.transaction().execute(async trx => {
    const replaced =
      sponsors?.sampleKey === null ? await lockedSampleKey(trx) : null
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
    return replaced
  })
  forgetScoreboardSettings()
  forgetSettings()
  return { replacedSampleKey }
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

/**
 * The `system_settings` rows a save of the sponsor settings writes: the
 * sample's only to put the default clip back, since the sample is the
 * upload's.
 */
function sponsorRows(
  sponsors: SponsorSettingsUpdate
): Array<[string, unknown]> {
  return [
    ...LOGO_PLACEMENTS.map((name): [string, unknown] => {
      const { side, top, maxWidth, maxHeight } = sponsors.logo[name]
      return [`sponsors.logo.${name}`, { side, top, maxWidth, maxHeight }]
    }),
    ...REEL_LAYOUTS.map((layout): [string, unknown] => {
      const { maxWidth, maxHeight } = sponsors.reel[layout]
      return [`sponsors.reel.${layout}`, { maxWidth, maxHeight }]
    }),
    ...(sponsors.sampleKey === null
      ? [[SPONSOR_SAMPLE_SETTING, null] as [string, unknown]]
      : [])
  ]
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
  const settings = await scoreboardSettings(db, Date.now(), true)
  return {
    show: new Date(startAt).getTime() >= utcStartOf(settings.overlayStartDate),
    single: settings.single,
    landscape: settings.landscape,
    tvLandscape: settings.tvLandscape,
    portraitHeight: settings.portraitHeight
  }
}

/** The pitch-speed hold in milliseconds, for the scoreboard hub. */
export async function speedHoldMs(db: Kysely<Database>): Promise<number> {
  // The hub asks every 30 s and keeps the answer, so it reads the rows: a
  // change another worker took reaches it on its next read.
  return (await scoreboardSettings(db, Date.now(), true)).speedHoldSec * 1000
}
