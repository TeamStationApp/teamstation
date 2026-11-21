import type { BuildEvent } from '../../common/schedulePreviews'
import type { EngineLimit } from '../../common/scheduler/wire'

/**
 * The lines the schedule build modal shows, from a build's events, as a
 * terminal shows them: each step's line appears as it starts, its time
 * counting up while it runs, and becomes its finished line, with how long it
 * took, where it is; the solver's better schedules and each time limit add
 * lines of their own below. The build's clock stops while it waits at a time
 * limit.
 */

/**
 * The full log's heading, for tests and timing logs reading it: the modal
 * writes it, and the e2e rigs, which can't load React Native, find the log
 * by it, so both take it from here.
 */
export const FULL_LOG = 'Build log'

/**
 * Between the full log's lines on a phone, where they are a test id: a line
 * separator, which no driver's XML turns into a space as it can a newline.
 */
export const FULL_LOG_BREAK = '\u2028'

/** One line of the log, timed from the build's start. */
export interface LogLine {
  atMs: number
  text: string
  /**
   * A step still running: which (`targets`, `cause S5`). Its time is the
   * build's clock, ticking, until the step ends and the line is replaced.
   */
  step?: string
  /**
   * A step's line stopped before its end was heard, by the next step's start
   * or the build's end: which step, so that a late end still finishes it in
   * place.
   */
  stopped?: string
  /**
   * When a step started, on the build's clock, while its line is in its
   * running wording: running, or stopped by the next step's start. The
   * build's end turns such a line into its stopped wording, with how long it
   * ran.
   */
  fromMs?: number
}

type PhaseName = Extract<BuildEvent, { kind: 'phase' }>['phase']

/** What a step says while it runs. */
const RUNNING: Record<PhaseName, string> = {
  preparing: 'Preparing…',
  context: 'Reading fields and dates…',
  model: 'Building the model…',
  targets: 'Finding a schedule…',
  placement: 'Placing games…',
  cause: 'Explaining the shortfall…',
  polish: 'Polishing options…',
  options: 'Choosing options…',
  upload: 'Saving…'
}

const PHASES: Record<PhaseName, string> = {
  preparing: 'Prepared',
  context: 'Fields and dates read',
  model: 'Model',
  targets: 'Games per team settled',
  placement: 'Games placed',
  cause: 'Shortfall explained',
  polish: 'Options polished',
  options: 'Options chosen',
  upload: 'Saved'
}

const count = (n: number): string => n.toLocaleString('en-US')

/** `0:03`, `2:00`, `12:05`: minutes and seconds. */
export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * What the modal says at a time limit, timed by the solve so far (not the
 * time spent waiting for an answer).
 */
export function limitText(limit: Omit<EngineLimit, 'kind' | 'stage'>): string {
  const after = `After ${clockText(limit.solvedMs)} the solver`
  return limit.bestGames == null
    ? `${after} hasn’t found a schedule yet; at most ${count(limit.boundGames)} games possible.`
    : `${after} hasn’t proven this is the best schedule. Best found: ${count(limit.bestGames)} games; at most ${count(limit.boundGames)} possible.`
}

/** What an event says, without its time; a step's start, its running wording. */
export function eventText(event: BuildEvent): string {
  if (event.kind === 'phase-start') return runningText(event)
  if (event.kind === 'progress')
    return `Found a schedule with ${count(event.incumbentGames)} games — at most ${count(event.boundGames)} possible (${(event.gap * 100).toFixed(1)}%)`
  if (event.kind === 'limit')
    return event.bestGames == null
      ? `Time limit reached: no schedule yet; at most ${count(event.boundGames)} games possible`
      : `Time limit reached: best ${count(event.bestGames)} games; at most ${count(event.boundGames)} possible`
  const label = PHASES[event.phase]
  const took = `${(event.ms / 1000).toFixed(1)} s`
  if (event.phase === 'model' && event.detail?.columns != null)
    return `${label}: ${count(event.detail.columns)} possible games, ${count(event.detail.rows ?? 0)} rules (${took})`
  if (event.phase === 'cause' && event.detail?.seasonName != null)
    return `${label}: ${event.detail.seasonName} (${took})`
  return `${label} (${took})`
}

/**
 * A step's line once the build ended before its end was heard:
 * `Finding a schedule — stopped (12.0 s)`, with how long it ran.
 */
export function stoppedText(running: string, ms: number): string {
  return `${running.replace(/…$/, '')} — stopped (${(Math.max(0, ms) / 1000).toFixed(1)} s)`
}

/** A log line: `0:03  Model: 23,776 possible games, 10,685 rules (1.2 s)`. */
export function lineText(line: LogLine): string {
  return `${clockText(line.atMs)}  ${line.text}`
}

type StepEvent = Extract<BuildEvent, { kind: 'phase' | 'phase-start' }>

/** The season a cause's event names. */
function seasonOf(event: StepEvent): string | undefined {
  return 'detail' in event ? event.detail?.seasonName : undefined
}

/** Which step an event is of: its phase, and a cause's season. */
function stepOf(event: StepEvent): string {
  const season = seasonOf(event)
  return season == null ? event.phase : `${event.phase} ${season}`
}

/** What a step says while it runs: `Explaining S5’s shortfall…`. */
export function runningText(event: StepEvent): string {
  const season = seasonOf(event)
  return event.phase === 'cause' && season != null
    ? `Explaining ${season}’s shortfall…`
    : RUNNING[event.phase]
}

/** A build's log: the box's lines, every line as logged, and its clock. */
export interface BuildLog {
  /** The box's lines, top to bottom; a running step's is replaced when it ends. */
  lines: readonly LogLine[]
  /**
   * Every line as it was logged, in order: each step's start (its running
   * wording) and its end, each better schedule and each limit, for tests and
   * timing logs.
   */
  transcript: readonly LogLine[]
  /** When the build started, in `Date.now()` milliseconds. */
  startedAt: number
  /** The time spent waiting at earlier time limits. */
  pausedMs: number
  /** When the current wait at a time limit began; null while it runs. */
  pausedAt: number | null
}

/** What happens to a build's log, each at a `Date.now()` time. */
export type BuildLogAction =
  | { type: 'event'; event: BuildEvent; at: number }
  /** A line of the modal's own, such as the choice to use the first schedule. */
  | { type: 'note'; text: string; at: number }
  /** A second passes: each running step's line shows the clock. */
  | { type: 'tick'; at: number }
  /** The build waits at a time limit: the clock stops. */
  | { type: 'pause'; at: number }
  /** The admin answered the limit: the clock goes on. */
  | { type: 'resume'; at: number }
  /**
   * The build failed, or this device has no solver: no line runs on, and a
   * step whose end was never heard says it stopped, and after how long.
   */
  | { type: 'stop'; at: number }

/** A build's log as it opens, at `at`. */
export function startLog(at: number): BuildLog {
  return {
    lines: [],
    transcript: [],
    startedAt: at,
    pausedMs: 0,
    pausedAt: null
  }
}

/** The build's clock at `at`: from its start, less its waits at time limits. */
export function logClock(log: BuildLog, at: number): number {
  return Math.max(0, (log.pausedAt ?? at) - log.startedAt - log.pausedMs)
}

/** Whether a step's line is running, and so its clock should tick. */
export function ticking(log: BuildLog): boolean {
  return log.pausedAt == null && log.lines.some(line => line.step != null)
}

/**
 * The running steps' lines with their clock at `atMs` (a running line's
 * clock only goes forward, whatever time it is given); `stop` also stops
 * them, each keeping which step it was and when it started.
 */
function advanced(
  lines: readonly LogLine[],
  atMs: number,
  stop: boolean
): LogLine[] {
  return lines.map(line => {
    if (line.step == null) return line
    const at = Math.max(line.atMs, atMs)
    return stop
      ? { atMs: at, text: line.text, stopped: line.step, fromMs: line.fromMs }
      : { ...line, atMs: at }
  })
}

/** Whether a line is a step's, in its running wording, its end not heard. */
const unended = (line: LogLine): boolean =>
  line.step != null || (line.stopped != null && line.fromMs != null)

/** The log after `action`: a pure step, so the modal's log can be tested alone. */
export function logReducer(log: BuildLog, action: BuildLogAction): BuildLog {
  const atMs = logClock(log, action.at)
  const added = (
    line: LogLine,
    lines: readonly LogLine[] = log.lines
  ): BuildLog => ({
    ...log,
    lines: [...lines, line],
    transcript: [...log.transcript, { atMs: line.atMs, text: line.text }]
  })
  switch (action.type) {
    case 'tick':
      if (
        !ticking(log) ||
        !log.lines.some(line => line.step != null && line.atMs < atMs)
      )
        return log
      return { ...log, lines: advanced(log.lines, atMs, false) }
    case 'pause':
      if (log.pausedAt != null) return log
      return {
        ...log,
        pausedAt: action.at,
        lines: advanced(log.lines, atMs, false)
      }
    case 'resume':
      if (log.pausedAt == null) return log
      return {
        ...log,
        pausedMs: log.pausedMs + Math.max(0, action.at - log.pausedAt),
        pausedAt: null
      }
    case 'stop': {
      if (!log.lines.some(unended)) return log
      // Each line whose end was never heard says it stopped, in the box and
      // in the full log, keeping which step it was for a late end.
      const ended: LogLine[] = []
      const lines = advanced(log.lines, atMs, true).map((line, i) => {
        if (!unended(log.lines[i])) return line
        const stopped: LogLine = {
          atMs: line.atMs,
          text: stoppedText(line.text, line.atMs - (line.fromMs ?? line.atMs)),
          stopped: line.stopped
        }
        ended.push(stopped)
        return stopped
      })
      return {
        ...log,
        lines,
        transcript: [
          ...log.transcript,
          ...ended.map(line => ({ atMs: line.atMs, text: line.text }))
        ]
      }
    }
    case 'note':
      return added({ atMs, text: action.text })
    case 'event':
      break
  }
  const { event } = action
  if (event.kind === 'phase-start')
    // Steps run one at a time: one that never said it ended stops here.
    return added(
      { atMs, text: runningText(event), step: stepOf(event), fromMs: atMs },
      advanced(log.lines, atMs, true)
    )
  const line = { atMs, text: eventText(event) }
  if (event.kind === 'limit') {
    const paused = logReducer(log, { type: 'pause', at: action.at })
    return { ...added(line, paused.lines), pausedAt: paused.pausedAt }
  }
  if (event.kind === 'phase') {
    const step = stepOf(event)
    // The step's latest line, running or stopped.
    const at = log.lines.findLastIndex(
      shown => shown.step === step || shown.stopped === step
    )
    if (at >= 0)
      return {
        ...log,
        lines: log.lines.map((shown, i) => (i === at ? line : shown)),
        transcript: [...log.transcript, line]
      }
  }
  return added(line)
}
