import type {
  GameDetail,
  MyRoles,
  RosterEntry,
  SwapSidesAnswer,
  SwapSidesRead,
  TeamStationClient
} from '../../common/api'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { SwapEffect } from '../../common/scoring/playsLost'
import type { StoredGame } from '../../common/scoring/session'
import type { DefaultLineups } from '../../common/scoring/startingSetup'
import {
  type SwapDocumentsEffect,
  swappedDocuments
} from '../../common/scoring/swapDocuments'

/**
 * The web's writes of an open scoring screen that the screen does not wait
 * for. The web keeps no store and no queue, so this holds them in memory,
 * in the order they were made, for as long as the screen is open: a swap of
 * home and away is answered at once from what the screen loaded, as the
 * phone answers it from its documents, and sent behind the screen after the
 * game's own unsaved changes. Until the server answers it, the screen opens
 * the game again on the swapped copy held here (`held`), as a phone opens
 * on its stored one.
 */

/** What the scoring screen read as it opened a game. */
export interface OpenedReads {
  game: GameDetail
  roles: MyRoles | undefined
  /** Whether the person manages each team's roster, as its roster was read. */
  rights: Record<string, boolean>
  /** Each team's roster, by team id. */
  rosters: Record<string, RosterEntry[]>
  defaults: DefaultLineups
}

/**
 * A swap still out: what the screen opened on with home and away
 * exchanged, the plays as the swap leaves them, and when the server
 * answered it. The screen opens on it, and its saves go behind `landed`.
 */
export interface HeldSwap extends OpenedReads {
  events: StoredGame
  /** Settles once the server took the swap; rejects once it refused it. */
  landed: Promise<void>
}

/** What of the open session a swap sends behind. */
export interface SwappingSession {
  /** Sends what the session has not saved. */
  flush: () => Promise<void>
  /** The plays digest of the server's last answer the session took up. */
  readonly playsDigest?: string
  /** The play generation the session opened the game on. */
  readonly generation?: number
  /** What the server last said a swap does. */
  readonly serverSwap?: SwapEffect
}

export interface WebSwap {
  gameId: string
  /** What the scorer confirmed: the sides alone, or a reset first. */
  effect: SwapDocumentsEffect
  /** The game as the screen loaded it, its sides as the screen holds them. */
  game: Record<string, unknown> & { homeTeamId: string; awayTeamId: string }
  /** The game's plays as the screen holds them, for what a reset loses. */
  plays: { plays: unknown[]; currentPlay: unknown }
  session: SwappingSession
  /** The server refused it: the screen says why, and reads the game again. */
  onRefused: (message: string) => void
}

export class WebWrites {
  /** The last write queued, settled once it is answered. */
  private tail: Promise<void> = Promise.resolve()
  /** What the screen opened each game on. */
  private readonly opened = new Map<string, OpenedReads>()
  /** Each game's last swap the server has not answered. */
  private readonly out = new Map<string, HeldSwap>()
  private readonly landers = new Map<string, Set<() => void>>()
  private digests = 0

  constructor(
    private readonly client: Pick<TeamStationClient, 'swapGameSides'>
  ) {}

  /**
   * Answers a swap at once from what the screen loaded (`swappedDocuments`),
   * and sends it behind the screen once every swap queued before it is
   * answered: the session's unsaved changes, sent from now, then the swap,
   * for a reset with the session's last plays digest and generation. Over
   * what the screen kept of the game (`keep`), the swapped copy is `held`
   * until the server answers; `onLanded` listeners are told once it takes
   * the swap, and a refusal gives the copy up before `onRefused`.
   */
  queueSwap(swap: WebSwap): SwapSidesAnswer {
    const kept = this.opened.get(swap.gameId)
    // Stands for the lineups digest the server gives the new sides.
    const digest = `web:${++this.digests}`
    const done = swappedDocuments(
      {
        game: { ...kept?.game, ...swap.game },
        lineups: null,
        events: {
          plays: swap.plays.plays.map(gumbo => ({ gumbo })),
          currentPlay: swap.plays.currentPlay,
          ...(swap.session.generation == null
            ? {}
            : { generation: swap.session.generation })
        }
      },
      swap.effect,
      digest
    )
    const read: SwapSidesRead = {
      homeTeamId: swap.game.homeTeamId,
      awayTeamId: swap.game.awayTeamId
    }
    // The session's unsaved changes start out now, before the screen closes
    // it, and the swap goes once they and every swap before it are answered.
    const flushed = swap.session.flush().catch(() => undefined)
    let land: (refused?: Error) => void = () => undefined
    const landed = new Promise<void>((resolve, reject) => {
      land = refused => {
        if (refused == null) resolve()
        else reject(refused)
      }
    })
    // Nothing waits on it but the saves behind it.
    landed.catch(() => undefined)
    const held =
      kept == null
        ? undefined
        : {
            ...kept,
            game: done.game as unknown as GameDetail,
            defaults: { away: kept.defaults.home, home: kept.defaults.away },
            events: heldEvents(
              done.events,
              digest,
              swap.effect === 'reset' ? 'swap' : swap.session.serverSwap
            ),
            landed
          }
    if (held == null) this.out.delete(swap.gameId)
    else this.out.set(swap.gameId, held)
    const send = async (): Promise<void> => {
      await flushed
      const { generation, playsDigest } = swap.session
      try {
        await this.client.swapGameSides(swap.gameId, {
          ...read,
          // Only a reset the scorer confirmed names the plays it loses.
          ...(swap.effect !== 'reset' || generation == null
            ? {}
            : { generation }),
          ...(swap.effect !== 'reset' || playsDigest == null
            ? {}
            : { playsDigest })
        })
      } catch (error: unknown) {
        // A swap queued behind it was made on this one: the server's copy
        // is the game now.
        this.out.delete(swap.gameId)
        const refused =
          error instanceof Error ? error : new Error(String(error))
        land(refused)
        swap.onRefused(refused.message)
        return
      }
      if (this.out.get(swap.gameId) === held) this.out.delete(swap.gameId)
      land()
      for (const listener of [...(this.landers.get(swap.gameId) ?? [])])
        listener()
    }
    const run = this.tail.then(send)
    this.tail = run.catch(() => undefined)
    return done.answer
  }

  /** Keeps what the screen opened `gameId` on, which a swap is made over. */
  keep(gameId: string, reads: OpenedReads): void {
    this.opened.set(gameId, reads)
  }

  /** The game's last swap the server has not answered, if one is out. */
  held(gameId: string): HeldSwap | undefined {
    return this.out.get(gameId)
  }

  /**
   * Tells `listener` each time the server takes a swap of `gameId`, until
   * unsubscribed: the screen reads the server's copy in behind it.
   */
  onLanded(gameId: string, listener: () => void): () => void {
    let listeners = this.landers.get(gameId)
    if (listeners == null) {
      listeners = new Set()
      this.landers.set(gameId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.landers.delete(gameId)
    }
  }

  /** Settles once every write queued so far is answered. */
  async settled(): Promise<void> {
    await this.tail
  }
}

/** The swapped events document as the plays a session opens on. */
function heldEvents(
  events: Record<string, unknown> | null,
  lineupsDigest: string,
  swap: SwapEffect | undefined
): StoredGame {
  const rows = Array.isArray(events?.plays) ? events.plays : []
  const generation = events?.generation
  return {
    plays: rows.map(row => (row as { gumbo: GumboPlay }).gumbo),
    currentPlay: (events?.currentPlay ?? null) as CurrentPlay | null,
    lineupsDigest,
    ...(typeof generation === 'number' ? { generation } : {}),
    ...(swap == null ? {} : { swap })
  }
}
