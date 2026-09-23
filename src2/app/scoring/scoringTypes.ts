import type { GroundPoint } from '../field/fieldModel'
import type { MoreAction, MoreInput } from './moreActions'
import type { PlayerIdentityMap } from './playerIdentity'
import type { Outcome, PlayerRef, ScoringPlay } from './scoringContract'
import type { OverrideDraft } from './scoringEdits'
import type { PresentationSequence } from './scoringPresentation'

export const POSITIONS = [
  'P',
  'C',
  '1B',
  '2B',
  'SS',
  '3B',
  'LF',
  'CF',
  'RF'
] as const
export type Position = (typeof POSITIONS)[number]
export type Side = 'away' | 'home'
export type BatSide = 'R' | 'L'
export interface ScoringPlayer {
  id: number
  sourceUserId: string | number | null
  teamId: string
  fullName: string
  jersey: string
  bats: 'left' | 'right' | 'switch'
  throws: 'left' | 'right' | null
  positions: string[]
  local: boolean
}
export interface ScoringTeam {
  id: string
  name: string
}
export interface ScoringSide {
  players: number[]
  battingOrder: number[]
  battingIndex: number
  defense: Record<Position, number | null>
  pitchCounts: Record<number, number>
}
export interface ScoringSessionState {
  gamePk: string
  gameData: {
    teams: Record<Side, ScoringTeam>
    players: Record<number, ScoringPlayer>
  }
  liveData: {
    linescore: {
      currentInning: number
      currentInningOrdinal: string
      inningState: 'Top' | 'Bottom'
      isTopInning: boolean
      balls: number
      strikes: number
      outs: number
      teams: Record<Side, { runs: number; hits: number; errors: number }>
      offense: {
        batter: PlayerRef | null
        first: PlayerRef | null
        second: PlayerRef | null
        third: PlayerRef | null
      }
      defense: Record<Position, PlayerRef | null>
    }
    boxscore: { teams: Record<Side, ScoringSide> }
    plays: { allPlays: ScoringPlay[]; currentPlay: ScoringPlay | null }
  }
  meta: {
    source: 'local-development' | 'api'
    sequence: number
    identities: PlayerIdentityMap
  }
}
export type ScoringPhase =
  | 'ready'
  | 'awaitingBatter'
  | 'locateFielder'
  | 'trajectory'
  | 'runnerMovement'
  | 'homeDecision'
  | 'resolveBatter'
  | 'chooseThrower'
  | 'chooseDefender'
  | 'runnerDecision'
  | 'runnerReason'
  | 'correctionWindow'
export interface Movement {
  playerId: number
  from: number
  to: number
  force: boolean
  decision: 'pending' | 'safe' | 'out'
  resolved?: boolean
}
export interface PendingPlay {
  choiceApplied?: boolean
  originalRunnerRecordCount?: number
  outcome:
    | Outcome
    | 'Walk'
    | 'Strikeout'
    | 'Balk'
    | 'Batter Out — Other'
    | 'Dropped Third Strike'
    | 'Manual placement'
  sameAppearance?: boolean
  originalBases: Array<number | null>
  originalRuns: number
  originalOuts: number
  movements: Movement[]
  fielder?: number
  location?: GroundPoint
  angle?: number
  trajectoryAccepted: boolean
}
export interface MotionCommand {
  id: string
  generation: number
  playerId: number
  waypoints: GroundPoint[]
  complete: boolean
}
export interface RunnerAction {
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
export interface ScoringSnapshot {
  presentationEnabled?: boolean
  presentation?: PresentationSequence | null

  recentPitch?: { atBatIndex: number; index: number } | null
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
  homeQueue: number[]
  awaitingBatter: {
    teamId: string
    dueIndex: number
    duePlayerId: number
  } | null
  generation: number
}
export interface HistoryEntry {
  label: string
  snapshot: ScoringSnapshot
}
export interface ScoringState extends ScoringSnapshot {
  past: HistoryEntry[]
}
export type ScoringEvent =
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
  | { type: 'DEFENDER'; id?: number; point?: GroundPoint; generation: number }
  | { type: 'OUTCOME'; outcome: Outcome }
  | { type: 'FIELDER'; id: number; point: GroundPoint; generation: number }
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
  | { type: 'SWITCH_SIDE'; side: BatSide }
