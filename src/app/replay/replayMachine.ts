import { narrateTimeline, type Narration } from '../../common/replay/narration'
import {
  rewindLabel,
  rewindTarget,
  stateBefore
} from '../../common/replay/replayRewind'
import type {
  ReplayStep,
  ReplayStepKind,
  ReplayTimeline,
  TimelineChange
} from '../../common/replay/replayTimeline'
import type { ScoringAction } from '../../common/scoring/actions'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import type { ScoringEvent, ScoringState } from '../scoring/scoringTypes'

/**
 * The replay's reducer. It drives the scoring screen's own reducer with each
 * step's stored actions, so the pitches, the ball in flight, the runners and
 * the home-run lights are drawn by the same code that draws them for the
 * scorer, and it decides when the next step starts: about four and a half
 * seconds a pitch, longer for a ball in play and between halves, never
 * while the field is still moving, the announcer still speaking or the
 * viewer has paused. Nothing it does is saved: only the scoring screen saves.
 */

/** Each step's slot, from its start to the next step's. */
export const SLOT_MS: Record<ReplayStepKind, number> = {
  pitch: 4500,
  inPlay: 5000,
  other: 2000
}
/**
 * A live view's slots: long enough to read the card once the animation is
 * done, short enough to stay within a moment of a quick scorer.
 */
export const LIVE_SLOT_MS: Record<ReplayStepKind, number> = {
  pitch: 1500,
  inPlay: 2500,
  other: 1000
}
/** A live view's pause between halves. */
export const LIVE_HALF_MS = 2000
/** After a ball in play has settled, before the next step. */
export const IN_PLAY_TAIL_MS = 1500
/** Added to the slot of the step that ends a half. */
export const HALF_MS = 6000
/** A step's slot while a live view catches up. */
export const CATCH_UP_MS = 600
/** More steps queued than this, and a live view catches up. */
export const CATCH_UP_QUEUE = 3
/** How long the scoreboard's home-run lights run (as on the scoring screen). */
export const CELEBRATION_MS = 6000
/** How long a rewind's words hold on the card before they fade. */
export const REWIND_NOTICE_HOLD_MS = 1400
/** How long they take to fade. */
export const REWIND_NOTICE_FADE_MS = 600
/** A rewind's words, held and faded; the first step after it waits as long. */
export const REWIND_NOTICE_MS = REWIND_NOTICE_HOLD_MS + REWIND_NOTICE_FADE_MS

export type ReplayMode = 'replay' | 'live'

export interface QueuedStep {
  step: ReplayStep
  /** The step's actions not yet played: all of them, or what it grew by. */
  actions: ScoringAction[]
}

export interface ReplayState {
  mode: ReplayMode
  scoring: ScoringState
  timeline: ReplayTimeline
  narrations: Map<string, Narration>
  queue: QueuedStep[]
  /** How many of each step's actions have been played. */
  applied: Record<string, number>
  /** The step last played, whose sentence the card shows. */
  shown: ReplayStep | null
  /** How many of the shown step's actions its sentence was written for. */
  shownCount: number
  /** The scorer changed a play this view had shown. */
  changed: boolean
  paused: boolean
  /** The announcer is reading the shown step. */
  speaking: boolean
  /** When the shown step's slot ends, on the replay's clock. */
  slotEndsAt: number | null
  /** The slot left when the viewer paused. */
  pausedSlot: number | null
  /** When the field last came to rest. */
  idleSince: number | null
  celebrationEndsAt: number | null
  pausedCelebration: number | null
  /** The game is over and everything has been shown. */
  final: boolean
  /**
   * The game is over: its plays end it, or the server has marked it final.
   * Once its queue is empty the view ends.
   */
  gameOver: boolean
  /** A live view behind the scorer, hurrying until it has nearly caught up. */
  hurrying: boolean
  /**
   * The view was opened live. Rewound, it watches at replay pace until it
   * has caught up, then follows the scorer again.
   */
  follows: boolean
  /** How many rewinds the view has taken: each one's id, never repeated. */
  rewinds: number
  /** Where the last rewind went, written on the card until `endsAt`. */
  notice: { id: number; text: string; endsAt: number } | null
}

export type ReplayEvent =
  | { type: 'TICK'; now: number }
  | { type: 'FIELD'; event: ScoringEvent }
  | { type: 'PAUSE'; now: number }
  | { type: 'PLAY'; now: number }
  | { type: 'SPEAKING'; speaking: boolean }
  | { type: 'CHANGED'; change: TimelineChange }
  | { type: 'GAME_OVER' }
  | {
      type: 'REWIND'
      now: number
      /** "Rewind to top of %s", "Rewind to bottom of %s". */
      words: { top: string; bottom: string }
    }

/** Nothing drawn and nothing moving: the next step may start. */
export function replayIdle(state: ScoringState): boolean {
  return (
    (state.reel == null || state.reel.length === 0) &&
    state.presentation == null &&
    state.motions.every(motion => motion.complete)
  )
}

/** The scoring state with the history a replay never undoes into dropped. */
function trimmed(state: ScoringState): ScoringState {
  return state.past.length === 0 &&
    state.checkpoints.length === 0 &&
    state.log.length === 0
    ? state
    : { ...state, past: [], checkpoints: [], log: [] }
}

function counts(timeline: ReplayTimeline): Record<string, number> {
  return Object.fromEntries(
    timeline.steps.map(step => [step.key, step.actions.length])
  )
}

/** A live view of the game as it stands, with nothing left to play. */
function liveAt(timeline: ReplayTimeline, changed: boolean): ReplayState {
  const shown = timeline.steps.at(-1) ?? null
  return {
    mode: 'live',
    scoring: trimmed(
      initialScoringState(timeline.end, true, { watching: true })
    ),
    timeline,
    narrations: narrateTimeline(timeline),
    queue: [],
    applied: counts(timeline),
    shown,
    shownCount: shown?.actions.length ?? 0,
    changed,
    paused: false,
    speaking: false,
    slotEndsAt: null,
    pausedSlot: null,
    idleSince: null,
    celebrationEndsAt: null,
    pausedCelebration: null,
    final: timeline.end.final,
    gameOver: timeline.end.final,
    hurrying: false,
    follows: true,
    rewinds: 0,
    notice: null
  }
}

/**
 * The view snapped to a corrected game: it starts again from where the game
 * now stands, still paused if the viewer paused it, and still over if the
 * server said so.
 */
function snapped(state: ReplayState, timeline: ReplayTimeline): ReplayState {
  const next = liveAt(timeline, true)
  return {
    ...next,
    paused: state.paused,
    gameOver: next.gameOver || state.gameOver,
    rewinds: state.rewinds
  }
}

/**
 * A view of the game from its first pitch, or from where a live game stands.
 * `over` is the server's word that the game is final, which a game whose
 * plays record no end still is.
 */
export function startReplay(
  mode: ReplayMode,
  timeline: ReplayTimeline,
  over = false
): ReplayState {
  if (mode === 'live') return liveAt(timeline, false)
  return {
    mode,
    scoring: trimmed(
      initialScoringState(timeline.start, true, { watching: true })
    ),
    timeline,
    narrations: narrateTimeline(timeline),
    queue: timeline.steps.map(step => ({ step, actions: step.actions })),
    applied: {},
    shown: null,
    shownCount: 0,
    changed: false,
    paused: false,
    speaking: false,
    slotEndsAt: null,
    pausedSlot: null,
    idleSince: null,
    celebrationEndsAt: null,
    pausedCelebration: null,
    final: false,
    gameOver: timeline.end.final || over,
    hurrying: false,
    follows: false,
    rewinds: 0,
    notice: null
  }
}

function halfOf(state: ScoringState): string {
  const line = state.session.liveData.linescore
  return `${line.currentInning}${line.isTopInning ? 't' : 'b'}`
}

/** Plays the next queued step. */
function playNext(state: ReplayState, now: number): ReplayState {
  const [next, ...rest] = state.queue
  const catchUp = catchingUp(state)
  const before = {
    ...state.scoring,
    presentationEnabled: !(catchUp && next.step.kind === 'pitch')
  }
  const after = scoringReducer(before, {
    type: 'REPLAYED',
    actions: next.actions
  })
  const live = state.mode === 'live'
  if (after.session === before.session && next.actions.length > 0)
    // The game would not take the step. Followed live, even rewound, it has
    // changed under this view; a finished game goes to how it ended.
    return live || state.follows
      ? snapped(state, state.timeline)
      : {
          ...liveAt(state.timeline, false),
          mode: 'replay',
          paused: state.paused,
          gameOver: state.gameOver,
          follows: false,
          rewinds: state.rewinds
        }
  const slot = catchUp
    ? CATCH_UP_MS
    : (live ? LIVE_SLOT_MS : SLOT_MS)[next.step.kind]
  const endedHalf = halfOf(state.scoring) !== halfOf(after)
  const half = endedHalf && !catchUp ? (live ? LIVE_HALF_MS : HALF_MS) : 0
  const applied = {
    ...state.applied,
    [next.step.key]: (state.applied[next.step.key] ?? 0) + next.actions.length
  }
  return {
    ...state,
    // A rewound live view that has caught up follows the scorer again.
    mode: state.follows && rest.length === 0 ? 'live' : state.mode,
    notice: null,
    scoring: trimmed({ ...after, presentationEnabled: true }),
    queue: rest,
    applied,
    shown: next.step,
    shownCount: applied[next.step.key],
    hurrying: catchUp,
    changed: false,
    slotEndsAt: now + slot + half,
    idleSince: null
  }
}

/**
 * A live replay so far behind the scorer that it hurries to catch up: from
 * more than CATCH_UP_QUEUE steps queued until one is left.
 */
export function catchingUp(state: ReplayState): boolean {
  return (
    state.mode === 'live' &&
    (state.queue.length > CATCH_UP_QUEUE ||
      (state.hurrying && state.queue.length > 1))
  )
}

function tick(state: ReplayState, now: number): ReplayState {
  let next = state
  // A rewind's words go when their time is up, paused or not.
  if (next.notice != null && now >= next.notice.endsAt)
    next = { ...next, notice: null }
  const celebration = next.scoring.celebration
  if (celebration == null) {
    if (next.celebrationEndsAt != null)
      next = { ...next, celebrationEndsAt: null }
  } else if (!next.paused) {
    if (next.celebrationEndsAt == null)
      next = { ...next, celebrationEndsAt: now + CELEBRATION_MS }
    else if (now >= next.celebrationEndsAt)
      next = {
        ...next,
        celebrationEndsAt: null,
        scoring: scoringReducer(next.scoring, {
          type: 'CELEBRATION_DONE',
          id: celebration.id,
          generation: celebration.generation
        })
      }
  }
  const idle = replayIdle(next.scoring)
  if (!idle) {
    if (next.idleSince != null) next = { ...next, idleSince: null }
    return next
  }
  if (next.idleSince == null) next = { ...next, idleSince: now }
  if (next.paused) return next
  // A live view behind the scorer does not wait for the announcer: the
  // screen reads nothing it shows while hurrying.
  if (next.speaking && !catchingUp(next)) return next
  // A replay opens on "Play ball!" for a moment before the first pitch.
  if (next.shown == null && next.slotEndsAt == null && next.mode === 'replay')
    return { ...next, slotEndsAt: now + SLOT_MS.other }
  if (next.queue.length === 0)
    return next.gameOver && !next.final ? { ...next, final: true } : next
  // A home run's lights run their full time before the next pitch, unless a
  // live replay has fallen behind the scorer.
  if (next.scoring.celebration != null && !catchingUp(next)) return next
  const settled =
    next.shown?.kind !== 'inPlay' ||
    now >= (next.idleSince ?? now) + IN_PLAY_TAIL_MS
  if (!settled || (next.slotEndsAt != null && now < next.slotEndsAt))
    return next
  return playNext(next, now)
}

/** A newer copy of the game: new and grown steps queued, or a fresh start. */
function changed(state: ReplayState, change: TimelineChange): ReplayState {
  if (change.kind === 'rewrite') return snapped(state, change.timeline)
  const queue = [...state.queue]
  for (const step of change.steps) {
    const played = state.applied[step.key] ?? 0
    const queued = queue.findIndex(entry => entry.step.key === step.key)
    const left = step.actions.slice(played)
    if (queued >= 0) queue[queued] = { step, actions: left }
    else if (left.length > 0) queue.push({ step, actions: left })
  }
  return {
    ...state,
    timeline: change.timeline,
    narrations: narrateTimeline(change.timeline, state),
    queue,
    // A read that brings nothing new leaves a finished game finished.
    final: state.final && queue.length === 0,
    // Plays that end the game end the view, whether or not the server's
    // word that the game is final reaches it.
    gameOver: state.gameOver || change.timeline.end.final
  }
}

/**
 * Back to the start of a half inning (`rewindTarget`): the game as it stood
 * there, every step from there queued again, and the card saying where the
 * view went. A paused view stays paused; a finished one plays again; a live
 * one watches the rewound steps at replay pace.
 */
function rewound(
  state: ReplayState,
  now: number,
  words: { top: string; bottom: string }
): ReplayState {
  const { timeline } = state
  const shown = state.shown
  // By key: every newer copy of the game makes new step objects.
  const shownIndex =
    shown == null
      ? -1
      : timeline.steps.findIndex(step => step.key === shown.key)
  const target = rewindTarget(timeline, shownIndex)
  if (target == null) return state
  const fresh = initialScoringState(stateBefore(timeline, target.index), true, {
    watching: true
  })
  const applied: Record<string, number> = {}
  for (const step of timeline.steps.slice(0, target.index))
    applied[step.key] = step.actions.length
  const before = target.index > 0 ? timeline.steps[target.index - 1] : null
  const rewinds = state.rewinds + 1
  return {
    ...state,
    mode: 'replay',
    // Field callbacks for what was on screen carry an older generation.
    scoring: trimmed({
      ...fresh,
      generation: state.scoring.generation + 1
    }),
    queue: timeline.steps
      .slice(target.index)
      .map(step => ({ step, actions: step.actions })),
    applied,
    shown: before,
    shownCount: before?.actions.length ?? 0,
    changed: false,
    speaking: false,
    slotEndsAt: state.paused ? null : now + REWIND_NOTICE_MS,
    pausedSlot: state.paused ? REWIND_NOTICE_MS : null,
    // Nothing is drawn or moving on the field it stands up.
    idleSince: now,
    celebrationEndsAt: null,
    pausedCelebration: null,
    final: false,
    hurrying: false,
    rewinds,
    notice: {
      id: rewinds,
      text: rewindLabel(target.half, words),
      endsAt: now + REWIND_NOTICE_MS
    }
  }
}

/**
 * How much of a rewind's words still shows at `now`: all of it while they
 * hold, then less and less until they clear.
 */
export function noticeOpacity(
  notice: { endsAt: number } | null,
  now: number
): number {
  if (notice == null) return 1
  const left = notice.endsAt - now
  return Math.max(0, Math.min(1, left / REWIND_NOTICE_FADE_MS))
}

export function replayReducer(
  state: ReplayState,
  event: ReplayEvent
): ReplayState {
  switch (event.type) {
    case 'TICK':
      return tick(state, event.now)
    case 'FIELD':
      return {
        ...state,
        scoring: trimmed(scoringReducer(state.scoring, event.event))
      }
    case 'PAUSE':
      if (state.paused || state.final) return state
      return {
        ...state,
        paused: true,
        pausedSlot:
          state.slotEndsAt == null
            ? null
            : Math.max(0, state.slotEndsAt - event.now),
        pausedCelebration:
          state.celebrationEndsAt == null
            ? null
            : Math.max(0, state.celebrationEndsAt - event.now)
      }
    case 'PLAY':
      if (!state.paused) return state
      return {
        ...state,
        paused: false,
        slotEndsAt:
          state.pausedSlot == null ? null : event.now + state.pausedSlot,
        pausedSlot: null,
        celebrationEndsAt:
          state.pausedCelebration == null
            ? null
            : event.now + state.pausedCelebration,
        pausedCelebration: null
      }
    case 'SPEAKING':
      return state.speaking === event.speaking
        ? state
        : { ...state, speaking: event.speaking }
    case 'CHANGED':
      return changed(state, event.change)
    case 'GAME_OVER':
      return state.gameOver ? state : { ...state, gameOver: true }
    case 'REWIND':
      return rewound(state, event.now, event.words)
  }
}

/**
 * The sentence for a step, or for a step with nothing to say (the end of a
 * game its last out already called), the last one that said something.
 */
function lastSaid(state: ReplayState, key: string): string {
  const steps = state.timeline.steps
  for (let i = steps.findIndex(step => step.key === key); i >= 0; i--) {
    const text = state.narrations.get(steps[i].key)?.text ?? ''
    if (text !== '') return text
  }
  return ''
}

/** What the card writes: the step's sentence and where the game stands. */
export function replayCard(
  state: ReplayState,
  words: {
    playBall: string
    waiting: string
    paused: string
    changed: string
  }
): { line: string; detail: string } {
  const detail = state.paused ? words.paused : situationOf(state)
  // A rewind's words stand alone until they fade.
  if (state.notice != null) return { line: state.notice.text, detail }
  const line =
    state.shown == null
      ? state.mode === 'replay'
        ? words.playBall
        : words.waiting
      : lastSaid(state, state.shown.key)
  return {
    line: state.changed ? `${words.changed}. ${line}` : line,
    detail
  }
}

/** Where the game stands: the count, the outs and who is on. */
function situationOf(state: ReplayState): string {
  const linescore = state.scoring.session.liveData.linescore
  const offense = linescore.offense
  const runners = [
    offense.first == null ? null : '1st',
    offense.second == null ? null : '2nd',
    offense.third == null ? null : '3rd'
  ].filter((base): base is string => base != null)
  return state.scoring.session.final
    ? ''
    : [
        // A play decided but not yet closed by the scorer (strike three,
        // ball four) is a new count already, not 1–3 or 4–1.
        state.scoring.session.pending == null
          ? `${linescore.balls}–${linescore.strikes}`
          : '0–0',
        `${linescore.outs} out${linescore.outs === 1 ? '' : 's'}`,
        runners.length === 0
          ? null
          : `${runners.length === 1 ? 'runner on' : 'runners on'} ${runners.join(' and ')}`
      ]
        .filter((part): part is string => part != null)
        .join(' · ')
}
