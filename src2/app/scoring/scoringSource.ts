import type {
  GameDetail,
  GameStationClient,
  RosterEntry
} from '../../common/api'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { startingSetup, teamsOf } from './developmentSession'

/** Where the scoring screen's game comes from and is kept. */
export interface ScoringSource {
  /** The game outlives the screen: leaving loses only what is not saved yet. */
  persistent?: boolean
  open: (
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[]
  ) => Promise<ScoringSession>
}

function context(
  game: GameDetail,
  away: RosterEntry[],
  home: RosterEntry[]
): Parameters<typeof ScoringSession.open>[2] {
  return {
    gamePk: game.id,
    teams: teamsOf(game),
    setup: startingSetup(game, away, home),
    fenceDistanceFt: game.fenceDistanceFt
  }
}

/** Scores into the server's copy of the game as it is played. */
export class ServerScoringSource implements ScoringSource {
  readonly persistent = true
  constructor(private readonly client: GameStationClient) {}

  async open(
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[]
  ): Promise<ScoringSession> {
    const client = this.client
    const store: EventStore = {
      load: async gameId => await client.gameEvents(gameId),
      save: async (gameId, change) =>
        await client.saveGameEvents(gameId, change)
    }
    return await ScoringSession.open(store, game.id, context(game, away, home))
  }
}

/**
 * Scores into memory and nowhere else: the field preview, and the tests. A
 * game opened again from the same source picks up where it was left.
 */
/** A store that keeps games in memory: the field preview, and the tests. */
export function memoryStore(
  games = new Map<string, StoredGame>()
): EventStore & { games: Map<string, StoredGame> } {
  return {
    games,
    load: async gameId => games.get(gameId) ?? { plays: [], currentPlay: null },
    save: async (gameId, change: SaveChange) => {
      const stored = games.get(gameId) ?? { plays: [], currentPlay: null }
      const plays = new Map(
        stored.plays.map(play => [play.about.atBatIndex, play])
      )
      for (const index of change.remove) plays.delete(index)
      for (const play of change.plays) plays.set(play.about.atBatIndex, play)
      const next = {
        plays: [...plays.values()].sort(
          (a, b) => a.about.atBatIndex - b.about.atBatIndex
        ),
        currentPlay:
          change.currentPlay === undefined
            ? stored.currentPlay
            : change.currentPlay
      }
      games.set(gameId, next)
      return next
    }
  }
}

/**
 * Scores into memory and nowhere else: the field preview, and the tests. A
 * game opened again from the same source picks up where it was left.
 */
export class DevelopmentScoringSource implements ScoringSource {
  readonly persistent = false
  readonly store = memoryStore()

  async open(
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[]
  ): Promise<ScoringSession> {
    return await ScoringSession.open(
      this.store,
      game.id,
      context(game, away, home)
    )
  }
}
