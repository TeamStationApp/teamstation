import { act } from 'react'

import type { BoardStep } from '../common/api'
import {
  defaultScoreboardSettings,
  type ScoreboardOverlay
} from '../common/nodeSettings'
import { SAMPLE_SCOREBOARD } from '../common/scoreboard'
import type { WallTimeline } from '../common/wallTimeline'

/**
 * What the scoreboard overlay's suites share: a server that answers the two
 * timelines from tables the test fills in, steps and timelines to fill them
 * with, and a way to tell a board it has been laid out, which a browser does
 * through `ResizeObserver` and the test DOM never does.
 */

export const OVERLAY_T0 = Date.parse('2026-10-12T18:00:00Z')

/** A board at `at`, with `balls` to tell it apart. */
export function boardStep(
  at: number,
  balls = 0,
  names: { away?: string; home?: string } = {}
): BoardStep {
  return {
    at,
    state: {
      ...SAMPLE_SCOREBOARD,
      balls,
      awayTeam: names.away ?? SAMPLE_SCOREBOARD.awayTeam,
      homeTeam: names.home ?? SAMPLE_SCOREBOARD.homeTeam
    }
  }
}

export function wallTimelineOf(
  anchors: Array<[number, number]>,
  live = false
): WallTimeline {
  return {
    anchors,
    source: 'sei',
    confidence: 'frame',
    live,
    startAt: new Date(anchors[0]?.[1] ?? OVERLAY_T0).toISOString()
  }
}

/** One request the fake server was asked, as its path and query. */
export interface Asked {
  path: string
  query: URLSearchParams
}

/**
 * A `fetch` for `TeamStationClient` that answers the wall and board
 * timelines, from what the test puts in `timelines` and `steps`, and
 * remembers every request. A board request answers the steps in its window,
 * with the one in effect at `from`, as the server does.
 */
export function overlayServer(): {
  fetch: typeof fetch
  asked: Asked[]
  timelines: Map<
    string,
    WallTimeline | ((afterMs: number | null) => WallTimeline)
  >
  steps: Map<string, BoardStep[]>
  fail: Set<string>
  /** The status a path in `fail` answers with; 503 unless a test says. */
  failStatus: number
  /**
   * What each game's overlay answer says, by game: the node's defaults and
   * shown unless a test sets one, as for a game before the start date.
   */
  overlays: Map<string, ScoreboardOverlay>
} {
  const asked: Asked[] = []
  const timelines = new Map<
    string,
    WallTimeline | ((afterMs: number | null) => WallTimeline)
  >()
  const steps = new Map<string, BoardStep[]>()
  const fail = new Set<string>()
  const overlays = new Map<string, ScoreboardOverlay>()
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(urlOf(input), 'http://localhost')
    const path = url.pathname.replace(/^\/api\/v1/, '')
    asked.push({ path, query: url.searchParams })
    if (fail.has(path))
      return json({ error: 'nope', message: 'nope' }, server.failStatus)
    const wall = /^\/videos\/([^/]+)\/wall-timeline$/.exec(path)
    if (wall != null) {
      const held = timelines.get(decodeURIComponent(wall[1]))
      if (held == null) return json({ error: 'notFound', message: 'no' }, 404)
      const after = url.searchParams.get('afterMs')
      const timeline =
        typeof held === 'function'
          ? held(after == null ? null : Number(after))
          : held
      return json(
        after == null
          ? timeline
          : {
              ...timeline,
              anchors: timeline.anchors.filter(([m]) => m > Number(after))
            }
      )
    }
    const overlay = /^\/games\/([^/]+)\/scoreboard-overlay$/.exec(path)
    if (overlay != null)
      return json(overlays.get(decodeURIComponent(overlay[1])) ?? SHOWN_OVERLAY)
    const board = /^\/games\/([^/]+)\/scoreboard-timeline$/.exec(path)
    if (board != null) {
      const all = steps.get(decodeURIComponent(board[1])) ?? []
      const from = url.searchParams.get('from')
      let first = 0
      if (from != null) {
        while (first < all.length && all[first].at <= Number(from)) first++
        first = Math.max(0, first - 1)
      }
      return json({ version: '1:0', steps: all.slice(first) })
    }
    return json({ error: 'notFound', message: `no ${path}` }, 404)
  }
  const server = {
    fetch: fetchImpl,
    asked,
    timelines,
    steps,
    fail,
    failStatus: 503,
    overlays
  }
  return server
}

/** A game's overlay answer at the node's defaults, shown. */
export const SHOWN_OVERLAY: ScoreboardOverlay = {
  show: true,
  single: defaultScoreboardSettings.single,
  landscape: defaultScoreboardSettings.landscape,
  portraitHeight: defaultScoreboardSettings.portraitHeight
}

/**
 * Tells every drawn board how big it laid out: the element whose layout the
 * overlay measures is the one just around the board.
 */
export async function layOutBoards(
  width: number,
  height: number
): Promise<void> {
  const boards = document.querySelectorAll('[data-scoreboard="board"]')
  for (const board of boards) {
    const measured = board.parentElement?.parentElement as
      | (HTMLElement & {
          __reactLayoutHandler?: (event: unknown) => void
        })
      | null
    const handler = measured?.__reactLayoutHandler
    if (typeof handler !== 'function') continue
    await act(async () => {
      handler({ nativeEvent: { layout: { x: 0, y: 0, width, height } } })
    })
  }
}

/** The address a `fetch` was asked for, however it was given. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/** Lets timers, promises and a few display frames run. */
export async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}
