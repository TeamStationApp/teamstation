import type { ScoringAction } from '../../common/scoring/actions'
import { lstrings, sprintf } from '../locales/strings'

/** `camelCase` or `snake_case` as words: an enum's name, for want of a key. */
const words = (text: string): string =>
  text.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
const capital = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1)

const PITCHES = {
  B: () => lstrings.remote_log_pitch_ball,
  C: () => lstrings.remote_log_pitch_called,
  S: () => lstrings.remote_log_pitch_swinging,
  F: () => lstrings.remote_log_pitch_foul,
  T: () => lstrings.remote_log_pitch_foul_tip,
  L: () => lstrings.remote_log_pitch_foul_bunt
} as const
const FLOW = {
  closePlay: () => lstrings.remote_log_close_play,
  endHalf: () => lstrings.remote_log_end_half,
  endGame: () => lstrings.remote_log_end_game,
  placeRunner: () => lstrings.remote_log_place_runner,
  override: () => lstrings.remote_log_override
} as const

const withReason = (text: string, reason: string | undefined): string =>
  reason == null
    ? text
    : sprintf(lstrings.remote_log_with_reason, text, words(reason))

/**
 * One action in a few words, for a row with no game to describe it from: a
 * removed action, or a span the play formatter cannot tell.
 */
export function actionWords(action: ScoringAction): string {
  switch (action.type) {
    case 'lineup':
      return lstrings.remote_log_lineup
    case 'pitch':
      return PITCHES[action.call]()
    case 'ballInPlay': {
      const kind = capital(words(action.trajectory ?? action.contact))
      return action.direction == null
        ? kind
        : sprintf(
            lstrings.remote_log_ball_in_play_to,
            kind,
            words(action.direction)
          )
    }
    case 'result':
      return withReason(capital(words(action.eventType)), action.outBy)
    case 'runnerMovement':
      return withReason(
        sprintf(
          action.out === true
            ? lstrings.remote_log_runner_out_at
            : lstrings.remote_log_runner_to,
          action.to
        ),
        action.reason
      )
    case 'baseRunning': {
      const kind = capital(words(action.kind))
      return action.to == null
        ? kind
        : sprintf(lstrings.remote_log_at_base, kind, action.to)
    }
    case 'batteryEvent':
      return capital(words(action.kind))
    case 'fieldingPlay':
      return action.error == null
        ? lstrings.remote_log_fielding_play
        : lstrings.remote_log_fielding_error
    case 'gameFlow':
      return FLOW[action.kind]()
  }
}
