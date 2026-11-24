import type { MyRoles, SeasonGame } from '../../common/api'
import { eventInfoPath } from '../../common/api'
import { HttpError } from '../../common/errors'
import type {
  GameSocketEvent,
  UserTopic,
  UserTopicListener
} from '../../common/gameSocket'
import { managesRoster } from '../../common/roles'

/** One game the server chose for this phone to keep for scoring. */
export interface OfflineManifestGame {
  id: string
  startAt: string
  homeTeamId: string
  awayTeamId: string
  started: boolean
  schedule: SeasonGame | null
}

/** What `GET /me/offline-scoring` answers. */
export interface OfflineManifestAnswer {
  games: OfflineManifestGame[]
  nextBoundary: string | null
  digest: string
}

/** A game the phone keeps, and how far its package has come. */
export interface KeptGame {
  id: string
  /** Every document stored; `staged` until then. */
  state: 'staged' | 'ready'
  /** The reads its package is, so a departure forgets them. */
  paths: string[]
}

/** What the phone keeps between launches: the games and their packages. */
export interface OfflineSetState {
  digest: string | null
  games: KeptGame[]
  /** The broad read-ahead of earlier builds has been let go. */
  upgraded: boolean
}

/** What the set asks of the phone's client and socket. */
export interface OfflineSetHost {
  manifest: (held: string[]) => Promise<OfflineManifestAnswer>
  /** Reads a document and stores it, as any read through the client does. */
  read: (path: string) => Promise<unknown>
  roles: () => Promise<MyRoles | undefined>
  /** Forgets stored documents by their reads; one a queued write holds stays. */
  forget: (paths: string[]) => Promise<void>
  /** The games of the stored schedule whose documents an earlier build kept. */
  storedGames: () => Promise<string[]>
  /** Lists these games on the stored first page of Upcoming, or of Past. */
  keepSchedule: (
    games: SeasonGame[],
    window: 'upcoming' | 'past'
  ) => Promise<void>
  loadState: () => Promise<OfflineSetState | undefined>
  saveState: (state: OfflineSetState) => Promise<void>
  /** Whether a scoring screen holds the game open now. */
  heldOpen: (gameId: string) => boolean
  subscribeGame: (
    gameId: string,
    listener: (event: GameSocketEvent) => void
  ) => () => void
  onTopic: (topic: UserTopic, listener: UserTopicListener) => () => void
  /**
   * Runs `again` once the network or the app comes back, and returns the
   * way to stop waiting (`whenBack`): a game left staged by a read that
   * failed is read then. Without it, the next choice reads it.
   */
  whenBack?: (again: () => void) => () => void
}

/** The documents a game's package is, beyond its teams'. */
function gamePaths(game: OfflineManifestGame): string[] {
  const id = encodeURIComponent(game.id)
  return [
    `/games/${id}`,
    `/games/${id}/lineups`,
    `/games/${id}/events`,
    eventInfoPath(game.id),
    `/games/${id}/plans`,
    ...(game.started ? [`/games/${id}/box-score`] : [])
  ]
}

/**
 * A team's documents: its roster as every screen reads it, the whole names
 * too where this person manages it (scoring reads those), and its default
 * lineup.
 */
function teamPaths(teamId: string, roles: MyRoles | undefined): string[] {
  const id = encodeURIComponent(teamId)
  return [
    `/teams/${id}/roster`,
    ...(managesRoster(roles, teamId)
      ? [`/teams/${id}/roster?includeFullNames=true`]
      : []),
    `/teams/${id}/default-lineup`
  ]
}

/** The sides of a game that have a roster: a placeholder opponent has none. */
function rosteredTeams(game: OfflineManifestGame): string[] {
  const external = {
    home: game.schedule?.homeTeamExternal === true,
    away: game.schedule?.awayTeamExternal === true
  }
  return [
    ...(external.home ? [] : [game.homeTeamId]),
    ...(external.away ? [] : [game.awayTeamId])
  ]
}

/** Whether the plays were scored against these lineups, as far as both say. */
function coherent(events: unknown, lineups: unknown): boolean {
  const named = (events as { lineupsDigest?: unknown } | null)?.lineupsDigest
  const digest = (lineups as { digest?: unknown } | null)?.digest
  return (
    typeof named !== 'string' || typeof digest !== 'string' || named === digest
  )
}

/** A refusal: the game's private documents are not this person's to keep. */
function refused(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.code === 'forbidden' || error.code === 'notFound')
  )
}

/** Whether a game's planned documents are the ones it keeps. */
function samePaths(planned: string[] | undefined, kept: string[]): boolean {
  return (
    planned?.length === kept.length &&
    planned.every((path, index) => path === kept[index])
  )
}

/**
 * The games a phone keeps to score with no signal: at most three, as the
 * server chooses them (`GET /me/offline-scoring`), each with every document
 * needed to find it on Schedule, open it and score it though it was never
 * opened online.
 *
 * It reads the choice when it starts, when the person's `offlineSet` topic
 * says it changed (a role, a game moving, the window's own boundary), after a
 * gap in the socket, and once in an outage. An unchanged choice whose
 * packages are ready reads nothing more. A game that leaves loses its
 * subscription first, then a new one is taken; its documents are forgotten
 * unless another kept game shares them, a queued write holds them, or a
 * scoring screen has it open. Each kept game is subscribed on the shared
 * socket, and a change reads again only the document it names.
 *
 * Every read runs against the account the set started for: `stop` ends it,
 * and a late answer after that is let go.
 */
export class OfflineScoringSet {
  private state: OfflineSetState = { digest: null, games: [], upgraded: false }
  private readonly subscriptions = new Map<string, () => void>()
  private stopTopic: (() => void) | undefined
  private running = false
  private again = false
  private live = true
  private lastOutage: number | undefined
  /** Stops waiting to read again a game a failed read left staged. */
  private stopWaiting: (() => void) | undefined
  /** Whether this launch has read again what an earlier one kept ready. */
  private readSinceLaunch = false
  private roles: MyRoles | undefined
  /** Each kept game's manifest entry, for its documents. */
  private readonly entries = new Map<string, OfflineManifestGame>()
  readonly started: Promise<void>

  constructor(private readonly host: OfflineSetHost) {
    this.started = this.start()
  }

  /** Where a game's package is: ready, staged, or not kept. */
  status(gameId: string): 'ready' | 'staged' | 'none' {
    return this.state.games.find(game => game.id === gameId)?.state ?? 'none'
  }

  /** The games kept, in the server's order. */
  get kept(): KeptGame[] {
    return this.state.games
  }

  /** Lets everything go: an account change or sign-out. Nothing is forgotten. */
  stop(): void {
    this.live = false
    this.stopTopic?.()
    this.stopTopic = undefined
    this.stopWaiting?.()
    this.stopWaiting = undefined
    for (const release of this.subscriptions.values()) release()
    this.subscriptions.clear()
  }

  /** Reads the choice again, once, after any read under way. */
  async reconcile(): Promise<void> {
    if (!this.live) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        await this.reconcileOnce()
      } while (this.again && this.live)
    } finally {
      this.running = false
    }
    // A game a read left staged, while the socket stays up, has no notice
    // coming: it is read again once the network or the app comes back.
    if (
      this.live &&
      this.stopWaiting == null &&
      this.host.whenBack != null &&
      this.state.games.some(game => game.state === 'staged')
    )
      this.stopWaiting = this.host.whenBack(() => {
        this.stopWaiting = undefined
        this.reconcile().catch(() => undefined)
      })
  }

  private async start(): Promise<void> {
    const kept = await this.host.loadState().catch(() => undefined)
    if (!this.live) return
    if (kept != null) this.state = kept
    try {
      this.stopTopic = this.host.onTopic('offlineSet', event => {
        if (event.type === 'subscribed' && !event.afterGap) return
        if (event.type === 'unreachable') {
          if (this.lastOutage === event.outage) return
          this.lastOutage = event.outage
        }
        this.reconcile().catch(() => undefined)
      })
    } catch {
      // No socket to be had: the first read is all there is.
    }
    await this.reconcile()
  }

  private async reconcileOnce(): Promise<void> {
    const held = this.state.games.map(game => game.id)
    let answer: OfflineManifestAnswer
    try {
      answer = await this.host.manifest(held)
    } catch {
      // No answer: what is kept stays kept, ready or not.
      return
    }
    if (!this.live) return
    const chosen = answer.games.slice(0, 3)
    const chosenIds = new Set(chosen.map(game => game.id))
    for (const game of chosen) this.entries.set(game.id, game)
    // The person's roles name the team documents each game keeps; without
    // them, what is kept stays kept.
    let roles: MyRoles | undefined
    try {
      roles = await this.host.roles()
    } catch {
      for (const game of this.state.games)
        if (chosenIds.has(game.id)) this.follow(game.id)
      return
    }
    if (!this.live) return
    this.roles = roles
    const keptPaths = new Set<string>()
    const plan = new Map<string, string[]>()
    for (const game of chosen) {
      const paths = [
        ...gamePaths(game),
        ...rosteredTeams(game).flatMap(teamId => teamPaths(teamId, roles))
      ]
      plan.set(game.id, paths)
      for (const path of paths) keptPaths.add(path)
    }
    // A kept game stays ready while it keeps the same documents: another
    // game starting, or moving, reads nothing of it; its own teams changing
    // reads it again.
    const keepsReady = (game: KeptGame): boolean =>
      game.state === 'ready' && samePaths(plan.get(game.id), game.paths)
    const unchanged =
      answer.digest === this.state.digest &&
      this.state.games.length === chosen.length &&
      this.state.games.every(game => chosenIds.has(game.id) && keepsReady(game))
    if (unchanged && this.state.upgraded) {
      for (const game of chosen) this.follow(game.id)
      await this.readAgainAfterLaunch(this.state.games)
      return
    }
    // Departures first, so no more than three are ever held.
    const departing = this.state.games.filter(game => !chosenIds.has(game.id))
    const staying = this.state.games.filter(game => chosenIds.has(game.id))
    for (const game of departing) {
      this.subscriptions.get(game.id)?.()
      this.subscriptions.delete(game.id)
    }
    const leaving = departing
      .filter(game => !this.host.heldOpen(game.id))
      .flatMap(game => game.paths)
      .filter(path => !keptPaths.has(path))
    if (leaving.length > 0) await this.host.forget(leaving)
    if (!this.state.upgraded) {
      // An earlier build read ahead every game it listed: those not chosen
      // are let go once, with nothing read for them.
      const stored = await this.host.storedGames().catch(() => [])
      const legacy = stored
        .filter(gameId => !chosenIds.has(gameId) && !this.host.heldOpen(gameId))
        .flatMap(gameId => {
          const id = encodeURIComponent(gameId)
          return [
            `/games/${id}`,
            `/games/${id}/lineups`,
            `/games/${id}/events`,
            eventInfoPath(gameId),
            `/games/${id}/plans`,
            `/games/${id}/box-score`
          ]
        })
        .filter(path => !keptPaths.has(path))
      if (legacy.length > 0) await this.host.forget(legacy)
    }
    if (!this.live) return
    const games: KeptGame[] = chosen.map(game => {
      const kept = staying.find(other => other.id === game.id)
      return {
        id: game.id,
        state: kept != null && keepsReady(kept) ? 'ready' : 'staged',
        paths: plan.get(game.id)!
      }
    })
    this.state = { digest: answer.digest, games, upgraded: true }
    await this.host.saveState(this.state)
    await this.readAgainAfterLaunch(
      games.filter(game => game.state === 'ready')
    )
    if (!this.live) return
    // Each game is listed where Schedule looks for it with no signal.
    const upcoming = chosen.flatMap(game =>
      game.schedule != null && !game.started ? [game.schedule] : []
    )
    const past = chosen.flatMap(game =>
      game.schedule != null && game.started ? [game.schedule] : []
    )
    if (upcoming.length > 0)
      await this.host.keepSchedule(upcoming, 'upcoming').catch(() => undefined)
    if (past.length > 0)
      await this.host.keepSchedule(past, 'past').catch(() => undefined)
    // A document shared by two games is read once.
    const read = new Map<string, Promise<boolean>>()
    const bodies = new Map<string, unknown>()
    const readOnce = async (path: string): Promise<boolean> => {
      let reading = read.get(path)
      if (reading == null) {
        reading = this.host.read(path).then(
          body => {
            bodies.set(path, body)
            return true
          },
          (error: unknown) => {
            // A team's document this person may not read (an opponent's
            // default lineup) is none online too: nothing to keep.
            if (refused(error) && path.startsWith('/teams/')) return true
            if (refused(error)) throw error
            return false
          }
        )
        read.set(path, reading)
      }
      return await reading
    }
    for (const game of games) {
      if (!this.live) return
      this.follow(game.id)
      if (game.state === 'ready') continue
      let whole = true
      try {
        for (const path of game.paths) whole = (await readOnce(path)) && whole
        // The plays name the lineups they were scored against: lineups read
        // before a save of the plays landed are read once more.
        const id = encodeURIComponent(game.id)
        const lineups = `/games/${id}/lineups`
        if (
          whole &&
          !coherent(bodies.get(`/games/${id}/events`), bodies.get(lineups))
        )
          whole = await this.host.read(lineups).then(
            body => coherent(bodies.get(`/games/${id}/events`), body),
            () => false
          )
      } catch {
        // Refused: none of its private documents are this person's to keep,
        // save a team's that another kept game still lists.
        const others = new Set(
          games.filter(other => other !== game).flatMap(other => other.paths)
        )
        await this.host
          .forget(game.paths.filter(path => !others.has(path)))
          .catch(() => undefined)
        whole = false
      }
      if (!this.live) return
      game.state = whole ? 'ready' : 'staged'
      await this.host.saveState(this.state)
    }
  }

  /**
   * Reads once more, on the first choice after a launch, every document of
   * the games kept ready before it: what changed while the app was closed
   * sent no notice to it, and a first connection asks no `resync`. A game a
   * scoring screen has is that screen's.
   */
  private async readAgainAfterLaunch(ready: KeptGame[]): Promise<void> {
    if (this.readSinceLaunch) return
    this.readSinceLaunch = true
    const paths = new Set(
      ready
        .filter(game => !this.host.heldOpen(game.id))
        .flatMap(game => game.paths)
    )
    await Promise.all(
      [...paths].map(async path => {
        await this.host.read(path).catch(() => undefined)
      })
    )
  }

  /** Subscribes a kept game, once, and reads again what its changes name. */
  private follow(gameId: string): void {
    if (this.subscriptions.has(gameId) || !this.live) return
    let release: (() => void) | undefined
    try {
      release = this.host.subscribeGame(gameId, event => {
        this.changed(gameId, event)
      })
    } catch {
      return
    }
    this.subscriptions.set(gameId, release)
  }

  /** A kept game's change: the one document it names is read again. */
  private changed(gameId: string, event: GameSocketEvent): void {
    const entry = this.entries.get(gameId)
    const kept = this.state.games.find(game => game.id === gameId)
    if (entry == null || kept == null || !this.live) return
    // A scoring screen open on it follows the game itself.
    if (this.host.heldOpen(gameId)) return
    const id = encodeURIComponent(gameId)
    const paths: string[] = []
    if (event.type === 'resync')
      paths.push(`/games/${id}`, `/games/${id}/lineups`, `/games/${id}/events`)
    if (event.type === 'change')
      switch (event.kind) {
        case 'game':
          paths.push(`/games/${id}`)
          break
        case 'lineups':
          paths.push(`/games/${id}/lineups`)
          break
        case 'playEdits':
          paths.push(`/games/${id}/events`)
          break
        case 'plans':
          paths.push(`/games/${id}/plans`)
          break
        case 'roster':
        case 'defaultLineup': {
          const team = teamPaths(event.data.teamId, this.roles)
          paths.push(
            ...(event.kind === 'roster'
              ? team.filter(path => path.includes('/roster'))
              : team.filter(path => path.endsWith('/default-lineup')))
          )
          break
        }
        default:
          break
      }
    for (const path of paths)
      if (kept.paths.includes(path)) this.host.read(path).catch(() => undefined)
  }
}
