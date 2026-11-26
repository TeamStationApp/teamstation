import { asHttpsUrl } from './distribution'

/**
 * The settings a node administrator sets for the whole node: where the
 * scoreboard sits over video, how long a radar speed stays on the board, and
 * how highlights are timed. One definition for the server, which stores and
 * serves them, and the node administration screen, which edits them.
 *
 * Positions and heights are fractions from 0 to 1 of the video they sit on,
 * from its top-left corner: x to the right, y down. A height is the full
 * board's, batter and pitcher rows included; with nobody named the board is
 * shorter at the same scale.
 */

/** Where the board sits over one video, as fractions of that video. */
export interface BoardPlacement {
  x: number
  y: number
  height: number
}

export interface ScoreboardSettings {
  /**
   * The first date, `YYYY-MM-DD` in UTC, whose games show the board over
   * their videos: a game starting at or after its 00:00 UTC shows it; an
   * earlier one shows none. Times are compared in UTC; a time zone is only
   * for showing a time to somebody.
   */
  overlayStartDate: string
  /** A single camera's picture. */
  single: BoardPlacement
  /** The landscape grid of four angles: over the top-left angle. */
  landscape: BoardPlacement
  /** Four-angle TV placement, independent of phone and web landscape. */
  tvLandscape?: BoardPlacement
  /**
   * The portrait grid of four angles: the board's height above the stack, as
   * a fraction of one angle's height. With fewer angles it is full width.
   */
  portraitHeight: number
  /** How long a radar pitch speed stays on the board, in seconds. */
  speedHoldSec: number
}

export interface HighlightTimings {
  /** How long after the play the scorekeeper's tap lands, in seconds. */
  lagSec: number
  /** How long before the play a highlight starts, in seconds. */
  leadSec: number
  /** Exceptions by GUMBO event type, e.g. a shorter lead for a strikeout. */
  leadSecByEventType: Record<string, number>
  /**
   * How close two outcomes of a play have to be logged to count as one
   * moment, in seconds. Often a hit and the run it drove in are genuinely one
   * thing (a walk that forces a runner home, a single scoring from third) and
   * the scorekeeper taps once, or twice within a second. Two rows there would
   * be two thumbnails of the same piece of video. Further apart, they are
   * separate moments and get a row each.
   */
  mergeWithinSec: number
  /**
   * How long a highlight keeps playing after the play itself, in seconds:
   * it stops at the play's corrected moment plus this. Zero stops on the
   * play.
   */
  tailSec: number
}

/** The beta download and TestFlight links on About, and the published app offered in Safari. */
export interface DistributionSettings {
  /**
   * Where beta builds are downloaded. Empty hides that button. A node
   * administrator sets it; the server file is not involved.
   */
  betaBuildsUrl: string
  /**
   * The iOS TestFlight download. Empty hides that button.
   */
  appStoreUrl: string
  /** Published product offered by Safari on the website. Empty hides the banner. */
  iosAppStoreUrl: string
}

export interface NodeSettings {
  scoreboard: ScoreboardSettings
  highlights: HighlightTimings
  radar: RadarSettings
  replay: ReplaySettings
  distribution: DistributionSettings
  jev: JevSettings
  sponsors: SponsorSettings
}

/**
 * Jev's search ranking. The key itself is set and cleared through its own
 * routes and never read back: the settings only say whether one is set.
 */
export interface JevSettings {
  configured: boolean
}

export const defaultJevSettings: JevSettings = { configured: false }

/** The 3D replay's pacing. */
export interface ReplaySettings {
  /** How long a replay holds each pitch on the card, in seconds. */
  pitchSec: number
}

export const defaultReplaySettings: ReplaySettings = {
  pitchSec: 5
}

export const defaultDistributionSettings: DistributionSettings = {
  betaBuildsUrl: '',
  appStoreUrl: '',
  iosAppStoreUrl: ''
}

export interface RadarSettings {
  pitchWindowSec: number
  inPlayWindowSec: number
}

export const defaultRadarSettings: RadarSettings = {
  pitchWindowSec: 3,
  inPlayWindowSec: 15
}

export const defaultScoreboardSettings: ScoreboardSettings = {
  overlayStartDate: '2026-10-01',
  // On the card's stops, so Reset to defaults puts back exactly these.
  single: { x: 0.01, y: 0.01, height: 0.15 },
  landscape: { x: 0.01, y: 0.01, height: 0.15 },
  tvLandscape: { x: 0.01, y: 0.01, height: 0.15 },
  portraitHeight: 0.15,
  speedHoldSec: 5
}

export const defaultHighlightTimings: HighlightTimings = {
  lagSec: 8,
  leadSec: 30,
  leadSecByEventType: { strikeout: 10 },
  mergeWithinSec: 5,
  tailSec: 5
}

/**
 * Where a sponsor's logo sits over one video: its margins from the top and
 * from the side it is on, and the largest box it fits in, all as fractions
 * of that video.
 */
export interface LogoPlacement {
  side: number
  top: number
  maxWidth: number
  maxHeight: number
}

/** The largest box a sponsor's reel fits in, as fractions of the screen. */
export interface ReelPlacement {
  maxWidth: number
  maxHeight: number
}

/** The layouts a reel has a space in: portrait with 1–2, 3 or 4 angles, and landscape with 1–4. */
export type ReelLayout =
  | 'portrait12'
  | 'portrait3'
  | 'portrait4'
  | 'landscape1'
  | 'landscape2'
  | 'landscape3'
  | 'landscape4'

export const REEL_LAYOUTS: readonly ReelLayout[] = [
  'portrait12',
  'portrait3',
  'portrait4',
  'landscape1',
  'landscape2',
  'landscape3',
  'landscape4'
]

export const LOGO_PLACEMENTS = ['single', 'grid', 'tv', 'portrait'] as const

/** What a player needs to place a sponsor's logo and reel. */
export interface SponsorOverlay {
  logo: Record<(typeof LOGO_PLACEMENTS)[number], LogoPlacement>
  reel: Record<ReelLayout, ReelPlacement>
}

export interface SponsorSettings extends SponsorOverlay {
  /** The node's own sample video's object, or `null` for the default. */
  sampleKey: string | null
}

/** Where the node's sample video is when nobody has uploaded one. */
export const DEFAULT_SPONSOR_SAMPLE_KEY = 'sponsors/sample/default.mp4'

const defaultLogoPlacement: LogoPlacement = {
  side: 0.05,
  top: 0.05,
  maxWidth: 0.25,
  maxHeight: 0.25
}

const defaultReelPlacement: ReelPlacement = {
  maxWidth: 1 / 3,
  maxHeight: 1 / 3
}

// Each group its own object, so a copy of the defaults changes one group at a time.
export const defaultSponsorSettings: SponsorSettings = {
  logo: {
    single: { ...defaultLogoPlacement },
    grid: { ...defaultLogoPlacement },
    tv: { ...defaultLogoPlacement },
    portrait: { ...defaultLogoPlacement }
  },
  reel: Object.fromEntries(
    REEL_LAYOUTS.map(layout => [layout, { ...defaultReelPlacement }])
  ) as Record<ReelLayout, ReelPlacement>,
  sampleKey: null
}

export const defaultNodeSettings: NodeSettings = {
  scoreboard: defaultScoreboardSettings,
  highlights: defaultHighlightTimings,
  radar: defaultRadarSettings,
  replay: defaultReplaySettings,
  distribution: defaultDistributionSettings,
  jev: defaultJevSettings,
  sponsors: defaultSponsorSettings
}

/**
 * The objects a node's own sample video may be at: the default, or one a
 * node administrator uploaded, `sponsors/sample/<YYYY-MM-DD>-<id>.mp4`.
 */
const SAMPLE_KEY = /^sponsors\/sample\/[A-Za-z0-9_-]+\.mp4$/

/** The day an uploaded sample's key names, `YYYY-MM-DD`, or `null` for the default. */
export function sampleUploadedOn(sampleKey: string | null): string | null {
  return (
    /^sponsors\/sample\/(\d{4}-\d{2}-\d{2})-/.exec(sampleKey ?? '')?.[1] ?? null
  )
}

/** The sponsor settings, checked: the overlay, and a sample key or `null`. */
export function asSponsorSettings(raw: unknown): SponsorSettings {
  const value = record(raw, 'sponsors')
  const sampleKey = value.sampleKey ?? null
  if (
    sampleKey !== null &&
    (typeof sampleKey !== 'string' || !SAMPLE_KEY.test(sampleKey))
  )
    throw new TypeError('sponsors.sampleKey must be a sample video object')
  return { ...asSponsorOverlay(value), sampleKey }
}

/** A sponsor overlay, checked: every placement present and in range. */
export function asSponsorOverlay(raw: unknown): SponsorOverlay {
  const value = record(raw, 'the sponsor overlay')
  const logo = record(value.logo, 'the logo placements')
  const reel = record(value.reel, 'the reel placements')
  return {
    logo: Object.fromEntries(
      LOGO_PLACEMENTS.map(name => {
        const placement = record(logo[name], `the ${name} logo`)
        return [
          name,
          {
            side: asFraction(placement.side, `${name} side`),
            top: asFraction(placement.top, `${name} top`),
            maxWidth: asHeight(placement.maxWidth, `${name} maxWidth`),
            maxHeight: asHeight(placement.maxHeight, `${name} maxHeight`)
          }
        ]
      })
    ) as SponsorOverlay['logo'],
    reel: Object.fromEntries(
      REEL_LAYOUTS.map(layout => {
        const placement = record(reel[layout], `the ${layout} reel`)
        return [
          layout,
          {
            maxWidth: asHeight(placement.maxWidth, `${layout} maxWidth`),
            maxHeight: asHeight(placement.maxHeight, `${layout} maxHeight`)
          }
        ]
      })
    ) as SponsorOverlay['reel']
  }
}

/** The longest any of the second-valued settings may be. */
export const MAX_SETTING_SEC = 600

/** What a player is told about one game's board. */
export interface ScoreboardOverlay {
  /** Whether the game is on or after the overlay start date. */
  show: boolean
  single: BoardPlacement
  landscape: BoardPlacement
  tvLandscape?: BoardPlacement
  portraitHeight: number
}

export function asScoreboardOverlay(raw: unknown): ScoreboardOverlay {
  const value = record(raw, 'the overlay')
  if (typeof value.show !== 'boolean')
    throw new TypeError('The overlay needs show')
  return {
    show: value.show,
    single: asPlacement(value.single, 'single'),
    landscape: asPlacement(value.landscape, 'landscape'),
    tvLandscape: asPlacement(
      value.tvLandscape ?? defaultScoreboardSettings.tvLandscape,
      'tvLandscape'
    ),
    portraitHeight: asHeight(value.portraitHeight, 'portraitHeight')
  }
}

/**
 * A whole settings document, checked: every field present and in range. The
 * messages name the field, for the screen to show beside it.
 */
export function asNodeSettings(raw: unknown): NodeSettings {
  const {
    replay,
    distribution,
    sponsors: _save,
    ...rest
  } = asNodeSettingsUpdate(raw)
  const { jev, sponsors } = raw as Record<string, unknown>
  return {
    ...rest,
    scoreboard: {
      ...rest.scoreboard,
      tvLandscape:
        rest.scoreboard.tvLandscape ?? defaultScoreboardSettings.tvLandscape
    },
    replay: replay ?? defaultReplaySettings,
    distribution: { ...defaultDistributionSettings, ...distribution },
    // A server from before Jev says nothing: no key.
    jev: jev == null ? defaultJevSettings : asJevSettings(jev),
    // A server from before sponsors serves the defaults.
    sponsors:
      sponsors == null ? defaultSponsorSettings : asSponsorSettings(sponsors)
  }
}

export function asJevSettings(raw: unknown): JevSettings {
  const value = record(raw, 'jev')
  if (typeof value.configured !== 'boolean')
    throw new TypeError('jev.configured must be true or false')
  return { configured: value.configured }
}

/**
 * A save from the node administration screen. An app from before the replay
 * section sends no `replay`, and its save keeps the stored pitch delay. An
 * app from before the about-screen links sends no `distribution`, and its
 * save keeps the stored URLs. An app from before sponsors sends no
 * `sponsors`, and its save keeps the stored placements and sample. `jev` is
 * read only: a save that carries it changes nothing, as the key has its own
 * routes.
 */
export type NodeSettingsUpdate = Omit<
  NodeSettings,
  'replay' | 'distribution' | 'jev' | 'sponsors'
> & {
  replay?: ReplaySettings
  distribution?: Omit<DistributionSettings, 'iosAppStoreUrl'> & {
    iosAppStoreUrl?: string
  }
  sponsors?: SponsorSettingsUpdate
}

/**
 * The sponsor settings a save stores: the placements, and `sampleKey: null`
 * only to put the default clip back. The sample itself is the upload's
 * (`PUT /node/sponsor-sample`): a save says nothing else about it.
 */
export type SponsorSettingsUpdate = SponsorOverlay & { sampleKey?: null }

/** What the app sends to save the node settings. */
export type NodeSettingsSave = Omit<NodeSettings, 'sponsors'> & {
  sponsors?: SponsorOverlay & { sampleKey?: string | null }
}

/**
 * A save's sponsor settings, checked as `asSponsorSettings` checks them: a
 * `sampleKey` of `null` is kept, to put the default clip back, and a key sent
 * back, which a card read before another upload would hold, is dropped.
 */
export function asSponsorSettingsUpdate(raw: unknown): SponsorSettingsUpdate {
  const { sampleKey, ...overlay } = asSponsorSettings(raw)
  const sent = (raw as Record<string, unknown>).sampleKey
  return sent === null && sampleKey === null
    ? { ...overlay, sampleKey: null }
    : overlay
}

/** A save, checked as `asNodeSettings` checks a document, `replay` optional. */
export function asNodeSettingsUpdate(raw: unknown): NodeSettingsUpdate {
  const value = record(raw, 'the settings')
  const scoreboard = record(value.scoreboard, 'scoreboard')
  const highlights = record(value.highlights, 'highlights')
  return {
    radar: asRadarSettings(value.radar ?? defaultRadarSettings),
    ...(value.replay == null ? {} : { replay: asReplaySettings(value.replay) }),
    ...(value.distribution == null
      ? {}
      : { distribution: asDistributionUpdate(value.distribution) }),
    ...(value.sponsors == null
      ? {}
      : { sponsors: asSponsorSettingsUpdate(value.sponsors) }),
    scoreboard: {
      overlayStartDate: asDate(
        scoreboard.overlayStartDate,
        'scoreboard.overlayStartDate'
      ),
      single: asPlacement(scoreboard.single, 'scoreboard.single'),
      landscape: asPlacement(scoreboard.landscape, 'scoreboard.landscape'),
      ...(scoreboard.tvLandscape === undefined
        ? {}
        : {
            tvLandscape: asPlacement(
              scoreboard.tvLandscape,
              'scoreboard.tvLandscape'
            )
          }),
      portraitHeight: asHeight(
        scoreboard.portraitHeight,
        'scoreboard.portraitHeight'
      ),
      speedHoldSec: asHoldSeconds(
        scoreboard.speedHoldSec,
        'scoreboard.speedHoldSec'
      )
    },
    highlights: {
      lagSec: asSeconds(highlights.lagSec, 'highlights.lagSec'),
      leadSec: asSeconds(highlights.leadSec, 'highlights.leadSec'),
      leadSecByEventType: asLeadMap(
        highlights.leadSecByEventType,
        'highlights.leadSecByEventType'
      ),
      mergeWithinSec: asSeconds(
        highlights.mergeWithinSec,
        'highlights.mergeWithinSec'
      ),
      // A document from before the setting has none: the default, as
      // `radar` is. The server keeps a node's own when an app saves without
      // it (`PUT /node/settings`).
      tailSec: asSeconds(
        highlights.tailSec ?? defaultHighlightTimings.tailSec,
        'highlights.tailSec'
      )
    }
  }
}

/** The two About links accept HTTPS URLs without credentials. Safari requires
 * an App Store product link. An empty string hides the corresponding control. */
function asDistributionUpdate(
  raw: unknown
): NonNullable<NodeSettingsUpdate['distribution']> {
  const value = record(raw, 'distribution')
  if (!('betaBuildsUrl' in value) || !('appStoreUrl' in value))
    throw new TypeError(
      'distribution requires both betaBuildsUrl and appStoreUrl'
    )
  return {
    betaBuildsUrl: asOptionalHttps(
      value.betaBuildsUrl,
      'distribution.betaBuildsUrl'
    ),
    appStoreUrl: asOptionalHttps(value.appStoreUrl, 'distribution.appStoreUrl'),
    ...('iosAppStoreUrl' in value
      ? {
          iosAppStoreUrl: asDistributionUrl(
            'iosAppStoreUrl',
            value.iosAppStoreUrl
          )
        }
      : {})
  }
}

/** An App Store product has an optional storefront and app name before its ID. */
export function appStoreProduct(
  raw: unknown
): { url: string; appId: string } | undefined {
  if (typeof raw !== 'string') return
  const url = raw.trim()
  const path = /^https:\/\/apps\.apple\.com(?::0*443)?(\/[^?#]*)/i.exec(
    url
  )?.[1]
  if (
    path == null ||
    /[\uD800-\uDFFF]/u.test(url) || // Unicode mode matches only unpaired surrogates.
    /[\s\\\x00-\x1f\x7f-\x9f]|%(?![0-9a-f]{2})/i.test(url) // eslint-disable-line no-control-regex -- URL parsing silently strips control characters.
  )
    return
  // App names must be real path segments, including when percent-encoded.
  if (/%(?:2f|5c)|\/(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) return
  const match = /^\/(?:[a-zA-Z]{2}\/)?app\/(?:[^/]+\/)?id([0-9]+)\/*$/.exec(
    path
  )
  if (match != null) return { url, appId: match[1] }
}

export function asDistributionUrl(
  key: keyof DistributionSettings,
  raw: unknown
): string {
  if (key !== 'iosAppStoreUrl')
    return asOptionalHttps(raw, `distribution.${key}`)
  if (typeof raw === 'string' && raw.trim() === '') return ''
  const product = appStoreProduct(raw)
  if (product != null) return product.url
  throw new TypeError(
    'iOS App Store link must be an App Store product URL such as https://apps.apple.com/us/app/teamstation/id6824597245'
  )
}

function asOptionalHttps(raw: unknown, name: string): string {
  if (raw == null || raw === '') return ''
  if (typeof raw !== 'string')
    throw new TypeError(`${name} must be an HTTPS URL`)
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  try {
    return asHttpsUrl(trimmed)
  } catch {
    throw new TypeError(`${name} must be an HTTPS URL`)
  }
}

/** The replay's settings: a pitch delay in whole seconds, 1 to 600. */
export function asReplaySettings(raw: unknown): ReplaySettings {
  const value = record(raw, 'replay')
  const pitchSec = value.pitchSec
  if (
    typeof pitchSec !== 'number' ||
    !Number.isInteger(pitchSec) ||
    pitchSec < 1 ||
    pitchSec > MAX_SETTING_SEC
  )
    throw new TypeError(
      `replay.pitchSec must be a whole number of seconds from 1 to ${MAX_SETTING_SEC}`
    )
  return { pitchSec }
}

export function asRadarSettings(raw: unknown): RadarSettings {
  const value = record(raw, 'radar')
  return {
    pitchWindowSec: asHoldSeconds(value.pitchWindowSec, 'radar.pitchWindowSec'),
    inPlayWindowSec: asHoldSeconds(
      value.inPlayWindowSec,
      'radar.inPlayWindowSec'
    )
  }
}

export function asPlacement(raw: unknown, name: string): BoardPlacement {
  const value = record(raw, name)
  return {
    x: asFraction(value.x, `${name}.x`),
    y: asFraction(value.y, `${name}.y`),
    height: asHeight(value.height, `${name}.height`)
  }
}

/** A fraction from 0 up to, not including, 1: a position. */
export function asFraction(raw: unknown, name: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw >= 1)
    throw new TypeError(`${name} must be a number from 0 to under 1`)
  return raw
}

/** A fraction above 0 up to 1: a height. */
export function asHeight(raw: unknown, name: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 1)
    throw new TypeError(`${name} must be a number above 0, up to 1`)
  return raw
}

export function asSeconds(raw: unknown, name: string): number {
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > MAX_SETTING_SEC
  )
    throw new TypeError(`${name} must be from 0 to ${MAX_SETTING_SEC} seconds`)
  return raw
}

/**
 * The pitch-speed hold: seconds above 0, up to `MAX_SETTING_SEC`. A hold of
 * 0 would take a radar speed off the board as it landed, so it never shows.
 */
export function asHoldSeconds(raw: unknown, name: string): number {
  const seconds = asSeconds(raw, name)
  if (seconds <= 0)
    throw new TypeError(
      `${name} must be above 0, up to ${MAX_SETTING_SEC} seconds`
    )
  return seconds
}

/** A calendar date, `YYYY-MM-DD`, that exists. */
export function asDate(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw))
    throw new TypeError(`${name} must be a date, YYYY-MM-DD`)
  const [year, month, day] = raw.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new TypeError(`${name} must be a date, YYYY-MM-DD`)
  return raw
}

/** Seconds by GUMBO play type, each key a play type and each value seconds. */
export function asLeadMap(raw: unknown, name: string): Record<string, number> {
  const value = record(raw, name)
  const result: Record<string, number> = {}
  for (const [type, seconds] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/.test(type))
      throw new TypeError(`${name}: ${type} is not a play type`)
    result[type] = asSeconds(seconds, `${name}.${type}`)
  }
  return result
}

function record(raw: unknown, name: string): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    throw new TypeError(`${name} must be an object`)
  return raw as Record<string, unknown>
}

/** The instant a `YYYY-MM-DD` date starts, at 00:00 UTC, in ms. */
export function utcStartOf(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}
