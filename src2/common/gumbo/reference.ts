import {
  eventTypeName,
  GUMBO_EXTENSION_EVENT_TYPES,
  normalizeEventType
} from '../gumboEventTypes'
import eventTypes from './reference/eventTypes.json'
import hitTrajectories from './reference/hitTrajectories.json'
import pitchCodes from './reference/pitchCodes.json'
import positions from './reference/positions.json'
import runnerDetailTypes from './reference/runnerDetailTypes.json'

// Gumbo has no written specification. The standard is MLB's own code lists
// and the shape of a live feed, fetched once from statsapi.mlb.com and kept
// in `reference/` beside this file, so tests compare against them and never
// against a network call:
//
//   eventTypes.json         api/v1/eventTypes
//   pitchCodes.json         api/v1/pitchCodes
//   hitTrajectories.json    api/v1/hitTrajectories
//   positions.json          api/v1/positions
//   runnerDetailTypes.json  api/v1/runnerDetailTypes, plus r_adv_play, which
//                           the live feed writes and the list leaves out
//   feed776258.json         api/v1.1/game/776258/feed/live, the shapes

/** MLB's result and action event types. */
export const MLB_EVENT_TYPES: ReadonlySet<string> = new Set(
  eventTypes.map(entry => entry.code)
)

/** MLB's event types and GameStation's extensions: what a play may name. */
export const STORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...MLB_EVENT_TYPES,
  ...GUMBO_EXTENSION_EVENT_TYPES
])

/**
 * MLB's name for each event type: the list's own description, which is the
 * name the live feed writes as `result.event` and as a runner's or an
 * action's `details.event` (`Forceout`, `Sac Bunt`, `Stolen Base 2B`).
 */
const MLB_EVENT_NAMES: ReadonlyMap<string, string> = new Map(
  eventTypes.map(entry => [entry.code, entry.description])
)
/** GameStation's extensions, named in MLB's style. */
const EXTENSION_NAMES: Record<string, string> = {
  final_score: 'Final Score',
  score_correction: 'Score Correction',
  gs_manual_placement: 'Batter Placed On Base',
  gs_batter_out: 'Batter Out'
}

/**
 * What the live feed names an out on a ball in play, a `field_out`, by how it
 * was made, in place of the list's plain `Field Out`.
 */
export const FIELD_OUT_NAMES: ReadonlySet<string> = new Set([
  'Groundout',
  'Flyout',
  'Lineout',
  'Pop Out',
  'Bunt Groundout',
  'Bunt Pop Out',
  'Bunt Lineout'
])

/** MLB's name for an event type, and a legacy code's listed one. */
export function mlbEventName(eventType: string): string {
  const listed = normalizeEventType(eventType)
  return (
    MLB_EVENT_NAMES.get(listed) ??
    EXTENSION_NAMES[listed] ??
    eventTypeName(listed)
  )
}

/** Pitch codes: `B`, `C`, `S`, `X`, … */
export const PITCH_CODES: ReadonlySet<string> = new Set(
  pitchCodes.map(entry => entry.code)
)

/** Batted-ball trajectories: `ground_ball`, `bunt_popup`, … */
export const HIT_TRAJECTORIES: ReadonlySet<string> = new Set(
  hitTrajectories.map(entry => entry.code)
)

/** Position codes, `1` to `9` for the fielders, then `D`, `O`, … */
export const POSITION_CODES: ReadonlySet<string> = new Set(
  positions.map(entry => entry.code)
)

/** A runner's `movementReason`: `r_force_out`, `r_adv_play`, … */
export const MOVEMENT_REASONS: ReadonlySet<string> = new Set(
  runnerDetailTypes.map(entry => entry.statName)
)

/** A position as a Gumbo credit names it. */
export interface GumboPosition {
  code: string
  name: string
  type: string
  abbreviation: string
}

/**
 * The positions a player can take in a game (`P` to `RF`, `DH`, `PH`, …), by
 * abbreviation, in the shape a credit's `position` has in the live feed.
 */
export const GAME_POSITIONS: ReadonlyMap<string, GumboPosition> = new Map(
  positions
    .filter(entry => entry.gamePosition)
    .map(entry => [
      entry.abbrev,
      {
        code: entry.code,
        name: entry.fullName,
        type: entry.type,
        abbreviation: entry.abbrev
      }
    ])
)
