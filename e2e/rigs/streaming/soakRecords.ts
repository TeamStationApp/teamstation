import { readFileSync } from 'node:fs'

import type { SoakSurface } from './soakSchedule'

/**
 * What a soak run writes, one JSON object per line, all times in epoch milliseconds.
 * The scenario writes them; the gates, the memory verdicts and the report read them.
 */

/** Something the run did: a schedule event, as it really happened. */
export interface RecordedEvent {
  atMs: number
  /** When the action finished: a cut's restore, a relaunch's rejoin. */
  doneMs?: number
  target: string
  action: string
  args?: Record<string, unknown>
  /** The driver threw: the instance cannot be judged. */
  error?: string
  /** What a surface switch saw: a page that reloaded fails the switch. */
  outcome?: { reloaded?: boolean }
}

export interface ProbeTile {
  angle: string
  /** Null when the surface could not tell. */
  advancing: boolean | null
  notice: string | null
}

/** One look at a surface. `tiles` is null when it could not answer at all. */
export interface RecordedProbe {
  atMs: number
  surface: SoakSurface
  tiles: ProbeTile[] | null
  /** The bar's position, 0–1, where the surface says. */
  bar: number | null
  /** Whether the app (or the page's browser) is in front; null when unknown. */
  foreground: boolean | null
  /** The page or app lost its sign-in. */
  sessionLost?: boolean
  reason?: string
  /** Paths in the run directory. */
  screenshots?: string[]
}

export interface MemorySample {
  device: string
  process: string
  atMs: number
  bytes: number
  pid?: number
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as T)
}

export function readJsonl<T>(path: string): T[] {
  return parseJsonl<T>(readFileSync(path, 'utf8'))
}

/** Which angle each publisher feeds. */
export const PUBLISHER_ANGLE: Record<string, string> = {
  publisherA: 'PhoneA',
  publisherB: 'PhoneB',
  publisherC: 'Synthetic'
}
