import type {
  GameDetail,
  Lineup,
  RosterEntry,
  TeamStationClient
} from '../../common/api'
import { type TagChoices, tagTargets } from '../../common/eventTags'
import {
  cleanAction,
  FOLD_VERSION,
  KEEPS_AT_BAT_SINCE,
  keepsAtBat,
  OVERRIDE_SLOTS_SINCE,
  type ScoringAction,
  usesOverrideSlots
} from '../../common/scoring/actions'
import {
  sameScoringMutation,
  type ScoringMutation
} from '../../common/scoring/scoringMutation'
import {
  type EventStore,
  sameAction,
  type SaveChange,
  ScoringSession,
  type SessionLog,
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
import { holdWhenOutdated, restoreHeld } from './heldScoring'
import { LocalEventTags } from './localEventTags'
import type { PreferenceStorage } from './scoringPreferenceStore'
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
   * read, and its saves sent once the swap is. `storedFirst`, for the
   * scoring screen alone: the defaults and the first read of the plays are
   * the phone's stored ones; every other caller reads the server.
   */
  open: (
    game: GameDetail,
    away: RosterEntry[],
    home: RosterEntry[],
    held?: HeldOpening,
    options?: { storedFirst?: boolean }
  ) => Promise<ScoringSession>
}

/**
 * A game opened from the copy a swap of this screen's own left, read from
 * nothing: on the web the one still out (`WebWrites.held`), on a phone the
 * documents its queue wrote swapped (`CachingClient.queueSwap`).
 */
export interface HeldOpening {
  /** The plays as the swap leaves them, its lineups digest the swap's own. */
  events: StoredGame
  /** Both teams' default lineups, by the new sides. */
  defaults: DefaultLineups
  /**
   * The web's: settles once the server took the swap, with the lineups
   * digest its answer gave the new sides (none from an older server);
   * rejects once it refused it. A phone's queue sends each save behind the
   * swap itself.
   */
  landed?: Promise<string | undefined>
  /**
   * The web's: the accepted scoring its swap was sent on, once `landed`
   * settled. A save built on the base the swapped copy opened with is
   * sent on this instead, as the changes ahead of the swap advanced it.
   */
  scoringBase?: () => ScoringMutation | null | undefined
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

/** What the queue reads of a game to judge a save an older build queued. */
export interface OlderSaveReads {
  /** Its plays as the phone holds them, with its queued saves on top. */
  held: () => Promise<StoredGame | undefined>
  /** Its plays as the server holds them now. */
  server: () => Promise<StoredGame>
}

/** Whether a stored game uses semantics that the queued save could not read. */
function foldsDiffer(stored: StoredGame, version: number): boolean {
  return [...stored.plays, stored.currentPlay].some(play => {
    const record = (play as { teamStation?: { actions?: unknown } } | null)
      ?.teamStation
    return (
      Array.isArray(record?.actions) &&
      record.actions.some(action => {
        if (version < KEEPS_AT_BAT_SINCE && keepsAtBat(action)) return true
        return version < OVERRIDE_SLOTS_SINCE && usesOverrideSlots(action)
      })
    )
  })
}

/**
 * Whether a save of plays a build of fold `foldVersion` queued may go as it was
 * queued: whether that build folded the game as this one does. A build below
 * 4 reads an end of the half that kept its at-bat as one that dropped it, so
 * in a game that holds one it puts every later play an index low, and what
 * it wrote over cannot be told from what it added. Its save is held then;
 * a build below 5 also cannot read explicit pitcher resets, batting slots
 * or their pinch-hit replacements, nor corrections with an empty mound.
 * Missing-pitcher actions are held conservatively without replaying the log.
 * In other games the folds agree. A failed
 * read of the server throws.
 */
export async function olderSaveFoldsAlike(
  foldVersion: number | null,
  reads: OlderSaveReads
): Promise<boolean> {
  const version = foldVersion ?? 0
  if (version >= FOLD_VERSION) return true
  const held = await reads.held()
  if (held != null && foldsDiffer(held, version)) return false
  return !foldsDiffer(await reads.server(), version)
}

/** What a rebuild reads of a game: from the phone's copy, but its plays. */
export interface GameReads {
  game: () => Promise<GameDetail | undefined>
  roster: (teamId: string) => Promise<RosterEntry[] | undefined>
  /**
   * Both teams' default lineups, as the scoring screen reads them: a game
   * whose plays are all still on the phone starts from them.
   */
  defaults: (game: GameDetail) => Promise<DefaultLineups>
  /** Its plays as the server holds them now. */
  server: () => Promise<StoredGame>
}

/**
 * The game as this build folds it (`ScoringSession.wholeChange`) once `log`,
 * the whole session log a build kept beside a save it queued, is played on
 * the server's plays: what is sent in place of that save, whose plays an
 * older build folded and may name at other indexes. The server's log has to
 * be where `log` began, action for action; only what follows is played.
 *
 * Null when the game or a roster is not there to read, when an action of the
 * log no longer reads, when the server's log no longer plays, is not where
 * `log` began (somebody else saved since), or refuses an action of the rest.
 * A failed read of the server throws.
 */
export async function rebuildGameEvents(
  gameId: string,
  log: SessionLog,
  reads: GameReads
): Promise<SaveChange | null> {
  const actions: ScoringAction[] = []
  for (const raw of log.actions) {
    const cleaned = cleanAction(raw)
    if ('problem' in cleaned) return null
    actions.push(cleaned.action)
  }
  const game = await reads.game()
  if (game == null) return null
  const [away, home] = await Promise.all([
    reads.roster(game.awayTeamId),
    reads.roster(game.homeTeamId)
  ])
  if (away == null || home == null) return null
  const served = await reads.server()
  // Opened as the scoring screen opens it (`ServerScoringSource.open`): a
  // game with records is rebuilt from them, and one with none starts where
  // the scorer's own session did, from the teams' defaults.
  const server = await ScoringSession.open(
    {
      load: async () => served,
      save: async () => {
        throw new Error('A rebuild saves nothing: the queue sends it')
      }
    },
    gameId,
    context(game, away, home, await reads.defaults(game), false),
    {
      requireCurrentSetup: true,
      reconcileSetup: (setup, state) =>
        reconcileRoster(
          setup,
          teamsOf(game),
          { away, home },
          game.guestPlayers,
          game.unrostered,
          appearedIn(state)
        )
    }
  )
  if (server.readOnly) return null
  const base = server.actions
  if (
    actions.length < base.length ||
    base.some((action, i) => !sameAction(action, actions[i]))
  )
    return null
  for (let i = base.length; i < actions.length; i++) {
    const time = log.times[i]
    const applied = server.apply(
      actions[i],
      typeof time === 'string' ? { time } : {}
    )
    if (applied.problems.length > 0) return null
  }
  return server.wholeChange()
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
    ),
    /** Where plays a refused save could not send wait for a newer build. */
    private readonly storage: PreferenceStorage = deviceStorage
  ) {}

  /**
   * Who is signed in, whose plays a refused save keeps on the device: set by
   * the app. With nobody, none are kept or played again.
   */
  account: string | undefined

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
    opening?: HeldOpening,
    options?: { storedFirst?: boolean }
  ): Promise<ScoringSession> {
    const client = this.client
    const storedFirst = options?.storedFirst === true
    let currentGame = game
    let rosters = { away, home }
    let first = true
    // The defaults shape only a new game: one with records is rebuilt from
    // them, whatever the defaults say now. As the scoring screen opens,
    // every read it waits on is the phone's stored one, when it has one.
    const defaults =
      opening?.defaults ?? (await defaultsOf(client, game, storedFirst))
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
        // The first read, as the scoring screen opens, is the phone's stored
        // plays; a reload after a notice, and every other open, reads the
        // server.
        let stored =
          opening != null && !later
            ? opening.events
            : await client.gameEvents(gameId, {
                storedFirst: storedFirst && !later
              })
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
        if (opening?.landed == null)
          return await client.saveGameEvents(gameId, change)
        // Behind the swap, as a phone's queue sends it; built on the swap's
        // own lineups digest, it names the one the swap's answer gave the new
        // sides, so lineups another device saved since are refused as stale.
        // An older server answers none: it is read again.
        const swapped = await opening.landed
        // Built on the accepted scoring the swapped copy opened with, it
        // names what the session's changes ahead of the swap left: the
        // first accepted timeline is the session's own, not a stale base.
        const sentBase = opening.scoringBase?.()
        const based =
          sentBase !== undefined &&
          change.scoringBase !== undefined &&
          sameScoringMutation(
            change.scoringBase,
            opening.events.scoringMutation ?? null
          )
            ? { ...change, scoringBase: sentBase }
            : change
        if (based.lineupsBase !== opening.events.lineupsDigest)
          return await client.saveGameEvents(gameId, based)
        const { lineupsBase: _swapped, ...rest } = based
        const lineupsDigest =
          swapped ?? (await client.gameEvents(gameId)).lineupsDigest
        return await client.saveGameEvents(
          gameId,
          lineupsDigest == null ? rest : { ...rest, lineupsBase: lineupsDigest }
        )
      }
    }
    const session = await ScoringSession.open(store, game.id, held.context, {
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
    // What a build too old to save left of this game on the device, for the
    // person signed in, goes on now, and what this one cannot save stays
    // there for the next.
    const account = this.account
    if (account != null) {
      await restoreHeld(session, this.storage, account)
      holdWhenOutdated(session, this.storage, account)
    }
    return session
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
