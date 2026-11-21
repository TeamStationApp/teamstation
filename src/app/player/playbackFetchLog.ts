import type {
  PlaybackSurface,
  Property
} from '../../common/observability/contract'
import { emitAppLog } from '../observability/log'
import type { PlaybackEmit } from './playbackSession'

export type FetchOutcome = 'ok' | 'pending' | 'unavailable'

export interface FetchDescription {
  kind: 'playback' | 'live_now'
  surface: PlaybackSurface
  videoId?: string
  /** Which ask this is, from 0, for a caller that asks again. */
  attempt?: number
  /** How long the caller waited before this ask. */
  retryDelayMs?: number
  /**
   * For a caller that asks on a timer: whether an answer is worth a log line
   * (a first one, a change, a slow one). Failures are always said.
   */
  worthSaying?: (
    outcome: FetchOutcome,
    count: number | undefined,
    ms: number
  ) => boolean
}

/** What a playback answer amounts to for a player waiting on it. */
export function playbackOutcome(answer: {
  url: string | null
  pending?: boolean
}): FetchOutcome {
  if (answer.url != null) return 'ok'
  return answer.pending === true ? 'pending' : 'unavailable'
}

function statusOf(error: unknown): number | undefined {
  const status =
    error != null && typeof error === 'object'
      ? (error as { status?: unknown }).status
      : undefined
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined
}

/** A request being timed: say how it ended, once. */
export interface FetchLog {
  answered: (outcome: FetchOutcome, count?: number) => void
  failed: (error: unknown) => void
}

/**
 * Starts timing a request a player screen depends on. For a caller that must
 * keep its own promise chain exactly as it is (`loggedFetch` adds a turn):
 * it reports from inside its own `then` and `catch`.
 */
export function startFetchLog(
  description: FetchDescription,
  emit: PlaybackEmit = emitAppLog,
  now: () => number = Date.now
): FetchLog {
  const started = now()
  let done = false
  const report = (properties: Record<string, Property | undefined>): void => {
    if (done) return
    done = true
    try {
      const clean: Record<string, Property> = {
        fk: description.kind,
        sf: description.surface,
        ms: Math.min(86400000, Math.max(0, now() - started))
      }
      if (
        description.videoId != null &&
        /^vid_[A-Za-z0-9_-]{1,96}$/.test(description.videoId)
      )
        clean.vi = description.videoId
      if (description.attempt != null)
        clean.at = Math.min(1e6, Math.max(0, description.attempt))
      if (description.retryDelayMs != null)
        clean.rd = Math.min(86400000, Math.max(0, description.retryDelayMs))
      for (const [key, value] of Object.entries(properties))
        if (value !== undefined) clean[key] = value
      const failed = clean.oc === 'error' || clean.oc === 'offline'
      emit('playback_fetch', clean, failed ? 'warn' : 'info')
    } catch {
      /* Reporting must not change what the caller sees. */
    }
  }
  return {
    answered: (outcome, count) => {
      const n =
        count == null || !Number.isFinite(count)
          ? undefined
          : Math.min(1e6, Math.max(0, count))
      try {
        if (
          description.worthSaying != null &&
          !description.worthSaying(outcome, n, Math.max(0, now() - started))
        ) {
          done = true
          return
        }
      } catch {}
      report({ oc: outcome, n })
    },
    failed: error => {
      const status = statusOf(error)
      report({ oc: status == null ? 'offline' : 'error', status })
    }
  }
}

/**
 * Runs a request a player screen depends on and reports how it went: how
 * long, what it amounted to, which ask it was. The answer, or the failure, is
 * handed back unchanged, one turn later than the request's own.
 */
export async function loggedFetch<T>(
  description: FetchDescription,
  run: () => Promise<T>,
  outcome: (value: T) => FetchOutcome,
  count?: (value: T) => number,
  emit: PlaybackEmit = emitAppLog,
  now: () => number = Date.now
): Promise<T> {
  const log = startFetchLog(description, emit, now)
  return await run().then(
    value => {
      let counted: number | undefined
      let answer: FetchOutcome | undefined
      try {
        counted = count?.(value)
      } catch {}
      try {
        answer = outcome(value)
      } catch {}
      log.answered(answer ?? 'ok', counted)
      return value
    },
    (error: unknown) => {
      log.failed(error)
      throw error
    }
  )
}
