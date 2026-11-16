import { useCallback, useEffect, useRef, useState } from 'react'

import { planRefusal, type TeamStationClient } from '../../common/api'
import { MAX_PLAN_INNINGS } from '../../common/gamePlan'
import type { Side } from '../../common/scoring/state'
import { CachingClient } from '../sync/cachingClient'
import { type GameChanges, listen } from './rosterLive'
import type { InningStart, ScoringEvent } from './scoringTypes'

/** How many flushes `gameSaved` waits through before taking the game as unsaved. */
const SAVE_FLUSHES = 20

/** How long one download of an inning's column may take. */
export const PLAN_INNING_TIMEOUT_MS = 10_000

/** A side whose column for `inning` could not be downloaded. */
export interface PlanSyncCard {
  side: Side
  inning: number
  teamName: string
}

/**
 * The game's teams by side for `usePlanInnings`, from the teams the screen
 * opened on and the names the game gives them; none for a game the screen
 * did not open from the server.
 */
export function planTeamsOf(
  opened: { awayTeamId: string; homeTeamId: string } | undefined,
  names: Record<Side, { name: string }>
): Record<Side, { id: string; name: string }> | undefined {
  if (opened == null) return undefined
  return {
    away: { id: opened.awayTeamId, name: names.away.name },
    home: { id: opened.homeTeamId, name: names.home.name }
  }
}

/**
 * Whether the game as scored here has reached the server, so an inning can
 * be asked for: `saved` once its session's saves finished with nothing
 * pending, flushing again while plays scored meanwhile are still going out,
 * and on the phone its outbox drained with nothing left for the game.
 * `offline` when the session cannot save now (offline, read-only, or the
 * phone still holding the game): nothing is asked, and nothing is shown.
 * `failed` when a save failed online (`saveFailure`) or kept pending: the
 * session retries it, and the inning's card offers Try again.
 */
export async function gameSaved(
  game: {
    flush: () => Promise<unknown>
    readOnly: boolean
    offline: boolean
    saveFailure: string | null
    pending: number
  },
  client: TeamStationClient,
  gameId: string
): Promise<GameSaved> {
  for (let flushes = 0; ; flushes++) {
    try {
      await game.flush()
    } catch {
      return 'failed'
    }
    if (game.readOnly || game.offline) return 'offline'
    if (game.saveFailure != null) return 'failed'
    if (game.pending === 0) break
    if (flushes >= SAVE_FLUSHES) return 'failed'
  }
  if (client instanceof CachingClient) {
    await client.drainOutbox()
    const queue = await client.outboxSummary()
    if (
      (queue.chains[`game:${gameId}`] ?? 0) > 0 ||
      queue.games[gameId] != null
    )
      return 'offline'
  }
  return 'saved'
}

/** What `gameSaved` found. */
export type GameSaved = 'saved' | 'offline' | 'failed'

export interface PlanInningsOptions {
  /** A saved game on a screen that scores it: false asks for nothing. */
  enabled: boolean
  client: TeamStationClient
  gameId: string
  /** The game's teams by side, as the screen opened on them. */
  teams?: Record<Side, { id: string; name: string }>
  /** The inning last entered on this screen (`ScoringSnapshot.inningStart`). */
  inningStart?: InningStart
  /** The inning the game is in now, read when an answer lands. */
  currentInning: () => number
  /**
   * Waits until the game as scored here has been saved, so the server holds
   * the inning before it is asked (`gameSaved`): offline nothing is asked,
   * and a failed save shows the inning's card.
   */
  saved: () => Promise<GameSaved>
  socket?: GameChanges
  /**
   * Applies a downloaded column (`PLAN_INNING`), or answers false when the
   * screen is not at rest (`planInningWaits`): the column is held, and
   * offered again each time `scoring` changes, while its inning lasts.
   */
  apply: (event: PlanInningEvent) => boolean
  /** The screen's scoring state, whose changes offer a held column again. */
  scoring: unknown
  timeoutMs?: number
}

type PlanInningEvent = Extract<ScoringEvent, { type: 'PLAN_INNING' }>

/**
 * Downloads each side's plan column for the inning the game enters on this
 * screen, and for the inning in play when a coach's save changes it (a
 * `plans` change naming it), and applies it when it lands (`PLAN_INNING`),
 * or, while the screen is mid-play or busy, once it comes to rest in that
 * inning. Play never waits for it. An inning past `MAX_PLAN_INNINGS`, which
 * no plan has, is not asked for. Each download has `PLAN_INNING_TIMEOUT_MS`
 * from when it goes out, and nothing sends it again: not a reconnect, a
 * resync or reopening the screen. A download that fails or runs out of time
 * leaves a card for its side (`cards`), unless the game has left that
 * inning; Try again (`retry`) asks once more and Accept (`accept`) keeps the
 * lineup. Before the game's start time and once it is over the server
 * refuses, and nothing is shown.
 */
export function usePlanInnings(options: PlanInningsOptions): {
  cards: PlanSyncCard[]
  retry: (card: PlanSyncCard) => void
  accept: (card: PlanSyncCard) => void
} {
  const latest = useRef(options)
  latest.current = options
  const [cards, setCards] = useState<PlanSyncCard[]>([])
  const live = useRef(new Set<AbortController>())
  /** Columns that landed while the screen was busy, by side. */
  const held = useRef(new Map<Side, PlanInningEvent>())
  /**
   * Each request's turn, and each side's latest that settled, answered or
   * failed: an older request's outcome never overrides a newer one's.
   */
  const turns = useRef(0)
  const settled = useRef(new Map<Side, { inning: number; turn: number }>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const controllers = live.current
    const columns = held.current
    return () => {
      mounted.current = false
      for (const controller of controllers) controller.abort()
      controllers.clear()
      columns.clear()
    }
  }, [])

  /** Shows a side's card for `inning`, in place of any it had. */
  const showCard = useCallback((side: Side, inning: number): void => {
    const team = latest.current.teams?.[side]
    if (team == null) return
    setCards(shown => [
      ...shown.filter(card => card.side !== side),
      { side, inning, teamName: team.name }
    ])
  }, [])

  /** Offers each held column again; one whose inning has passed goes. */
  const offerHeld = useCallback((): void => {
    const now = latest.current
    for (const [side, event] of held.current) {
      if (event.inning !== now.currentInning() || now.apply(event))
        held.current.delete(side)
    }
  }, [])

  /** One side's column for `inning`, the game's save already awaited. */
  const request = useCallback(
    async (side: Side, inning: number): Promise<void> => {
      const now = latest.current
      const team = now.teams?.[side]
      if (team == null) return
      const turn = ++turns.current
      const controller = new AbortController()
      live.current.add(controller)
      const timer = setTimeout(() => {
        controller.abort()
      }, now.timeoutMs ?? PLAN_INNING_TIMEOUT_MS)
      try {
        const answer = await now.client.planInning(
          now.gameId,
          team.id,
          inning,
          { signal: controller.signal }
        )
        if (!mounted.current || latest.current.currentInning() !== inning)
          return
        // A newer request for this inning has already settled: this one was
        // read before it, and is dropped, whether that one's column came in
        // or its failure's card is up.
        const newer = settled.current.get(side)
        if (newer?.inning === inning && newer.turn > turn) return
        // A column on its way: a failure shown for this side and inning
        // no longer holds, nor does an older request's that fails later.
        settled.current.set(side, { inning, turn })
        setCards(shown =>
          shown.filter(card => card.side !== side || card.inning !== inning)
        )
        held.current.set(side, {
          type: 'PLAN_INNING',
          side,
          inning,
          column: answer.column
        })
        offerHeld()
      } catch (error) {
        const reason = planRefusal(error)
        if (reason === 'planNotStarted' || reason === 'planGameOver') return
        if (!mounted.current || latest.current.currentInning() !== inning)
          return
        const newer = settled.current.get(side)
        if (newer?.inning === inning && newer.turn > turn) return
        settled.current.set(side, { inning, turn })
        showCard(side, inning)
      } finally {
        clearTimeout(timer)
        live.current.delete(controller)
      }
    },
    [offerHeld, showCard]
  )

  /** These sides' columns for `inning`, once the game is saved, saved once. */
  const download = useCallback(
    (sides: readonly Side[], inning: number): void => {
      const read = async (): Promise<void> => {
        const now = latest.current
        if (!now.enabled || inning < 1 || inning > MAX_PLAN_INNINGS) return
        const saved = await now.saved()
        if (saved === 'offline') return
        if (!mounted.current || latest.current.currentInning() !== inning)
          return
        if (saved === 'failed') {
          // The server may not hold the inning yet: Try again asks once the
          // session has saved it.
          for (const side of sides) showCard(side, inning)
          return
        }
        await Promise.all(
          sides.map(async side => {
            await request(side, inning)
          })
        )
      }
      read().catch(() => undefined)
    },
    [request, showCard]
  )

  // Each inning entered here: both sides, and the cards of any other
  // inning go.
  const enteredId = options.inningStart?.id
  const enteredInning = options.inningStart?.inning
  useEffect(() => {
    if (enteredId == null || enteredInning == null) return
    setCards(shown => shown.filter(card => card.inning === enteredInning))
    download(['away', 'home'], enteredInning)
  }, [enteredId, enteredInning, download])

  // A held column is offered again as the screen moves on.
  const { scoring } = options
  useEffect(() => {
    offerHeld()
  }, [scoring, offerHeld])

  // A coach's save that changed the inning in play.
  const { socket, gameId } = options
  useEffect(() => {
    if (socket == null) return
    return listen(socket, gameId, event => {
      if (event.type !== 'change' || event.kind !== 'plans') return
      const now = latest.current
      const { teamId, inning } = event.data as {
        teamId?: unknown
        inning?: unknown
      }
      if (typeof inning !== 'number' || inning !== now.currentInning()) return
      const side = (['away', 'home'] as const).find(
        each => now.teams?.[each].id === teamId
      )
      if (side != null) download([side], inning)
    })
  }, [socket, gameId, download])

  const retry = useCallback(
    (card: PlanSyncCard): void => {
      setCards(shown => shown.filter(each => each.side !== card.side))
      download([card.side], card.inning)
    },
    [download]
  )
  const accept = useCallback((card: PlanSyncCard): void => {
    setCards(shown => shown.filter(each => each.side !== card.side))
  }, [])
  const inning = options.currentInning()
  return {
    cards: cards.filter(card => card.inning === inning),
    retry,
    accept
  }
}
