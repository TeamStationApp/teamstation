import {
  type Cause,
  causeLine,
  requiredLine,
  totalsLine
} from '../autoScheduler/capacity'
import type {
  EngineInput,
  EngineResult,
  FairnessRow,
  PlannedGame,
  ScheduleOption
} from '../autoScheduler/types'
import { addDays, wallInstant } from '../fieldAvailability'
import { gameCalendarDay } from '../gameTime'

/**
 * What every platform's wrapper of the Auto-Scheduler's C++ engine
 * (native/scheduler) shares: `engine.ts` (Node, the addon), `engine.web.ts`
 * (the web's worker) and `engine.native.ts` (the phones' `NativeScheduler`).
 * Every build is solved exactly; what the engine cannot build, and a device
 * that cannot run it, is a typed failure. JavaScript sends the run with each
 * zone's UTC offsets, so the engine needs no time-zone database, and words
 * what comes back: causes, unmet counts and reasons travel structured, and
 * every sentence is written here and in capacity.ts.
 */

/** A run to build: the engine input, the solver's time limit and the column limit. */
export interface EngineRequest {
  input: EngineInput
  /**
   * The session's time limit, from the first solve's start; 45 s by
   * default. At it the build pauses for the session's `onLimit`; causes get
   * what is left of it, at least 5 s each.
   */
  limitMs?: number
  /** The most columns a model may have; 400,000 by default. */
  maxColumns?: number
}

/** From `fromUtc` on, the zone is `offsetMinutes` east of UTC. */
export interface ZoneOffset {
  fromUtc: number
  offsetMinutes: number
}

/** What the engine reads: the request with each zone's offsets. */
export interface WireRequest extends EngineRequest {
  offsets: Record<string, ZoneOffset[]>
}

/** What a season settled at. */
export interface SeasonTargets {
  seasonId: string
  regular: number
  exhibition: number
}

/**
 * Why a build gave no options: the run blocked, the engine broke, the build
 * was canceled, or this device cannot run the engine at all (`noSolver`).
 */
export type EngineFailure = 'blocked' | 'broken' | 'canceled' | 'noSolver'

export type EngineBuild =
  | {
      kind: 'options'
      options: ScheduleOption[]
      /** Each option's unmet causes, structured, beside its `unmet` lines. */
      causes: Cause[][]
      blocking: string | null
      blockingCause: Cause | null
      targets: SeasonTargets[]
      /**
       * False when the admin took the best schedule found at the time limit
       * (`use`): it is not proven the best, and each short season's cause
       * says so.
       */
      provenOptimal: boolean
    }
  | {
      kind: 'failure'
      failure: EngineFailure
      message: string
      columns?: number
      limit?: number
    }

/** A reason a later option trails Option 1, as the engine reports it. */
type WireReason =
  | { term: 'unplaced' | 'doubleheaders' | 'scarcity'; more: number }
  | { term: 'preference' | 'balanced' }
  | {
      term: 'timeOfDay' | 'weekday'
      teamId: string
      count: number
      games: number
      index: number
    }
  | { term: 'backToBack'; teamId: string; count: number }
  | { term: 'gap'; teamId: string; days: number | null }

type WireUnmet =
  | {
      seasonId: string
      kind: 'regular' | 'exhibition'
      requested: number
      totals: Array<{ teamId: string; total: number }>
      cause: Cause
    }
  | {
      seasonId: string
      kind: 'required'
      required: number
      unplaced: number
      cause: Cause
    }

/** The engine's answer as it travels: options, or a failure. */
export type WireResult =
  | {
      kind: 'options'
      options: Array<{
        games: PlannedGame[]
        fairness: FairnessRow[]
        reasons: WireReason[]
        unmet: WireUnmet[]
        score: number[]
      }>
      blocking: Cause | null
      targets?: SeasonTargets[]
      provenOptimal?: boolean
    }
  | {
      kind: 'failure'
      failure: EngineFailure
      message: string
      columns?: number
      limit?: number
    }

const DAY = 86_400_000
const MINUTE = 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Minutes east of UTC in a zone at an instant, read as gameTime reads it. */
export function offsetAt(instant: number, timezone: string): number {
  let formatter = formatters.get(timezone)
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    formatters.set(timezone, formatter)
  }
  const at = Math.floor(instant / MINUTE) * MINUTE
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(at)).map(part => [part.type, part.value])
  )
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute)
  )
  return Math.round((wall - at) / MINUTE)
}

/**
 * A zone's offsets from `from` to `to`: the offset at the window's start,
 * then each change, found by reading the offset at every local midnight and
 * bisecting, between two midnights that differ, to the minute it changes.
 */
export function zoneOffsets(
  timezone: string,
  from: number,
  to: number
): ZoneOffset[] {
  const out: ZoneOffset[] = [
    { fromUtc: from, offsetMinutes: offsetAt(from, timezone) }
  ]
  const last = gameCalendarDay(new Date(to).toISOString(), timezone)
  let previous = from
  let offset = out[0].offsetMinutes
  for (
    let date = gameCalendarDay(new Date(from).toISOString(), timezone);
    date <= last;
    date = addDays(date, 1)
  ) {
    const midnight = wallInstant(addDays(date, 1), '00:00', timezone)
    const next = offsetAt(midnight, timezone)
    if (next !== offset) {
      // Bisect on whole minutes, the grain `offsetAt` reads: `previous` may
      // be `from`, which need not fall on one, and a step under a minute
      // would never move `low`.
      let low = Math.floor(previous / MINUTE) * MINUTE
      let high = Math.floor(midnight / MINUTE) * MINUTE
      while (high - low > MINUTE) {
        const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE
        if (offsetAt(middle, timezone) === offset) low = middle
        else high = middle
      }
      out.push({ fromUtc: high, offsetMinutes: next })
      offset = next
    }
    previous = midnight
  }
  return out
}

/** The instants the run reads, two days either side. */
function runWindow(input: EngineInput): { from: number; to: number } {
  let from = input.notBefore
  let to = input.notBefore
  for (const season of input.seasons) {
    from = Math.min(from, Date.parse(`${season.settings.startsOn}T00:00:00Z`))
    to = Math.max(to, Date.parse(`${season.settings.endsOn}T00:00:00Z`) + DAY)
  }
  for (const each of [...input.fixed, ...input.bookings]) {
    from = Math.min(from, each.start)
    to = Math.max(to, each.end)
  }
  for (const each of input.weeklyGames ?? []) {
    from = Math.min(from, each.start)
    to = Math.max(to, each.start)
  }
  return { from: from - 2 * DAY, to: to + 2 * DAY }
}

/** The request as the engine reads it, with every zone's offsets over the run. */
export function wireRequest(request: EngineRequest): WireRequest {
  const { from, to } = runWindow(request.input)
  const zones = new Set(
    request.input.fields.map(field => field.availability.timezone)
  )
  const offsets: Record<string, ZoneOffset[]> = {}
  for (const zone of zones) offsets[zone] = zoneOffsets(zone, from, to)
  return { ...request, offsets }
}

const PARTS = ['in the morning', 'in the afternoon', 'in the evening']
const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays'
]

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/** A reason in today's words (options.ts `optionReasons`). */
export function reasonLine(
  reason: WireReason,
  teamNames: Record<string, string>
): string {
  const name = (team: string): string => teamNames[team] ?? team
  switch (reason.term) {
    case 'unplaced':
      return `${plural(reason.more, 'more game')} left unplaced`
    case 'doubleheaders':
      return plural(reason.more, 'more doubleheader')
    case 'preference':
      return 'More games fall outside the preferred part of the week'
    case 'timeOfDay':
    case 'weekday': {
      const where =
        reason.term === 'timeOfDay'
          ? PARTS[reason.index]
          : `on ${WEEKDAYS[reason.index]}`
      return `${name(reason.teamId)} plays ${reason.count} of its ${plural(reason.games, 'game')} ${where}`
    }
    case 'backToBack':
      return `${name(reason.teamId)} has ${reason.count} games on back-to-back days`
    case 'gap':
      return `${name(reason.teamId)} goes ${reason.days ?? -Infinity} days without a game`
    case 'scarcity':
      return reason.more > 0
        ? `${plural(reason.more, 'more game')} on fields other seasons also need`
        : 'more use of fields other seasons also need'
    default:
      return 'Just as balanced as Option 1, at other dates and times'
  }
}

/** The engine's answer, worded. */
export function readResult(text: string, input: EngineInput): EngineBuild {
  const result = JSON.parse(text) as WireResult
  if (result.kind === 'failure') return result
  const names = input.teamNames
  const context = { teamNames: names }
  return {
    kind: 'options',
    options: result.options.map(option => ({
      // Games at one start in their keys' order, as plannedGames sorts them.
      games: [...option.games].sort((a, b) => {
        const apart = Date.parse(a.startAt) - Date.parse(b.startAt)
        return apart !== 0 ? apart : a.key.localeCompare(b.key)
      }),
      fairness: option.fairness,
      reasons: option.reasons.map(reason => reasonLine(reason, names)),
      unmet: option.unmet.map(line => ({
        seasonId: line.seasonId,
        message:
          line.kind === 'required'
            ? requiredLine(line.unplaced, line.required)
            : totalsLine(
                line.kind,
                line.totals.map(({ teamId, total }) => ({
                  name: names[teamId] ?? teamId,
                  total
                })),
                line.requested
              ),
        cause: causeLine(line.cause, context)
      })),
      score: option.score
    })),
    causes: result.options.map(option => option.unmet.map(line => line.cause)),
    blocking:
      result.blocking == null ? null : causeLine(result.blocking, context),
    blockingCause: result.blocking,
    targets: result.targets ?? [],
    provenOptimal: result.provenOptimal ?? true
  }
}

/** A step of a build, in the order they run. */
export type EnginePhaseName =
  'context' | 'model' | 'targets' | 'placement' | 'cause' | 'polish' | 'options'

/**
 * A step of the build has finished, taking `ms` of the engine's time (time
 * paused at the limit is not counted). `model` gives the first model's
 * size; each short season's `cause` names the season.
 */
export interface EnginePhase {
  kind: 'phase'
  phase: EnginePhaseName
  ms: number
  detail?: { columns?: number; rows?: number; seasonName?: string }
}

/**
 * A step of the build has started; its `phase` event follows when it ends,
 * before the next step starts. Each short season's `cause` names the
 * season, as its end does.
 */
export interface EnginePhaseStart {
  kind: 'phase-start'
  phase: EnginePhaseName
  detail?: { seasonName?: string }
}

/**
 * The solver found a better schedule: `incumbentGames` new games, at most
 * `boundGames` possible, `gap` the share of those not reached (0.024 for
 * 2.4%).
 */
export interface EngineProgress {
  kind: 'progress'
  incumbentGames: number
  boundGames: number
  gap: number
}

/**
 * The build reached its time limit without a proof, and waits for the
 * session's answer. `bestGames` is the best schedule's new games, or null
 * while none with games has been found; `solvedMs` is the solve time so
 * far, not counting time spent paused.
 */
export interface EngineLimit {
  kind: 'limit'
  stage: 'targets' | 'placement'
  bestGames: number | null
  boundGames: number
  solvedMs: number
}

/** One event the engine reports during a build. */
export type EngineEvent =
  EnginePhaseStart | EnginePhase | EngineProgress | EngineLimit

/**
 * The answer at the time limit. `continue`: the same solve carries on, with
 * a new limit from now. `use`: the build takes the best schedule found (or,
 * with none yet, the first it finds), and the placement after it gets its
 * own limit. `cancel`: the build ends with the `canceled` failure.
 */
export type EngineDecision = 'continue' | 'use' | 'cancel'

/** What a caller hears while a build runs, and how it stops one. */
export interface EngineSession {
  /** Each event the engine reports while it builds, the limit's too. */
  onProgress?: (event: EngineEvent) => void
  /**
   * The answer at the time limit; without one, or when it fails, the build
   * takes its best schedule (`use`) or, after a failure, is canceled.
   */
  onLimit?: (limit: EngineLimit) => EngineDecision | Promise<EngineDecision>
  /** Aborted: the build stops, and answers the `canceled` failure. */
  signal?: AbortSignal
}

/**
 * A build the engine is running, as the Node addon and `NativeScheduler`
 * hand it back: the result JSON, a way to stop it, and the answer to a
 * pause at the time limit (`decide`).
 */
export interface EngineHandle {
  promise: Promise<string>
  cancel: () => void
  decide: (choice: EngineDecision) => void
}

/** An engine that starts a build from the request JSON. */
export type StartBuild = (
  request: string,
  onProgress: (event: string) => void
) => EngineHandle

/** A failure of the engine's kinds, with its message. */
export function failure(
  kind: EngineFailure,
  message: string
): Extract<EngineBuild, { kind: 'failure' }> {
  return { kind: 'failure', failure: kind, message }
}

/** The answer for a build asked to stop before it ran. */
export const CANCELED = failure('canceled', 'The build was canceled')

const EVENT_KINDS = new Set(['phase-start', 'phase', 'progress', 'limit'])

/** An event's JSON as the session hears it; anything else is dropped. */
export function readEvent(text: string): EngineEvent | null {
  try {
    const event: unknown = JSON.parse(text)
    return typeof event === 'object' &&
      event != null &&
      EVENT_KINDS.has((event as { kind?: unknown }).kind as string)
      ? (event as EngineEvent)
      : null
  } catch {
    return null
  }
}

/** The session's answer to a limit: `use` without `onLimit`, `cancel` when it fails. */
export async function answerLimit(
  limit: EngineLimit,
  session: EngineSession
): Promise<EngineDecision> {
  if (session.onLimit == null) return 'use'
  try {
    return await session.onLimit(limit)
  } catch {
    return 'cancel'
  }
}

/**
 * Runs one build through an engine that hands back a handle (the Node
 * addon, `NativeScheduler`): the request with its offsets in, each event to
 * the session, each limit answered through `decide` (a `cancel` answer
 * through `cancel`), the session's abort to `cancel`, and the answer worded.
 */
export async function runBuild(
  start: StartBuild,
  request: EngineRequest,
  session: EngineSession = {}
): Promise<EngineBuild> {
  const { signal, onProgress } = session
  if (signal?.aborted === true) return CANCELED
  const handle: EngineHandle = start(
    JSON.stringify(wireRequest(request)),
    text => {
      const event = readEvent(text)
      if (event == null) return
      onProgress?.(event)
      if (event.kind === 'limit')
        answerLimit(event, session)
          .then(decision => {
            if (decision === 'cancel') handle.cancel()
            else handle.decide(decision)
          })
          .catch(() => undefined)
    }
  )
  const stop = (): void => {
    handle.cancel()
  }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    return readResult(await handle.promise, request.input)
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

/**
 * A build that failed, thrown by the client: its kind (`noSolver`,
 * `blocked`, `broken`, `canceled`) beside the engine's message.
 */
export class EngineFailureError extends Error {
  readonly failure: EngineFailure
  constructor(failure: EngineFailure, message: string) {
    super(message)
    this.name = 'EngineFailureError'
    this.failure = failure
  }
}

/**
 * What the server stores for a build, its options and blocking cause as
 * built, and whether the solver proved it the best; a failure is thrown as
 * an `EngineFailureError`.
 */
export function engineResult(build: EngineBuild): EngineResult {
  if (build.kind === 'failure')
    throw new EngineFailureError(build.failure, build.message)
  return {
    options: build.options,
    blocking: build.blocking,
    provenOptimal: build.provenOptimal
  }
}
