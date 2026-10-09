import type {
  GameDetail,
  Lineup,
  RosterEntry,
  TeamStationClient
} from '../../common/api'
import { type TagChoices, tagTargets } from '../../common/eventTags'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from './developmentSession'
import { LocalEventTags } from './localEventTags'

/** Where the scoring screen's game comes from and is kept. */
export interface ScoringSource {
  tagChoices?: (userId: string) => Promise<TagChoices>
  saveTag?: (
    game: ScoringSession,
    targetId: string,
    tag: string | null,
    userId: string
  ) => Promise<{ targetId: string; tag: string | null; revision: string }>
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
  home: RosterEntry[],
  defaults: DefaultLineups = {},
  fillRoster = true
): Parameters<typeof ScoringSession.open>[2] {
  return {
    gamePk: game.id,
    teams: teamsOf(game),
    setup: startingSetup(game, away, home, defaults, fillRoster),
    fenceDistanceFt: game.fenceDistanceFt
  }
}

/**
 * Both teams' default lineups. A default that fails to load is none, so the
 * side starts from its roster.
 */
async function defaultsOf(
  client: TeamStationClient,
  game: GameDetail
): Promise<DefaultLineups> {
  const load = async (teamId: string): Promise<Lineup | null> =>
    await client
      .defaultLineup(teamId)
      .then(found => found.lineup)
      .catch(() => null)
  const [away, home] = await Promise.all([
    load(game.awayTeamId),
    load(game.homeTeamId)
  ])
  return { away, home }
}

/** Scores into the server's copy of the game as it is played. */
export class ServerScoringSource implements ScoringSource {
  readonly persistent = true
  constructor(private readonly client: TeamStationClient) {}

  async tagChoices(): Promise<TagChoices> {
    return await this.client.tagChoices()
  }

  async saveTag(
    game: ScoringSession,
    targetId: string,
    tag: string | null
  ): Promise<{ targetId: string; tag: string | null; revision: string }> {
    return await this.client.saveEventTag(game.gameId, targetId, tag)
  }

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
    // The defaults shape only a new game: one with records is rebuilt from
    // them, whatever the defaults say now.
    const defaults = await defaultsOf(client, game)
    return await ScoringSession.open(
      store,
      game.id,
      context(game, away, home, defaults, false),
      { requireCurrentSetup: true }
    )
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
  readonly tags = new LocalEventTags()

  async tagChoices(userId: string): Promise<TagChoices> {
    for (const [gameId, stored] of this.store.games) {
      this.tags.retain(
        gameId,
        [
          ...stored.plays.filter(
            play =>
              play.about.atBatIndex !== stored.currentPlay?.about.atBatIndex
          ),
          ...(stored.currentPlay == null ? [] : [stored.currentPlay])
        ]
          .flatMap(tagTargets)
          .map(target => target.id)
      )
    }
    return this.tags.choices(userId)
  }

  async saveTag(
    game: ScoringSession,
    targetId: string,
    tag: string | null,
    userId: string
  ): Promise<{ targetId: string; tag: string | null; revision: string }> {
    const label = this.tags.save(userId, game.gameId, targetId, tag)
    const stored = this.store.games.get(game.gameId)
    if (stored != null)
      this.store.games.set(game.gameId, {
        plays: stored.plays.map(play => this.tags.decorate(game.gameId, play)),
        currentPlay:
          stored.currentPlay == null
            ? null
            : this.tags.decorate(game.gameId, stored.currentPlay)
      })
    return { targetId, tag: label, revision: this.tags.revision }
  }

  async open(
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[]
  ): Promise<ScoringSession> {
    return await ScoringSession.open(
      this.store,
      game.id,
      context(game, away, home),
      { requireCurrentSetup: true }
    )
  }
}
