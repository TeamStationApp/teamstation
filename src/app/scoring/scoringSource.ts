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
import { appearedIn, reconcileRoster } from '../../common/scoring/startingSetup'
import { withNames } from '../../common/scoring/storedNames'
import { deviceStorage } from '../platform/deviceStorage'
import {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from './developmentSession'
import { LocalEventTags } from './localEventTags'
import { ServerClock } from './serverClock'

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
  /**
   * Keeps the clock the game's actions are stamped by in step with the
   * server's while the screen is open; the returned function stops it.
   */
  keepTime?: () => () => void
  /**
   * Opens the game. `held`, on the web after a swap of its own the server
   * has not answered: opened on the swapped copy the screen holds, never
   * read, and its saves sent once the swap is.
   */
  open: (
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[],
    held?: HeldOpening
  ) => Promise<ScoringSession>
}

/** A game opened from the copy a swap still out left (`WebWrites.held`). */
export interface HeldOpening {
  /** The plays as the swap leaves them, its lineups digest the swap's own. */
  events: StoredGame
  /** Both teams' default lineups, by the new sides. */
  defaults: DefaultLineups
  /** Settles once the server took the swap; rejects once it refused it. */
  landed: Promise<void>
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
 * side starts from its roster. `storedFirst`, for the scoring screen as it
 * opens: the phone's stored defaults, read from the server behind them.
 */
export async function defaultsOf(
  client: TeamStationClient,
  game: GameDetail,
  storedFirst = false
): Promise<DefaultLineups> {
  const load = async (teamId: string): Promise<Lineup | null> => {
    try {
      return (await client.defaultLineup(teamId, { storedFirst })).lineup
    } catch {
      return null
    }
  }
  const [away, home] = await Promise.all([
    load(game.awayTeamId),
    load(game.homeTeamId)
  ])
  return { away, home }
}

/** Scores into the server's copy of the game as it is played. */
export class ServerScoringSource implements ScoringSource {
  readonly persistent = true
  constructor(
    private readonly client: TeamStationClient,
    /** The server's clock, which every action is stamped on. */
    readonly clock = new ServerClock(
      async () => await client.serverTime(),
      deviceStorage
    )
  ) {}

  keepTime(): () => void {
    return this.clock.keepTime()
  }

  /** The phone's stored choices at once, read from the server behind them. */
  async tagChoices(): Promise<TagChoices> {
    return await this.client.tagChoices({ storedFirst: true })
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
    home: RosterEntry[],
    opening?: HeldOpening
  ): Promise<ScoringSession> {
    const client = this.client
    let currentGame = game
    let rosters = { away, home }
    let first = true
    // The defaults shape only a new game: one with records is rebuilt from
    // them, whatever the defaults say now. As the screen opens, every read
    // it waits on is the phone's stored one, when it has one.
    const defaults = opening?.defaults ?? (await defaultsOf(client, game, true))
    // The context for the game's teams as last read, rebuilt only when they
    // change: every read gives the one its teams call for, whether or not
    // the session keeps that read.
    let held = {
      home: game.homeTeamId,
      away: game.awayTeamId,
      context: context(game, away, home, defaults, false)
    }
    const store: EventStore = {
      load: async gameId => {
        const readTeams = async (game: GameDetail): Promise<void> => {
          currentGame = game
          const [away, home] = await Promise.all([
            client.roster(game.awayTeamId),
            client.roster(game.homeTeamId)
          ])
          rosters = { away, home }
        }
        const later = !first
        if (later) await readTeams(await client.game(gameId))
        first = false
        // The first read, as the screen opens, is the phone's stored plays;
        // a reload after a notice reads the server.
        let stored =
          opening != null && !later
            ? opening.events
            : await client.gameEvents(gameId, { storedFirst: !later })
        // On a reload or a rebase, the game read again after its plays: a
        // swap between the two reads would pair the swapped record with the
        // old teams. Read both again until they agree. (The screen checks
        // the first read itself, as it starts listening.)
        for (let tries = later ? 0 : 3; tries < 3; tries++) {
          const after = await client.game(gameId)
          if (
            after.homeTeamId === currentGame.homeTeamId &&
            after.awayTeamId === currentGame.awayTeamId
          )
            break
          await readTeams(after)
          stored = await client.gameEvents(gameId)
        }
        // Home and away were swapped: the record now names the new sides.
        if (
          currentGame.homeTeamId !== held.home ||
          currentGame.awayTeamId !== held.away
        )
          held = {
            home: currentGame.homeTeamId,
            away: currentGame.awayTeamId,
            context: context(
              currentGame,
              rosters.away,
              rosters.home,
              await defaultsOf(client, currentGame),
              false
            )
          }
        return { ...stored, context: held.context }
      },
      save: async (gameId, change) => {
        if (opening == null) return await client.saveGameEvents(gameId, change)
        // Behind the swap, as a phone's queue sends it; built on the swap's
        // own lineups digest, it names the one the server gave the new sides.
        await opening.landed
        if (change.lineupsBase !== opening.events.lineupsDigest)
          return await client.saveGameEvents(gameId, change)
        const { lineupsBase: _swapped, ...rest } = change
        const { lineupsDigest } = await client.gameEvents(gameId)
        return await client.saveGameEvents(
          gameId,
          lineupsDigest == null ? rest : { ...rest, lineupsBase: lineupsDigest }
        )
      }
    }
    return await ScoringSession.open(store, game.id, held.context, {
      requireCurrentSetup: true,
      now: () => this.clock.now(),
      reconcileSetup: (setup, state) =>
        reconcileRoster(
          setup,
          teamsOf(currentGame),
          rosters,
          currentGame.guestPlayers,
          currentGame.unrostered,
          appearedIn(state)
        )
    })
  }
}

/**
 * Scores into memory and nowhere else: the field preview, and the tests. A
 * game opened again from the same source picks up where it was left.
 */
/**
 * A store that keeps games in memory: the field preview, and the tests. It
 * keeps what a session saves as it is sent, in the stored form, and beside
 * each game the names the saves carried (`names`); a read answers the game
 * named from them (`withNames`), as the server names it from the accounts.
 */
export function memoryStore(
  games = new Map<string, StoredGame>(),
  names = new Map<string, Map<number, string>>()
): EventStore & {
  games: Map<string, StoredGame>
  names: Map<string, Map<number, string>>
} {
  const named = (gameId: string, stored: StoredGame): StoredGame => {
    const book = names.get(gameId) ?? new Map<number, string>()
    return {
      ...stored,
      plays: stored.plays.map(play => withNames(play, book)),
      currentPlay:
        stored.currentPlay == null
          ? stored.currentPlay
          : withNames(stored.currentPlay, book)
    }
  }
  return {
    games,
    names,
    load: async gameId =>
      named(gameId, games.get(gameId) ?? { plays: [], currentPlay: null }),
    save: async (gameId, change: SaveChange) => {
      const stored = games.get(gameId) ?? { plays: [], currentPlay: null }
      const book = names.get(gameId) ?? new Map<number, string>()
      for (const [id, name] of Object.entries(change.names ?? {}))
        book.set(Number(id), name)
      names.set(gameId, book)
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
      return named(gameId, next)
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
