import type { Problem, ScoringAction } from '../../common/scoring/actions'
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
  /**
   * A runner waiting for a later beat of a dictated sentence: drawn at his
   * first point, not moved, until his beat starts and replaces this.
   */
  held?: boolean
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
/** How long the scorekeeper has to move another runner before the play closes. */
export const CORRECTION_WINDOW_MS = 7000
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

  moreDraft?: ScoringDraft & { action: MoreAction }

  activeGesture?: boolean
  runnerDraft?: ScoringDraft

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
  /**
   * The last utterance dictated, and why it was refused when it was. Cleared
   * at each utterance and by Undo, so it never describes an older sentence.
   */
  dictation?: { transcript: string; problem?: Problem }
  /**
   * The beats of a dictated sentence still to play, first first. Present from
   * the moment the sentence is accepted until its last picture and motion end.
   */
  reel?: Beat[]
  /** Sentences that came back while a reel played, applied when it ends. */
  queuedDictation?: Array<{ transcript: string; actions: ScoringAction[] }>
  /**
   * What a dictated sentence left open that only the scorer can answer. The
   * sentence is not applied until it is answered.
   */
  dictationQuestion?: DictationQuestion
}
/**
 * A question the screen asks about a dictated sentence: one answer among
 * `options`, or any of the `pick` choices, each carrying the whole sentence
 * it comes to.
 */
export interface DictationQuestion {
  transcript: string
  question: string
  options?: Array<{ label: string; actions: ScoringAction[] }>
  pick?: {
    choices: Array<{ label: string; actions: ScoringAction[] }>
    /** The sentence the picked choices join. */
    before: ScoringAction[]
    /** What picking nobody comes to, after `before`. */
    none: ScoringAction[]
  }
}
/**
 * One step of a dictated sentence's animation: at most one picture — a pitch,
 * a hit or a throw — the runner motions that run with it, and whether it may
 * start as soon as the picture before it ends or only once nothing moves.
 */
export interface Beat {
  presentation?: PresentationSequence
  motions: MotionCommand[]
  after: 'presentation' | 'motions'
}
/**
 * The screen without the game: the step, what is drawn, the drafts. It is
 * what an Undo restores beside the game, which is rebuilt from the log.
 */
export type ScoringScreenState = Omit<ScoringSnapshot, 'session' | 'log'>

/**
 * Where a runner or More draft began: the Undo history's length, the log's
 * length, and the screen. Cancelling it goes back there.
 */
export interface ScoringDraft {
  historyLength: number
  logLength: number
  screen: ScoringScreenState
}

/**
 * One step Undo can take back: its label, how long the log was before it,
 * and the screen as it was. The game itself is not kept per step.
 */
export interface HistoryEntry {
  label: string
  logLength: number
  screen: ScoringScreenState
}

/**
 * The game as a plate appearance opened, and the log's length then. Only the
 * first checkpoint, every tenth and the newest two hold a copy of the game
 * (`session`); the others are null, and are rebuilt from the nearest earlier
 * copy by replaying the log.
 */
export interface GameCheckpoint {
  logLength: number
  /** Which plate appearance: the number of plays the game had finished. */
  appearance: number
  session: ScoringSessionState | null
}

export interface ScoringState extends ScoringSnapshot {
  past: HistoryEntry[]
  checkpoints: GameCheckpoint[]
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
  | {
      type: 'TRAJECTORY'
      angle: number
      generation: number
      /**
       * The scorer set this angle himself: a drag turned it, or he accepted
       * it off where the control started.
       */
      dragged?: boolean
    }
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
  /** The scorer's answer to `dictationQuestion`: an option, or the runners picked. */
  | { type: 'DICTATION_ANSWER'; option?: number; picks?: number[] }
  | { type: 'DICTATION_DISMISS' }
  /** One spoken sentence: applied whole as one undo step, or refused whole. */
  | {
      type: 'DICTATED'
      transcript: string
      actions: readonly ScoringAction[]
    }
