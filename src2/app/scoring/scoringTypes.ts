import type { ScoringAction } from '../../common/scoring/actions'
import type { HomeRunKind, Override } from '../../common/scoring/rules'
import type {
  BatSide,
  GamePlayer,
  GameSide,
  GameState,
  GameTeam
} from '../../common/scoring/state'
import type { GroundPoint } from '../field/fieldModel'
import type { MoreAction, MoreInput } from './moreActions'
import type { ContactKind, Outcome } from './scoringContract'
import type { PresentationSequence } from './scoringPresentation'

export { POSITIONS } from '../../common/scoring/state'
export type {
  BatSide,
  Movement,
  Position,
  Side
} from '../../common/scoring/state'
export type { PlayerIdentityMap } from '../../common/scoring/state'

/**
 * The game the screen shows is the scoring library's: it changes only by the
 * library applying an action, never by anything the screen draws or times.
 */
export type ScoringSessionState = GameState
export type ScoringPlayer = GamePlayer
export type ScoringTeam = GameTeam
export type ScoringSide = GameSide
export type OverrideDraft = Override

export type ScoringPhase =
  | 'ready'
  | 'errorCredit'
  | 'awaitingBatter'
  | 'locateFielder'
  | 'locateLanding'
  | 'trajectory'
  | 'runnerMovement'
  | 'homeDecision'
  | 'resolveBatter'
  | 'chooseThrower'
  | 'chooseDefender'
  | 'runnerDecision'
  | 'runnerReason'
  | 'correctionWindow'
/**
 * The ball in play as the screen draws it: the outcome the scorer chose, where
 * the ball went, who fielded it and holds it now, and where the batter-runner
 * stands. Who went where, and what is still to be decided, is the game's.
 */
export interface PendingPlay {
  contactKind?: ContactKind
  homeRunKind?: HomeRunKind
  landingHeight?: number
  ballHolder?: number
  ballLocation?: GroundPoint
  batterPoint?: GroundPoint
  outcome:
    | Outcome
    | 'Walk'
    | 'Strikeout'
    | 'Balk'
    | 'Batter Out — Other'
    | 'Dropped Third Strike'
    | 'Manual placement'
  fielder?: number
  location?: GroundPoint
  angle?: number
  trajectoryAccepted: boolean
}
export interface MotionCommand {
  purpose?: 'approachFirst'
  id: string
  generation: number
  playerId: number
  waypoints: GroundPoint[]
  complete: boolean
}
export interface RunnerAction {
  defensiveRoute?: Array<{ id: number; point: GroundPoint }>
  purpose?: 'batterRetirement' | 'errorAttribution' | 'droppedThirdStrike'
  runnerPoint?: GroundPoint
  playerId: number
  from: number
  to: number
  origin: 'current' | 'between'
  returnPhase: ScoringPhase
  decision?: 'safe' | 'out'
  reason?: string
  thrower?: number
  throwerPoint?: GroundPoint
  defender?: number
  defenderPoint?: GroundPoint
}
export interface CorrectionWindow {
  remainingMs: number
  revision: number
}
export interface HomeRunCelebration {
  id: string
  generation: number
  kind: HomeRunKind
}
export interface ScoringSnapshot {
  celebration?: HomeRunCelebration | null
  presentationEnabled?: boolean
  presentation?: PresentationSequence | null

  moreDraft?: {
    action: MoreAction
    checkpoint: ScoringSnapshot
    historyLength: number
  }

  activeGesture?: boolean
  runnerDraft?: { checkpoint: ScoringSnapshot; historyLength: number }

  motions: MotionCommand[]
  runnerAction: RunnerAction | null
  correctionWindow: CorrectionWindow | null
  session: ScoringSessionState
  phase: ScoringPhase
  pendingPlay: PendingPlay | null
  /** Every action applied to the game, in order: what the session saves. */
  log: ScoringAction[]
  generation: number
  /** The server refused this game's changes: nothing more is scored. */
  readOnly?: boolean
}
export interface HistoryEntry {
  label: string
  snapshot: ScoringSnapshot
}
export interface ScoringState extends ScoringSnapshot {
  past: HistoryEntry[]
}
export type ScoringEvent =
  | { type: 'CELEBRATION_DONE'; id: string; generation: number }
  | {
      type: 'LANDING'
      point: GroundPoint
      generation: number
      landingHeight?: number
    }
  | { type: 'ERROR_CREDIT'; id: number; generation: number }
  | { type: 'ERROR_CANCEL' }
  | { type: 'PRESENTATION_CONTACT'; id: string; generation: number }
  | {
      type: 'PRESENTATION_DONE'
      id: string
      generation: number
      stage: PresentationSequence['stage']
    }
  | { type: 'MORE'; input: MoreInput }
  | { type: 'GESTURE'; active: boolean }
  | { type: 'MOTION_DONE'; id: string; generation: number }
  | {
      type: 'TIMER_TICK'
      elapsedMs: number
      generation: number
      revision: number
    }
  | { type: 'HOME'; decision: 'safe' | 'out' | 'back' }
  | {
      type: 'RUNNER_DROP'
      id: number
      to: number
      decision: 'safe' | 'out'
      generation: number
    }
  | { type: 'RUNNER_PROPOSE'; id: number; to: number }
  | { type: 'RUNNER_DECIDE'; decision: 'safe' | 'out' }
  | { type: 'RUNNER_REASON'; reason: string }
  | { type: 'CANCEL_RUNNER' }
  | { type: 'RUNNER_CANCEL' }
  | { type: 'THROWER'; id: number; point: GroundPoint; generation: number }
  | {
      type: 'DEFENDER'
      id?: number
      point?: GroundPoint
      runnerPoint?: GroundPoint
      generation: number
    }
  | { type: 'OUTCOME'; outcome: Outcome; contactKind?: ContactKind }
  | {
      type: 'FIELDER'
      id: number
      point: GroundPoint
      landingHeight?: number
      generation: number
    }
  | { type: 'TRAJECTORY'; angle: number; generation: number }
  | { type: 'ROSTER'; draft: ScoringSessionState; nextBatter?: number }
  | { type: 'OVERRIDE'; draft: OverrideDraft }
  | { type: 'PITCH'; kind: 'ball' | 'called' | 'swing' | 'foul' }
  | { type: 'UNDO' }
  | {
      type: 'CLOSE_PLAY'
      generation?: number
      revision?: number
      sequence?: number
    }
  | { type: 'END_HALF' }
  | { type: 'END_GAME' }
  | { type: 'PRESENTATION'; enabled: boolean }
  | {
      type: 'RESET'
      session: ScoringSessionState
      log: ScoringAction[]
      readOnly?: boolean
    }
  | { type: 'SWITCH_SIDE'; side: BatSide }
