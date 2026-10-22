import type { ScoringAction } from '../scoring/actions'
import { recordOf, replayPlays } from '../scoring/gumbo'
import type { SessionContext, StoredGame } from '../scoring/session'
import type { GameState } from '../scoring/state'

/**
 * A stored game as a replay plays it: the game before its first recorded
 * action, the steps from there, and the game after them. Everything comes
 * from `replayPlays`, so a replay rebuilds a game exactly as the scoring
 * screen and the server do: a play an undo reopened counts once, and an
 * action that no longer applies is never replayed.
 *
 * A step is one delivery — a pitch, or a ball put in play — and everything
 * the scorer took after it up to the next one: the result, the runners, the
 * close. The scorer's close of a play is stored as the first action of the
 * next play, so a play's leading closes belong to the step before them; the
 * step keeps its key and grows. Any other actions before a play's first
 * delivery, such as a substitution, are a step of their own.
 */

export type ReplayStepKind = 'pitch' | 'inPlay' | 'other'

export interface ReplayStep {
  /** `<atBatIndex>-<actionStart>`: the play and its first action's index. */
  key: string
  atBatIndex: number
  actionStart: number
  actions: ScoringAction[]
  kind: ReplayStepKind
}

export interface ReplayTimeline {
  start: GameState
  steps: ReplayStep[]
  end: GameState
  /** Plays read from their documents before the first recorded one. */
  derived: number
}

export type TimelineChange =
  | { kind: 'extend'; steps: ReplayStep[]; timeline: ReplayTimeline }
  | { kind: 'rewrite'; timeline: ReplayTimeline }

function isDelivery(action: ScoringAction): boolean {
  return action.type === 'pitch' || action.type === 'ballInPlay'
}

/**
 * One play's actions, cut into steps. A ball in play after the play's first
 * is the same ball, as the engine takes it: the scoring screen saves the
 * outcome's bare ball in play, then one with where it went, and the replay
 * shows the two as one step.
 */
export function stepsOf(
  atBatIndex: number,
  actions: readonly ScoringAction[]
): ReplayStep[] {
  const steps: ReplayStep[] = []
  let open: ReplayStep | null = null
  let hit = false
  actions.forEach((action, index) => {
    const again = hit && action.type === 'ballInPlay'
    if (action.type === 'ballInPlay') hit = true
    if (open == null || (isDelivery(action) && !again)) {
      open = {
        key: `${atBatIndex}-${index}`,
        atBatIndex,
        actionStart: index,
        actions: [],
        kind:
          action.type === 'pitch'
            ? 'pitch'
            : action.type === 'ballInPlay'
              ? 'inPlay'
              : 'other'
      }
      steps.push(open)
    }
    open.actions.push(action)
  })
  return steps
}

/**
 * Whether the scorer has said what a step's delivery did. The scoring screen
 * saves a ball in play twice: the outcome's bare ball, then the one with
 * where it went. Until the second, or anything after the ball, reaches a
 * viewer, the last step of a game being scored is a ball nobody has placed,
 * and the scorer's own screen has drawn nothing yet either.
 */
export function isDetermined(
  step: ReplayStep,
  timeline: ReplayTimeline
): boolean {
  if (step.kind !== 'inPlay') return true
  if (timeline.steps.at(-1)?.key !== step.key) return true
  const first = step.actions.findIndex(action => action.type === 'ballInPlay')
  return step.actions.some((action, index) =>
    action.type === 'ballInPlay'
      ? action.location != null ||
        action.fielder != null ||
        action.trajectory != null
      : index > first
  )
}

/** The scorer closing a play. */
export function isClose(action: ScoringAction): boolean {
  return action.type === 'gameFlow' && action.kind === 'closePlay'
}

export function replayTimelineOf(
  stored: StoredGame,
  context: SessionContext
): ReplayTimeline {
  const replayed = replayPlays(stored, context)
  const steps: ReplayStep[] = []
  for (const segment of replayed.segments) {
    let lead = 0
    const previous = steps.at(-1)
    if (previous != null)
      while (lead < segment.actions.length && isClose(segment.actions[lead]))
        previous.actions.push(segment.actions[lead++])
    for (const step of stepsOf(segment.atBatIndex, segment.actions.slice(lead)))
      steps.push({
        ...step,
        key: `${step.atBatIndex}-${step.actionStart + lead}`,
        actionStart: step.actionStart + lead
      })
  }
  return {
    start: replayed.base,
    steps,
    end: replayed.state,
    derived: replayed.derived
  }
}

/** Each timeline's actions as text, kept so the next change compares to it. */
const flats = new WeakMap<ReplayTimeline, string[]>()

function flat(timeline: ReplayTimeline): string[] {
  const known = flats.get(timeline)
  if (known != null) return known
  const actions = timeline.steps.flatMap(step =>
    step.actions.map(action => JSON.stringify(action))
  )
  flats.set(timeline, actions)
  return actions
}

/**
 * What a newer copy of the game adds to a timeline. When the new log starts
 * with the old one, the change is the steps that are new or have grown; a
 * grown step keeps its key and carries all its actions. Anything else — an
 * undo, a correction, plays replaced — rewrites the timeline.
 */
export function extendTimeline(
  previous: ReplayTimeline,
  stored: StoredGame,
  context: SessionContext
): TimelineChange {
  const timeline = replayTimelineOf(stored, context)
  const before = flat(previous)
  const after = flat(timeline)
  const grew =
    previous.derived === timeline.derived &&
    after.length >= before.length &&
    before.every((action, index) => after[index] === action)
  if (!grew) return { kind: 'rewrite', timeline }
  const counts = new Map(
    previous.steps.map(step => [step.key, step.actions.length])
  )
  return {
    kind: 'extend',
    steps: timeline.steps.filter(
      step => counts.get(step.key) !== step.actions.length
    ),
    timeline
  }
}

/** Whether any stored play, or the at-bat in progress, has a record. */
export function hasRecords(stored: StoredGame): boolean {
  return [...stored.plays, stored.currentPlay].some(
    play => recordOf(play) != null
  )
}

/**
 * The teams, lineups and fence a replay opens a game with: the app's twin of
 * the server's `contextOf`. Null when nothing TeamStation scored is stored.
 */
export function replayContextOf(
  game: {
    id: string
    awayTeamId: string
    homeTeamId: string
    awayTeamName: string
    homeTeamName: string
    awayLogoUrl?: string | null
    homeLogoUrl?: string | null
    fenceDistanceFt?: number
  },
  stored: StoredGame
): SessionContext | null {
  const first = [...stored.plays, stored.currentPlay]
    .map(recordOf)
    .find(record => record != null)
  if (first == null) return null
  return {
    gamePk: game.id,
    teams: {
      away: {
        id: game.awayTeamId,
        name: game.awayTeamName,
        logoUrl: game.awayLogoUrl ?? null
      },
      home: {
        id: game.homeTeamId,
        name: game.homeTeamName,
        logoUrl: game.homeLogoUrl ?? null
      }
    },
    setup: first.setupBefore,
    fenceDistanceFt: game.fenceDistanceFt
  }
}

/**
 * Whether a game offers a replay: something TeamStation scored is stored, the
 * game is over or being played, and the caller is a member who can see it.
 */
export function isReplayable(
  game: { status: string; nonMemberView: boolean },
  stored: boolean
): boolean {
  return (
    stored &&
    (game.status === 'final' || game.status === 'inProgress') &&
    !game.nonMemberView
  )
}
