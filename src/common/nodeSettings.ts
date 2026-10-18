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
}

export interface NodeSettings {
  scoreboard: ScoreboardSettings
  highlights: HighlightTimings
  radar: RadarSettings
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
  portraitHeight: 0.15,
  speedHoldSec: 5
}

export const defaultHighlightTimings: HighlightTimings = {
  lagSec: 8,
  leadSec: 30,
  leadSecByEventType: { strikeout: 10 },
  mergeWithinSec: 5
}

export const defaultNodeSettings: NodeSettings = {
  scoreboard: defaultScoreboardSettings,
  highlights: defaultHighlightTimings,
  radar: defaultRadarSettings
}

/** The longest any of the second-valued settings may be. */
export const MAX_SETTING_SEC = 600

/** What a player is told about one game's board. */
export interface ScoreboardOverlay {
  /** Whether the game is on or after the overlay start date. */
  show: boolean
  single: BoardPlacement
  landscape: BoardPlacement
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
    portraitHeight: asHeight(value.portraitHeight, 'portraitHeight')
  }
}

/**
 * A whole settings document, checked: every field present and in range. The
 * messages name the field, for the screen to show beside it.
 */
export function asNodeSettings(raw: unknown): NodeSettings {
  const value = record(raw, 'the settings')
  const scoreboard = record(value.scoreboard, 'scoreboard')
  const highlights = record(value.highlights, 'highlights')
  return {
    radar: asRadarSettings(value.radar ?? defaultRadarSettings),
    scoreboard: {
      overlayStartDate: asDate(
        scoreboard.overlayStartDate,
        'scoreboard.overlayStartDate'
      ),
      single: asPlacement(scoreboard.single, 'scoreboard.single'),
      landscape: asPlacement(scoreboard.landscape, 'scoreboard.landscape'),
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
      )
    }
  }
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
