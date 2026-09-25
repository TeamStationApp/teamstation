import type { PitchCall } from './actions'

/**
 * What an action did, in the order it happened, for the scoring screen to
 * animate. A transition names people and bases, never a coordinate or a
 * duration: where a runner stands and how long he takes to get there is the
 * screen's business, so the animation clock can never change the game.
 *
 * Bases are 0 (the plate) to 4 (home).
 */
export type Transition =
  | { type: 'pitchThrown'; call: PitchCall | 'X'; pitcher: number }
  | { type: 'ballFielded'; fielder: number }
  | {
      type: 'runnerMoved'
      runner: number
      from: number
      to: number
      /** Headed home with his fate still to be decided. */
      pendingHome: boolean
      /** Scores without a decision once nobody ahead of him is waiting. */
      automaticHome: boolean
    }
  | { type: 'runnerReturned'; runner: number; from: number; to: number }
  | { type: 'throwMade'; from: number; to: number }
  | {
      type: 'outRecorded'
      runner: number
      /** The base he was on, 0 at the plate, 4 headed home. */
      from: number
      at: number
      outs: number
    }
  | { type: 'runScored'; runner: number; rbi: boolean }
  | { type: 'runsTakenBack'; runs: number }
  | { type: 'errorCharged'; fielder: number }
  | { type: 'batterChanged'; batter: number | null }
  | { type: 'playClosed'; atBatIndex: number; eventType: string }
  | { type: 'halfEnded'; inning: number; half: 'top' | 'bottom' }
  | { type: 'gameEnded' }

export type TransitionType = Transition['type']

/** Every transition type, so a test can check a list is closed. */
export const TRANSITION_TYPES: readonly TransitionType[] = [
  'pitchThrown',
  'ballFielded',
  'runnerMoved',
  'runnerReturned',
  'throwMade',
  'outRecorded',
  'runScored',
  'runsTakenBack',
  'errorCharged',
  'batterChanged',
  'playClosed',
  'halfEnded',
  'gameEnded'
]
