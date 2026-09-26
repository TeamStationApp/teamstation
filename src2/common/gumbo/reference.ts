import { GUMBO_EXTENSION_EVENT_TYPES } from '../gumboEventTypes'
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
