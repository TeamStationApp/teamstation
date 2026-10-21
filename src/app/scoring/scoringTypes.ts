import type { Problem, ScoringAction } from '../../common/scoring/actions'
import type { StagedRunner } from '../../common/scoring/rosterCommands'
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
  | 'fieldersChoice'
  | 'chooseThrower'
  | 'chooseDefender'
  | 'runnerDecision'
  | 'runnerReason'
  | 'runnerError'
  | 'runnerErrorReuse'
  | 'runnerPitch'
  | 'runnerPitchType'
  | 'correctionWindow'
/**
 * The ball in play as the screen draws it: the outcome the scorer chose, where
 * the ball went, who fielded it and holds it now, and where the batter-runner
 * stands. Who went where, and what is still to be decided, is the game's.
 */
export interface PendingPlay {
  fieldersChoice?: {
    route: Array<{ id: number; point: GroundPoint }>
    runners: Array<{
      playerId: number
      from: number
      to: number
      decision?: 'safe' | 'out'
      putout?: number
    }>
    calls: number[]
    choosingPutout?: number
  }
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
  purpose?:
    | 'batterRetirement'
    | 'errorAttribution'
    | 'droppedThirdStrike'
    | 'fieldersChoice'
  runnerPoint?: GroundPoint
  playerId: number
  from: number
  to: number
  origin: 'current' | 'between'
  returnPhase: ScoringPhase
  decision?: 'safe' | 'out'
  reason?: string
  error?: number
  errorEvent?: number
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
  /**
   * A replay watching the game rather than a scorer scoring it: nothing is
   * prompted and nothing is applied but the stored actions it is given.
   */
  watching?: boolean
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
  queuedDictation?: Array<{
    transcript: string
    actions: ScoringAction[]
    acceptedLineup?: string | null
  }>
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
  acceptedLineup?: string | null
  question: string
  options?: Array<{ label: string; actions: ScoringAction[] }>
  pick?: {
    choices: Array<{ label: string; actions: ScoringAction[] }>
    /** The sentence the picked choices join. */
    before: ScoringAction[]
    /** What picking nobody comes to, after `before`. */
    none: ScoringAction[]
    /** The rest of the sentence, after the picks. */
    after?: ScoringAction[]
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
  /**
   * A batter this beat's hit runs out toward first, and where it leaves him:
   * when the beat starts he is there, and his motions that would leave from
   * the plate leave from there. He waits there, `held`, only while a later
   * beat of the reel goes on with him.
   */
  runFrom?: { playerId: number; point: GroundPoint; held: boolean }
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
  | { type: 'CHOICE_CANCEL'; generation: number }
  | { type: 'RUNNER_PROPOSE'; id: number; to: number }
  | { type: 'RUNNER_DECIDE'; decision: 'safe' | 'out' }
  | {
      type: 'CHOICE_DECIDE'
      id: number
      decision: 'safe' | 'out'
      putout?: number
      generation: number
    }
  | { type: 'RUNNER_REASON'; reason: string }
  | { type: 'RUNNER_ERROR'; id: number; generation: number }
  | { type: 'RUNNER_ERROR_REUSE'; reuse: boolean }
  | { type: 'RUNNER_PITCH'; addBall: boolean }
  | { type: 'RUNNER_PITCH_NEW' }
  | { type: 'RUNNER_PITCH_KIND'; kind: 'ball' | 'called' | 'swing' }
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
  | {
      type: 'ROSTER'
      draft: ScoringSessionState
      nextBatter?: number
      /** Pinch runners who keep the batting order, put on after the setup. */
      runners?: readonly StagedRunner[]
    }
  | { type: 'OVERRIDE'; draft: OverrideDraft }
  | { type: 'TIEBREAKER_OUTS'; outs: number }
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
  | {
      type: 'DICTATION_ANSWER'
      option?: number
      picks?: number[]
      acceptedLineup?: string | null
    }
  | { type: 'DICTATION_DISMISS' }
  /**
   * A replay's step: stored actions applied exactly as saved and drawn as a
   * dictated sentence is, with nothing rewritten, asked or refused for setup.
   */
  | { type: 'REPLAYED'; actions: readonly ScoringAction[] }
  /** One undo step: the sentence, or its valid prefix at a setup boundary. */
  | {
      type: 'DICTATED'
      transcript: string
      actions: readonly ScoringAction[]
      /** Exact accepted order; null enforces that no partial order was accepted. */
      acceptedLineup?: string | null
    }
