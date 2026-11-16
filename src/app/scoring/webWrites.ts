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
import type { ScoringMutation } from '../../common/scoring/scoringMutation'
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
  /**
   * Settles once the server took the swap, with the lineups digest its
   * answer gave the new sides (none from an older server); rejects once it
   * refused it.
   */
  landed: Promise<string | undefined>
  /**
   * The accepted scoring the swap was sent on, once it landed: the
   * session's observed base after every change ahead of the swap was
   * saved, none for a reset (which clears it), and undefined until then.
   */
  scoringBase: () => ScoringMutation | null | undefined
}

/**
 * What of the open session a swap sends behind. The swap's queue owns it
 * from the tap: it goes on saving (its own retries included) until nothing
 * is left unsaved or the server refused it, and the queue closes it then.
 */
export interface SwappingSession {
  /** Sends what the session has not saved. */
  flush: () => Promise<void>
  /** Changes the server has not acknowledged. */
  readonly pending: number
  /** The server refused to be written to: nothing more will be saved. */
  readonly readOnly: boolean
  /** The server read the last save and cannot store it. */
  readonly stopped: boolean
  /** The plays were reset under it: its changes belong to none of them. */
  readonly replaced: boolean
  subscribe: (listener: () => void) => () => void
  /** Saves nothing more. */
  close: () => void
  /** The plays digest of the server's last answer the session took up. */
  readonly playsDigest?: string
  /** The play generation the session opened the game on. */
  readonly generation?: number
  /** What the server last said a swap does. */
  readonly serverSwap?: SwapEffect
  /** The accepted scoring the session last observed: its saves' base. */
  readonly observedScoringMutation?: ScoringMutation
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
    // The session's unsaved changes start out now, and the swap goes only
    // once the server has taken every one of them (the session tries a 5xx
    // or an offline save again itself) and every swap before it is answered.
    // Changes the server will never take refuse the swap, counted: sent
    // ahead of them, the server's copy read in behind it would replace them.
    const unsaved = swap.session.pending
    const flushed = swap.session.flush().catch(() => undefined)
    let land: (
      outcome: { refused: Error } | { digest?: string }
    ) => void = () => undefined
    const landed = new Promise<string | undefined>((resolve, reject) => {
      land = outcome => {
        if ('refused' in outcome) reject(outcome.refused)
        else resolve(outcome.digest)
      }
    })
    // Nothing waits on it but the saves behind it.
    landed.catch(() => undefined)
    // The scoring a save behind the swap is built on: the session's own
    // accepted scoring once its changes ahead of the swap are saved, as the
    // server keeps it through a swap; a reset clears it.
    let sentBase: ScoringMutation | null | undefined
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
              swap.effect === 'reset' ? 'swap' : swap.session.serverSwap,
              swap.effect === 'reset'
                ? undefined
                : swap.session.observedScoringMutation
            ),
            landed,
            scoringBase: () => sentBase
          }
    if (held == null) this.out.delete(swap.gameId)
    else this.out.set(swap.gameId, held)
    const refuse = (error: unknown): void => {
      // A swap queued behind it was made on this one: the server's copy
      // is the game now.
      this.out.delete(swap.gameId)
      const refused = error instanceof Error ? error : new Error(String(error))
      land({ refused })
      swap.onRefused(refused.message)
    }
    const send = async (): Promise<void> => {
      await flushed
      await saved(swap.session)
      const left = swap.session
      // A refusal puts the session back to what the server holds, so what
      // it gave up is what was unsaved at the tap.
      const lost =
        left.pending > 0
          ? left.pending
          : left.readOnly || left.stopped || left.replaced
            ? unsaved
            : 0
      const observed =
        swap.effect === 'reset' ? null : (left.observedScoringMutation ?? null)
      left.close()
      if (lost > 0) {
        refuse(new Error(unsavedRefusal(lost)))
        return
      }
      const { generation, playsDigest } = swap.session
      let answer: SwapSidesAnswer
      try {
        answer = await this.client.swapGameSides(swap.gameId, {
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
        refuse(error)
        return
      }
      if (this.out.get(swap.gameId) === held) this.out.delete(swap.gameId)
      sentBase = observed
      land({ digest: answer.lineupsDigest })
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

/**
 * Settles once `session` has nothing unsaved, or the server took none of it
 * for good (refused, could not store it, or the plays were reset under it).
 * A save that failed for now is tried again by the session itself.
 */
async function saved(session: SwappingSession): Promise<void> {
  const done = (): boolean =>
    session.pending === 0 ||
    session.readOnly ||
    session.stopped ||
    session.replaced
  if (done()) return
  await new Promise<void>(resolve => {
    const stop = session.subscribe(() => {
      if (!done()) return
      stop()
      resolve()
    })
  })
}

/** Why a swap was not sent: changes ahead of it the server did not take. */
export function unsavedRefusal(lost: number): string {
  const changes = lost === 1 ? '1 change' : `${lost} changes`
  return `Home and away were not swapped: the server did not save ${changes} made before the swap, so ${lost === 1 ? 'it was' : 'they were'} not kept.`
}

/** The swapped events document as the plays a session opens on. */
function heldEvents(
  events: Record<string, unknown> | null,
  lineupsDigest: string,
  swap: SwapEffect | undefined,
  scoringMutation: ScoringMutation | undefined
): StoredGame {
  const rows = Array.isArray(events?.plays) ? events.plays : []
  const generation = events?.generation
  return {
    plays: rows.map(row => (row as { gumbo: GumboPlay }).gumbo),
    currentPlay: (events?.currentPlay ?? null) as CurrentPlay | null,
    lineupsDigest,
    ...(typeof generation === 'number' ? { generation } : {}),
    ...(swap == null ? {} : { swap }),
    // The accepted scoring the swap keeps: what the session opened on it
    // observes, so its first save is built on it, as a phone's is.
    ...(scoringMutation == null ? {} : { scoringMutation })
  }
}
