import type {
  SwapSidesAnswer,
  SwapSidesRead,
  TeamStationClient
} from '../../common/api'
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
 * game's own unsaved changes.
 */

/** What of the open session a swap sends behind. */
export interface SwappingSession {
  /** Sends what the session has not saved. */
  flush: () => Promise<void>
  /** The plays digest of the server's last answer the session took up. */
  readonly playsDigest?: string
  /** The play generation the session opened the game on. */
  readonly generation?: number
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

  constructor(
    private readonly client: Pick<TeamStationClient, 'swapGameSides'>
  ) {}

  /**
   * Answers a swap at once from what the screen loaded (`swappedDocuments`),
   * and sends it behind the screen once every swap queued before it is
   * answered: the session's unsaved changes, sent from now, then the swap,
   * for a reset with the session's last plays digest and generation.
   */
  queueSwap(swap: WebSwap): SwapSidesAnswer {
    const { answer } = swappedDocuments(
      {
        game: swap.game,
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
      ''
    )
    const read: SwapSidesRead = {
      homeTeamId: swap.game.homeTeamId,
      awayTeamId: swap.game.awayTeamId
    }
    // The session's unsaved changes start out now, before the screen closes
    // it, and the swap goes once they and every swap before it are answered.
    const flushed = swap.session.flush().catch(() => undefined)
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
        swap.onRefused(error instanceof Error ? error.message : String(error))
      }
    }
    const run = this.tail.then(send)
    this.tail = run.catch(() => undefined)
    return answer
  }

  /** Settles once every write queued so far is answered. */
  async settled(): Promise<void> {
    await this.tail
  }
}
