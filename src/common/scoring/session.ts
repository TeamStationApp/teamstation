import { HttpError } from '../errors'
import {
  historyTargets,
  type TagDocument,
  TagIdentityRegistry,
  type TagTarget,
  tagTargets
} from '../eventTags'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { Problem, ScoringAction } from './actions'
import { keyOf, matchTimes, REPLACED_KEEPS_TIME_MS } from './actionTimes'
import { type Applied, applyAction } from './apply'
import { fenceOf, foldInputsOf, type PlayFolder } from './document'
import {
  FINAL_INDEX,
  foldFinal,
  playFolder,
  replayPlays,
  type Segment,
  segmentAfter
} from './gumbo'
import { reconcileShownLineup } from './lineupHistory'
import { awaitingResult, nextDecision } from './rules'
import {
  copyGame,
  type GamePlay,
  type GameSetup,
  type GameState,
  type GameTeam,
  setupOf,
  type Side
} from './state'

/**
 * A game being scored, and kept on the server as it is scored.
 *
 * The session holds the log of actions and the game they make. `apply` is
 * synchronous and optimistic: it returns the new game at once and schedules a
 * save. A save posts only what changed since the last one the server
 * acknowledged — in practice the current play and the play that just ended —
 * and a save asked for while one is in flight becomes one follow-up post.
 * Offline, the changes wait and the session tries again; refused, it stops,
 * says why, and goes back to the game the server holds.
 */

/**
 * The step a session takes for each action. A screen that keeps its own
 * history applies actions with it to its own copy of the game, and then
 * brings its session into line with `sync`.
 */
export { type Applied, applyAction }

/**
 * The game as the next action will find it. A decided play stays open for
 * correction until the next pitch or play is reported, which closes it, so
 * what comes next is about the next at-bat: its batter, its count, its
 * runners. `closed` describes the play that closed.
 */
export function upcoming(session: GameState): {
  state: GameState
  closed?: string
} {
  if (nextDecision(session) !== 'close') return { state: session }
  const applied = applyAction(session, { type: 'gameFlow', kind: 'closePlay' })
  if (applied.problems.length > 0) return { state: session }
  const play = session.liveData.plays.currentPlay
  return {
    state: applied.state,
    closed: play == null ? 'the last play' : play.result.description
  }
}

export interface StoredGame {
  plays: GumboPlay[]
  currentPlay: CurrentPlay | null
  /**
   * The digest the server keeps of the game's lineups, as it read them or as
   * this save left them: what the next save names as its `lineupsBase`.
   * Absent from a store that keeps none.
   */
  lineupsDigest?: string
  /** A digest of the stored plays and the at-bat in progress, as read or left. */
  playsDigest?: string
  /** On a save's answer, the same digest of the game as the save found it. */
  priorPlaysDigest?: string
  /**
   * The game's play generation, one more after each reset: a save naming
   * another is refused. Absent from a store that keeps none.
   */
  generation?: number
  /**
   * The context to replay with when the game's teams are no longer the ones
   * the session was opened with, as after a swap of home and away; absent
   * while they are, and from every store that cannot tell.
   */
  context?: SessionContext
}
export interface SaveChange {
  plays: GumboPlay[]
  remove: number[]
  currentPlay?: CurrentPlay | null
  /**
   * The fence, in feet, the plays were sized by: the game's
   * `gameData.venue.fieldInfo.center`, or the default for a game saved
   * without one. The game's first plays fix it there.
   */
  fenceDistanceFt?: number
  /**
   * The lineups digest the change was built on. A store whose lineups have
   * moved on since refuses the change as stale (409, `details.stale`).
   */
  lineupsBase?: string
  /**
   * The play generation the session opened the game on: a store whose game
   * was reset since refuses the change (409, `details.generation`).
   */
  generation?: number
}
/** Where a session reads and writes its game. It does no I/O of its own. */
export interface EventStore {
  load: (gameId: string) => Promise<StoredGame>
  save: (gameId: string, change: SaveChange) => Promise<StoredGame>
}
export interface SessionContext {
  gamePk: string
  teams: Record<Side, GameTeam>
  /** The lineups to start from when nothing has been scored yet. */
  setup: GameSetup
  /**
   * Feet from home plate to the fence, which sizes where the scorer puts the
   * ball. `DEFAULT_FENCE_DISTANCE_FT` when not given.
   */
  fenceDistanceFt?: number
}
export interface SessionOptions {
  /** Live availability is staged on read and written with the next scoring change. */
  reconcileSetup?: (setup: GameSetup) => GameSetup
  /** Live scorekeeping requires current setup; record replay remains compatible. */
  requireCurrentSetup?: boolean
  now?: () => Date
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30000
/** How many times one save reads the game again over lineups that moved. */
const STALE_REBASES = 3

/** How many of its own digests a session remembers, for late echoes. */
const HELD_DIGESTS = 20

/** `list` with `digest` last, keeping the newest few. */
function held(list: readonly string[], digest: string): string[] {
  return [...list.filter(each => each !== digest), digest].slice(-HELD_DIGESTS)
}

/** A save refused because the lineups it was built on have moved on. */
function stale(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.code === 'conflict' &&
    (error.details as { stale?: unknown } | undefined)?.stale === true
  )
}

/** The generation a stale refusal names, when it names one. */
function refusedGeneration(error: unknown): number | undefined {
  if (!stale(error)) return undefined
  const generation = ((error as HttpError).details as { generation?: unknown })
    .generation
  return typeof generation === 'number' ? generation : undefined
}

interface Completed {
  play: GamePlay
  segment: Segment
}

/**
 * Where the log stood just after an action that finished a play: enough to
 * pick the game up there again without applying everything before it.
 */
interface Mark {
  logLength: number
  game: GameState
  completed: number
  segment: Segment
}

/**
 * Whether two actions say the same, whatever order their keys are in: the
 * one written-out form `keyOf` gives, and keeps, for each action.
 */
function sameAction(a: ScoringAction, b: ScoringAction): boolean {
  return a === b || keyOf(a) === keyOf(b)
}

/**
 * The actions the last cut took off the log (an Undo, or a sync cutting back),
 * with their times, which the actions applied after it are matched against.
 */
interface Displaced {
  /** The length the cut left the log at, where the actions applied since begin. */
  at: number
  /** Each displaced action written out, as `sync` compares them. */
  keys: string[]
  times: Array<string | undefined>
  playbackTimes: Array<string | undefined>
  /** When each displaced action was cut off. */
  cutAt: string[]
  /** How many of the first displaced actions this cut took off. */
  cut: number
  /** When each action applied since the cut was applied. */
  stamped: string[]
  /** How many of the first actions applied since came in the sync that cut. */
  replayed: number
  /** How many of the displaced actions the last match used or passed. */
  consumed: number
}

/** A folded play as the server is sent it, written out once per play. */
const writtenPlays = new WeakMap<GumboPlay, string>()
function written(play: GumboPlay): string {
  let text = writtenPlays.get(play)
  if (text == null) {
    text = JSON.stringify(play)
    writtenPlays.set(play, text)
  }
  return text
}

export class ScoringSession {
  private log: ScoringAction[] = []
  /**
   * When each action of `log` was taken, on the session's clock, in the same
   * order: undefined for one read back from a play scored before actions
   * carried times. Each play's own times are kept apart, in `times`.
   */
  private actionTimes: Array<string | undefined> = []
  private playbackTimes: Array<string | undefined> = []
  /** What the last cut displaced, while the actions after it are matched. */
  private displaced: Displaced | null = null
  /** Set while `sync` applies a run of actions, which it matches once. */
  private holding = false
  private tagIdentities = new TagIdentityRegistry()
  private tagSnapshot = 0
  private readonly importedDocuments = new Map<number, GumboPlay>()
  /** The log as far as the server has acknowledged it. */
  private savedLog: ScoringAction[] = []
  private savedTimes: Array<string | undefined> = []
  private savedPlaybackTimes: Array<string | undefined> = []
  private game: GameState
  private completed: Completed[] = []
  private segment: Segment
  /**
   * One per play the log finishes, in order. An Undo or a sync rebuilds the
   * game from the newest one the shorter log still reaches, rather than from
   * the start: from there it applied every action of the game again, about
   * 0.8 s on a phone 70 plate appearances in.
   */
  private marks: Mark[] = []
  /** Counts every change to what `picture` folds, so it folds only once per change. */
  private revision = 0

  private folded: {
    revision: number
    picture: { plays: Map<number, GumboPlay>; current: CurrentPlay | null }
  } | null = null

  /**
   * The completed plays folded so far, and a folder carried past them, so
   * the next fold folds only the plays completed since (`fold`).
   */
  private foldedPlays: {
    inputs: string
    count: number
    last: Completed | undefined
    plays: Map<number, GumboPlay>
    folder: PlayFolder
    /** How many actions of the log those plays hold. */
    covered: number
  } | null = null

  private readonly times = new Map<number, { start?: string; end?: string }>()
  /** What the server acknowledged, per index. */
  private readonly posted = new Map<number, string>()
  private postedCurrent: string | null = null
  /** Indexes of plays this session scored that the server holds. */
  private readonly stored = new Set<number>()
  /** Plays TeamStation did not score, which it never writes or removes. */
  private readonly derivedIndexes = new Set<number>()
  private readonly listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private timer: unknown = null
  private retryMs = FIRST_RETRY_MS
  private blocked = false
  /** Closed for good: nothing more is saved from it. */
  private closed = false
  private swapLost = 0
  private refusal: string | null = null
  private failure: string | null = null
  private isOffline = false
  private readonly now: () => Date
  private readActions = new WeakSet<ScoringAction>()
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  /** What `open` read the game with, so `reload` can read it again. */
  private context: SessionContext | null = null
  /**
   * The lineups digest of the server's copy as this session last read or
   * saved it: the base each save names, so a save built on lineups somebody
   * else has saved over since is refused rather than written over them.
   */
  private lineupsBase: string | undefined
  /**
   * The digests of the server's plays, and of its lineups, that this session
   * has read or saved itself, newest last: a notice of one of them is its own
   * echo. A save that found the game as somebody else left it holds none of
   * the plays until the game is read again.
   */
  private heldPlays: string[] = []
  private heldLineups: string[] = []
  /** The play generation this session opened the game on, if it has one. */
  private openedGeneration: number | undefined
  /** The game's plays were reset under this session: it saves nothing more. */
  private isReplaced = false
  /** Counts each time a save took the server's copy up under its own changes. */
  private rebaseCount = 0
  /** What a rebase could not keep of this session's own changes, and why. */
  private dropped: string | null = null

  private constructor(
    private readonly store: EventStore,
    readonly gameId: string,
    private base: GameState,
    private readonly options: SessionOptions
  ) {
    this.game = base
    this.segment = { setupBefore: setupOf(base), actions: [] }
    this.now = options.now ?? (() => new Date())
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer =
      options.clearTimer ??
      (handle => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
  }

  /**
   * A session over a game that starts where `game` stands, with nothing
   * scored in it yet: a practice game, or a test.
   */
  static start(
    store: EventStore,
    gameId: string,
    game: GameState,
    options: SessionOptions = {}
  ): ScoringSession {
    const session = new ScoringSession(store, gameId, game, options)
    session.postedCurrent = JSON.stringify(session.picture().current)
    return session
  }

  /** Reads the game back from the store and picks it up where it was left. */
  static async open(
    store: EventStore,
    gameId: string,
    context: SessionContext,
    options: SessionOptions = {}
  ): Promise<ScoringSession> {
    const loaded = await store.load(gameId)
    const replayed = replayPlays(loaded, loaded.context ?? context)
    const session = new ScoringSession(store, gameId, replayed.base, options)
    session.context = loaded.context ?? context
    session.lineupsBase = loaded.lineupsDigest
    session.openedGeneration = loaded.generation
    session.heldPlays = loaded.playsDigest == null ? [] : [loaded.playsDigest]
    session.heldLineups =
      loaded.lineupsDigest == null ? [] : [loaded.lineupsDigest]
    const reopened = loaded.currentPlay?.about.atBatIndex
    const plays = loaded.plays
      .filter(play => play.about.atBatIndex !== reopened)
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
    plays
      .slice(0, replayed.derived)
      .forEach(play => session.derivedIndexes.add(play.about.atBatIndex))
    for (const play of [...loaded.plays, loaded.currentPlay]) {
      if (play == null) continue
      const about = play.about as { startTime?: unknown; endTime?: unknown }
      session.times.set(play.about.atBatIndex, {
        start:
          typeof about.startTime === 'string' ? about.startTime : undefined,
        end: typeof about.endTime === 'string' ? about.endTime : undefined
      })
    }
    for (const play of [...loaded.plays, loaded.currentPlay]) {
      if (play == null) continue
      session.tagIdentities.restore(play)
    }
    for (const play of loaded.plays) {
      if (session.derivedIndexes.has(play.about.atBatIndex))
        session.importedDocuments.set(
          play.about.atBatIndex,
          session.tagIdentities.decorate(play, true)
        )
    }
    session.log = replayed.segments.flatMap(segment => segment.actions)
    // Loaded actions keep the times they were taken at, so a reload or a
    // replay never stamps history again.
    session.actionTimes = replayed.segments.flatMap(
      segment => segment.actionTimes
    )
    session.playbackTimes = replayed.segments.flatMap(
      segment => segment.playbackTimes ?? segment.actionTimes
    )
    session.rebuild()
    if (replayed.problems.length === 0) session.reconcileCurrent()
    session.savedLog = [...session.log]
    session.savedTimes = [...session.actionTimes]
    session.savedPlaybackTimes = [...session.playbackTimes]
    for (const play of loaded.plays)
      if (!session.derivedIndexes.has(play.about.atBatIndex))
        session.stored.add(play.about.atBatIndex)
    const picture = session.picture()
    for (const [index, play] of picture.plays)
      if (session.stored.has(index))
        session.posted.set(index, JSON.stringify(play))
    session.postedCurrent = JSON.stringify(picture.current)
    // A game read back only in part is shown and never written: saving it
    // would remove the plays that could not be read.
    if (replayed.problems.length > 0)
      session.refusal = `Some saved plays could not be read back: ${replayed.problems[0].message}`
    return session
  }

  get state(): GameState {
    return this.game
  }

  /** Every action this session has applied, in order. */
  get actions(): readonly ScoringAction[] {
    return this.log
  }

  /** Specific Gumbo events available for annotation, in chronological order. */
  get eventTargets(): TagTarget[] {
    const picture = this.picture()
    const documents = [
      ...this.importedDocuments.values(),
      ...picture.plays.values(),
      ...(picture.current == null ? [] : [picture.current])
    ]
    return documents
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
      .flatMap(tagTargets)
  }

  get historyTargets(): TagTarget[] {
    const picture = this.picture()
    return [
      ...this.importedDocuments.values(),
      ...picture.plays.values(),
      ...(picture.current == null ? [] : [picture.current])
    ]
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
      .flatMap(historyTargets)
  }

  /** Annotate the state a screen resumed, without discarding stored actions. */
  historyTargetsFor(state: GameState): TagTarget[] {
    if (state === this.game) return this.historyTargets
    const picture = this.picture()
    const index = state.liveData.plays.allPlays.length
    const documents: TagDocument[] = [
      ...this.importedDocuments.values(),
      ...picture.plays.values()
    ].filter(play => state.final || play.about.atBatIndex < index)
    if (!state.final) {
      const source =
        picture.current?.about.atBatIndex === index
          ? picture.current
          : (picture.plays.get(index) ?? this.importedDocuments.get(index))
      const identities = new TagIdentityRegistry()
      if (source != null) identities.restore(source)
      const folder =
        this.foldedPlays?.folder.continuing(state) ?? playFolder(state)
      documents.push(
        identities.decorate(
          folder.current(state.liveData.plays.currentPlay, this.segment),
          false
        )
      )
    }
    return documents
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
      .flatMap(historyTargets)
  }

  /** Changes when an accepted tag acknowledgment or reload replaces tag state. */
  get tagSnapshotVersion(): number {
    return this.tagSnapshot
  }

  /** Read one authoritative label without replacing scoring actions or Undo. */
  async readEventTag(targetId: string): Promise<string | null | undefined> {
    const stored = await this.store.load(this.gameId)
    return [
      ...stored.plays.filter(
        play => play.about.atBatIndex !== stored.currentPlay?.about.atBatIndex
      ),
      ...(stored.currentPlay == null ? [] : [stored.currentPlay])
    ]
      .flatMap(tagTargets)
      .find(target => target.id === targetId)?.tag
  }

  /** Acknowledged annotations change no scoring action or Undo step. */
  setEventTag(targetId: string, tag: string | null): boolean {
    const before = this.picture()
    const acknowledged = new Set(
      [...before.plays]
        .filter(([index, play]) => this.posted.get(index) === written(play))
        .map(([index]) => index)
    )
    const currentAcknowledged =
      this.postedCurrent === JSON.stringify(before.current)
    if (!this.tagIdentities.setTag(targetId, tag)) return false
    this.tagSnapshot++
    this.revision++
    const picture = this.picture()
    for (const [index, document] of this.importedDocuments)
      this.importedDocuments.set(
        index,
        this.tagIdentities.decorate(document, true)
      )
    // Scoring can continue after an editor is dismissed while its request is
    // in flight. A tag acknowledgment never acknowledges those newer actions.
    for (const [index, play] of picture.plays)
      if (acknowledged.has(index)) this.posted.set(index, written(play))
    if (currentAcknowledged)
      this.postedCurrent = JSON.stringify(picture.current)
    this.notify()
    return true
  }

  /** The game before any of its actions: `actions` played on it is `state`. */
  get opening(): GameState {
    return this.base
  }

  /**
   * Where a screen picks the game up: the game as it stands, or, when it was
   * left with a ball in play still waiting for its result, the game at the
   * pitch before it. The session itself does not change, so nothing is saved
   * until the scorer does something from there.
   */
  resumable(): { state: GameState; actions: ScoringAction[] } {
    let actions = [...this.log]
    let state = this.game
    while (actions.length > 0 && awaitingResult(state)) {
      actions = actions.slice(0, -1)
      state = this.base
      for (const action of actions)
        state = applyAction(state, action, { replay: true }).state
    }
    // An unfinished play cannot accept a roster action. Once the screen
    // rewinds it, present today's available players there too, without
    // changing the stored play until the scorer makes another change.
    if (state !== this.game) {
      const before = setupOf(state)
      const setup = this.options.reconcileSetup?.(before)
      if (setup != null && JSON.stringify(setup) !== JSON.stringify(before)) {
        const action: ScoringAction = { type: 'lineup', kind: 'roster', setup }
        const applied = applyAction(state, action)
        if (applied.problems.length === 0) {
          state = applied.state
          actions.push(action)
          this.readActions.add(action)
        }
      }
    }
    return { state, actions }
  }

  /** Changes made here that the server has not acknowledged. */
  get pending(): number {
    const change = this.change()
    return (
      change.plays.length +
      change.remove.length +
      (change.currentPlay === undefined ? 0 : 1)
    )
  }

  /**
   * The stored plays this session does not produce, which its next save
   * removes: a play undone, or a row its log does not make at all.
   */
  get removals(): number[] {
    return this.change().remove
  }

  /**
   * The current play holds an action — a pitch, a runner, a lineup change —
   * so the game cannot end until it is finished or undone. The close that
   * finished the last play is logged with this one but is not part of it.
   */
  get atBatOpen(): boolean {
    return (
      !this.game.final &&
      this.segment.actions.some(
        action => !(action.type === 'gameFlow' && action.kind === 'closePlay')
      )
    )
  }

  /**
   * A save is on its way to the server, so `reload()` would decline. The
   * session tells its listeners when it stops.
   */
  get saving(): boolean {
    return this.running != null
  }

  /** The last save never left the device; it will be tried again. */
  get offline(): boolean {
    return this.isOffline
  }

  /** The server refused to be written to, and said why. */
  get readOnly(): boolean {
    return this.refusal != null
  }

  get problem(): string | null {
    return this.refusal ?? this.failure ?? this.dropped
  }

  /**
   * Whether the server's plays with this digest (a `plays` notice's) are ones
   * this session read or saved itself, so reading them again changes nothing.
   */
  holdsPlays(digest: string): boolean {
    return this.heldPlays.includes(digest)
  }

  /** Whether the server's lineups with this digest are ones this session read or saved. */
  holdsLineups(digest: string): boolean {
    return this.heldLineups.includes(digest)
  }

  /**
   * Counts the times a save found that somebody else had saved the lineups
   * since this session read them, and so read the server's copy again and
   * put this session's unsaved changes back on top of it. A screen that
   * keeps its own copy of the log starts again from `actions` when it moves.
   */
  get rebases(): number {
    return this.rebaseCount
  }

  /** Changes of this session's a rebase dropped because home and away were swapped. */
  get lostToSwap(): number {
    return this.swapLost
  }

  /** The play generation the session opened the game on, if it has one. */
  get generation(): number | undefined {
    return this.openedGeneration
  }

  /**
   * True once a save was refused because the game's plays were reset since
   * this session opened it: nothing more is saved, nor taken up under the
   * reset game, and the screen opens the game again.
   */
  get replaced(): boolean {
    return this.isReplaced
  }

  /**
   * Saves nothing more: the screen that held it moved on to another read of
   * the game, as after a swap of home and away, whose sides this session's
   * unsaved changes no longer name. A save already on its way finishes.
   */
  close(): void {
    this.closed = true
    if (this.timer != null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  apply(action: ScoringAction): Applied {
    return this.append(action, true)
  }

  private append(action: ScoringAction, save: boolean): Applied {
    if (this.refusal != null) {
      return {
        state: this.game,
        transitions: [],
        play: this.game.liveData.plays.currentPlay,
        problems: [{ code: 'notNow', message: this.refusal }]
      }
    }
    if (
      action.type === 'gameFlow' &&
      action.kind === 'endGame' &&
      this.atBatOpen &&
      this.game.pending == null
    )
      return {
        state: this.game,
        transitions: [],
        play: this.game.liveData.plays.currentPlay,
        problems: [{ code: 'notNow', message: 'Finish the at-bat first' }]
      }
    // The copy shares the finished plays (`copyGame`), and the action is
    // applied to it in place: `applyAction`'s own copy is of the whole game.
    const applied = applyAction(copyGame(this.game), action, {
      inPlace: true,
      requireCurrentSetup: this.options.requireCurrentSetup === true
    })
    if (applied.problems.length > 0)
      return {
        ...applied,
        state: this.game,
        play: this.game.liveData.plays.currentPlay
      }
    const now = this.now().toISOString()
    this.log.push(action)
    this.actionTimes.push(now)
    this.playbackTimes.push(now)
    this.displaced?.stamped.push(now)
    this.record(action, applied, now)
    if (!this.holding) this.align()
    this.blocked = false
    this.dropped = null
    if (save) this.changed()
    return applied
  }

  private reconcileCurrent(): void {
    const before = setupOf(this.game)
    const setup = this.options.reconcileSetup?.(before)
    if (setup == null || JSON.stringify(setup) === JSON.stringify(before))
      return
    const action: ScoringAction = { type: 'lineup', kind: 'roster', setup }
    if (this.append(action, false).problems.length === 0)
      this.readActions.add(action)
  }

  undo(): Applied {
    const unchanged = (problem: Problem): Applied => ({
      state: this.game,
      transitions: [],
      play: this.game.liveData.plays.currentPlay,
      problems: [problem]
    })
    if (this.refusal != null)
      return unchanged({ code: 'notNow', message: this.refusal })
    let length = this.log.length
    while (length > 0 && this.readActions.has(this.log[length - 1])) length--
    if (length === 0)
      return unchanged({ code: 'notNow', message: 'Nothing to undo' })
    // An Undo puts nothing back, so what it took off within the minute is let
    // go at once (`settle`).
    this.settle(this.cut(length - 1))
    this.rebuild()
    this.reconcileCurrent()
    this.blocked = false
    this.dropped = null
    this.changed()
    return {
      state: this.game,
      transitions: [],
      play: this.game.liveData.plays.currentPlay,
      problems: []
    }
  }

  /**
   * Makes this session's log the one given: undoes back to where the two
   * agree, then applies the rest. A screen that keeps its own history calls
   * this after every change to it.
   */
  sync(target: readonly ScoringAction[]): Problem[] {
    if (this.refusal != null) return [{ code: 'notNow', message: this.refusal }]
    let same = 0
    while (
      same < this.log.length &&
      same < target.length &&
      // The screen hands back the very actions it applied here, so most
      // compare as the same object; writing each out again every sync cost
      // a phone about 25 ms a pitch by the 30th plate appearance.
      (this.log[same] === target[same] ||
        sameAction(this.log[same], target[same]))
    ) {
      // An action read back from the server can list its keys in another
      // order. Taken as the screen's own object, it compares at once next
      // time, and the plays it made are not built and posted again.
      this.log[same] = target[same]
      same++
    }
    let cut: Displaced | null = null
    if (same < this.log.length) {
      cut = this.cut(same)
      this.rebuild()
      this.changed()
    }
    // The run is matched against what the cut displaced once, at its end:
    // a correction far back re-applies hundreds of actions.
    this.holding = true
    try {
      for (const action of target.slice(same)) {
        const applied = this.apply(action)
        if (applied.problems.length > 0) return applied.problems
      }
      return []
    } finally {
      this.holding = false
      // What this call applied after cutting is the screen's own history
      // put back, which keeps its times however recent (`matchTimes`).
      if (cut != null) cut.replayed = cut.stamped.length
      this.align()
      // Then that history is settled, and what the cut took off within the
      // minute is let go.
      if (cut != null) this.settle(cut)
    }
  }

  /**
   * Reads the game the server holds again and takes it up, so a change
   * somebody else saved arrives here. It does so only while nothing here is
   * waiting to be saved, so none of this session's changes are lost; the last
   * one saved wins. Says whether the game changed.
   */
  async reload(): Promise<boolean> {
    const idle = (): boolean =>
      this.context != null &&
      this.refusal == null &&
      this.running == null &&
      this.pending === 0
    if (!idle()) return false
    let fresh: ScoringSession
    for (;;) {
      const snapshot = this.tagSnapshot
      fresh = await ScoringSession.open(
        this.store,
        this.gameId,
        this.context!,
        this.options
      )
      if (!idle()) return false
      // An acknowledgment or competing reload can land during the read.
      if (snapshot === this.tagSnapshot) break
    }
    this.lineupsBase = fresh.lineupsBase
    this.heldPlays = fresh.heldPlays
    this.heldLineups = fresh.heldLineups
    if (
      fresh.refusal === this.refusal &&
      JSON.stringify(fresh.log) === JSON.stringify(this.log) &&
      JSON.stringify(fresh.game) === JSON.stringify(this.game) &&
      JSON.stringify(fresh.eventTargets) === JSON.stringify(this.eventTargets)
    )
      return false
    this.adopt(fresh)
    this.notify()
    return true
  }

  /** Takes up everything `fresh`, a new read of the same game, holds. */
  private adopt(fresh: ScoringSession): void {
    this.context = fresh.context
    this.readActions = fresh.readActions
    this.lineupsBase = fresh.lineupsBase
    this.heldPlays = fresh.heldPlays
    this.heldLineups = fresh.heldLineups
    this.tagIdentities = fresh.tagIdentities
    this.tagSnapshot++
    this.importedDocuments.clear()
    for (const [index, play] of fresh.importedDocuments)
      this.importedDocuments.set(index, play)
    this.base = fresh.base
    this.log = fresh.log
    this.actionTimes = fresh.actionTimes
    this.playbackTimes = fresh.playbackTimes
    this.displaced = null
    this.savedLog = fresh.savedLog
    this.savedTimes = fresh.savedTimes
    this.savedPlaybackTimes = fresh.savedPlaybackTimes
    this.game = fresh.game
    this.completed = fresh.completed
    // Its plays carry the times the server holds.
    this.foldedPlays = null
    this.segment = fresh.segment
    this.marks = fresh.marks
    this.postedCurrent = fresh.postedCurrent
    this.failure = fresh.failure
    // A game somebody else left unreadable is shown, never written to.
    this.refusal = fresh.refusal
    for (const [target, source] of [
      [this.times, fresh.times],
      [this.posted, fresh.posted]
    ] as const) {
      target.clear()
      for (const [key, value] of source)
        (target as Map<number, unknown>).set(key, value)
    }
    for (const [target, source] of [
      [this.stored, fresh.stored],
      [this.derivedIndexes, fresh.derivedIndexes]
    ] as const) {
      target.clear()
      for (const value of source) target.add(value)
    }
    this.revision++
  }

  /**
   * After a save was refused as stale: reads the server's copy again and puts
   * this session's own unsaved changes back on top of it, each through the
   * engine. What the server holds of what this session saved stays as the
   * server holds it; somebody else's changes come next; then this session's
   * own, from where its log left what it saved. One the game no longer takes
   * is dropped, and `problem` says so.
   */
  private async rebase(): Promise<void> {
    const fresh = await ScoringSession.open(
      this.store,
      this.gameId,
      this.context!,
      this.options
    )
    // Read after the server answers: a change applied meanwhile is in the log.
    const agree = (
      a: readonly ScoringAction[],
      b: readonly ScoringAction[]
    ): number => {
      let count = 0
      while (
        count < a.length &&
        count < b.length &&
        sameAction(a[count], b[count])
      )
        count++
      return count
    }
    const same = agree(this.savedLog, this.log)
    const kept = agree(this.savedLog, fresh.log)
    const ours = this.log.slice(same)
    const theirs = fresh.log.slice(kept)
    // Each action put back keeps the time it was taken, not the rebase's.
    const ourTimes = this.actionTimes.slice(same)
    const theirTimes = fresh.actionTimes.slice(kept)
    const ourPlaybackTimes = this.playbackTimes.slice(same)
    const theirPlaybackTimes = fresh.playbackTimes.slice(kept)
    const times = new Map(this.times)
    // Home and away were swapped meanwhile: this session's own actions name
    // the old sides, so only the server's are put back.
    const swapped =
      fresh.context?.teams.home.id !== this.context?.teams.home.id ||
      fresh.context?.teams.away.id !== this.context?.teams.away.id
    const lost = swapped ? ours.length : 0
    this.swapLost += lost
    if (swapped) {
      ours.length = 0
      ourTimes.length = 0
      ourPlaybackTimes.length = 0
    }
    this.adopt(fresh)
    // An action of this session's undone before the server's came after it.
    const replay = same < kept ? [...theirs, ...ours] : ours
    // The server's actions are stored records, and apply as they were saved;
    // only this session's own are newly authored.
    const stored = same < kept ? theirs.length : 0
    const replayTimes = same < kept ? [...theirTimes, ...ourTimes] : ourTimes
    const replayPlaybackTimes =
      same < kept
        ? [...theirPlaybackTimes, ...ourPlaybackTimes]
        : ourPlaybackTimes
    if (same < kept) {
      this.log = this.log.slice(0, same)
      this.rebuild()
    }
    // Plays this session started keep the times it started them.
    for (const [index, time] of times)
      if (!this.times.has(index)) this.times.set(index, time)
    const refused: string[] = []
    for (const [index, action] of replay.entries()) {
      // A roster the screen logged while showing a default in place of an
      // unseen order. It replaces only a side that is still that order.
      // Every other side stays as the server holds it, and the pitch that
      // follows is scored from that lineup.
      const roster = reconcileShownLineup(action, this.log, this.game)
      if (roster == null) continue
      const applied = applyAction(copyGame(this.game), roster, {
        inPlace: true,
        requireCurrentSetup: this.options.requireCurrentSetup === true,
        replay: index < stored
      })
      if (applied.problems.length > 0) {
        refused.push(applied.problems[0].message)
        continue
      }
      // An action that had no time, scored by an app before actions carried
      // them, stays without one; its play keeps only its own times.
      const time = replayTimes[index]
      this.log.push(roster)
      this.actionTimes.push(time)
      this.playbackTimes.push(replayPlaybackTimes[index])
      this.record(roster, applied, time ?? this.now().toISOString())
    }
    this.dropped =
      lost > 0
        ? `Home and away were swapped, so ${lost === 1 ? 'a change' : `${lost} changes`} not yet saved before the swap ${lost === 1 ? 'was' : 'were'} not kept.`
        : refused.length === 0
          ? null
          : `${refused.length === 1 ? 'A change' : `${refused.length} changes`} could not follow another device's lineup change: ${refused[0]}`
    this.rebaseCount++
    this.notify()
  }

  /**
   * Saves whatever the server has not acknowledged. Tests await it. Once the
   * save has stopped, listeners are told once more, so one waiting for the
   * session to be idle (to read the game again) hears that it is: the save's
   * own notices all come while it is still running.
   */
  async flush(): Promise<void> {
    if (this.timer != null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    if (this.running != null) {
      await this.running
      return
    }
    this.running = this.save().finally(() => {
      this.running = null
      this.notify()
    })
    await this.running
  }

  // ---- The log, split into plays ----

  private record(action: ScoringAction, applied: Applied, now: string): void {
    const before = this.game
    const startIndex = before.liveData.plays.allPlays.length
    const split = segmentAfter(before, action, applied, this.segment)
    split.finished.forEach(({ play, segment }) => {
      this.completed.push({ play, segment })
      const times = this.times.get(play.about.atBatIndex) ?? {}
      times.start ??= now
      times.end ??= now
      this.times.set(play.about.atBatIndex, times)
    })
    this.segment = split.current
    this.game = applied.state
    this.revision++
    if (split.finished.length > 0)
      this.marks.push({
        logLength: this.log.length,
        game: this.game,
        completed: this.completed.length,
        segment: this.segment
      })
    if (this.segment.actions.length > 0) {
      const index =
        split.finished.length > 0
          ? this.game.liveData.plays.allPlays.length
          : startIndex
      const times = this.times.get(index) ?? {}
      times.start ??= now
      this.times.set(index, times)
    }
  }

  /**
   * Takes the log back to `length`. The actions taken off, with their times,
   * join what an earlier cut displaced and the actions applied since have not
   * used, so the actions applied next can find their times there (`align`).
   */
  private cut(length: number): Displaced {
    const held = this.displaced
    const rest = held?.consumed ?? 0
    const removed = this.log.slice(length)
    // How old an action was when it was cut says whether it was a mistake
    // taken back or a correction (`matchTimes`).
    const now = this.now().toISOString()
    this.displaced = {
      at: length,
      keys: [...removed.map(keyOf), ...(held?.keys.slice(rest) ?? [])],
      times: [
        ...this.actionTimes.slice(length),
        ...(held?.times.slice(rest) ?? [])
      ],
      playbackTimes: [
        ...this.playbackTimes.slice(length),
        ...(held?.playbackTimes.slice(rest) ?? [])
      ],
      cutAt: [...removed.map(() => now), ...(held?.cutAt.slice(rest) ?? [])],
      cut: removed.length,
      stamped: [],
      replayed: 0,
      consumed: 0
    }
    this.log = this.log.slice(0, length)
    this.actionTimes = this.actionTimes.slice(0, length)
    this.playbackTimes = this.playbackTimes.slice(0, length)
    return this.displaced
  }

  /**
   * Once the call that made a cut returns: the history it put back is
   * settled, with the times it was given, and what it took off a minute old
   * or younger is let go. Such a pitch was a mistake taken back on the spot,
   * so nothing entered later, however long after, is matched against it,
   * either as the pitch put back or as one an insertion went in ahead of.
   * Only a pitch cut over a minute after it was taken stays, for a later
   * correction to go back to.
   */
  private settle(cut: Displaced): void {
    if (this.displaced !== cut) return
    const left = cut.keys.flatMap((key, j) => {
      const time = cut.times[j]
      const ageTime = cut.playbackTimes[j] ?? time
      return j < cut.consumed ||
        (ageTime != null &&
          Date.parse(cut.cutAt[j]) - Date.parse(ageTime) <=
            REPLACED_KEEPS_TIME_MS)
        ? []
        : [
            {
              key,
              time,
              playbackTime: cut.playbackTimes[j],
              cutAt: cut.cutAt[j]
            }
          ]
    })
    this.displaced =
      left.length === 0
        ? null
        : {
            at: cut.at + cut.stamped.length,
            keys: left.map(each => each.key),
            times: left.map(each => each.time),
            playbackTimes: left.map(each => each.playbackTime),
            cutAt: left.map(each => each.cutAt),
            cut: 0,
            stamped: [],
            replayed: 0,
            consumed: 0
          }
  }

  /**
   * Gives the actions applied since the last cut the times of the actions it
   * displaced (`matchTimes`). A later action can change how earlier ones
   * match, so every action since the cut is matched again each time. Once
   * the newest lies beyond everything displaced, the displaced are let go.
   */
  private align(): void {
    const held = this.displaced
    if (held == null || this.log.length <= held.at) return
    const matched = matchTimes(
      this.log.slice(held.at).map(keyOf),
      held.stamped,
      { ...held, ageTimes: held.playbackTimes },
      this.actionTimes[held.at - 1],
      held.replayed
    )
    const playback = matchTimes(
      this.log.slice(held.at).map(keyOf),
      held.stamped,
      { ...held, times: held.playbackTimes },
      this.playbackTimes[held.at - 1],
      held.replayed,
      'playback'
    )
    let first = -1
    for (const [k, time] of matched.times.entries())
      if (this.actionTimes[held.at + k] !== time) {
        this.actionTimes[held.at + k] = time
        if (first < 0) first = held.at + k
      }
    for (const [k, time] of playback.times.entries())
      if (this.playbackTimes[held.at + k] !== time) {
        this.playbackTimes[held.at + k] = time
        if (first < 0 || held.at + k < first) first = held.at + k
      }
    held.consumed = matched.consumed
    if (matched.past) this.displaced = null
    if (first >= 0) {
      this.revision++
      // A play already folded holds the times it was folded with.
      if (first < (this.foldedPlays?.covered ?? 0)) this.foldedPlays = null
    }
  }

  private rebuild(): void {
    while ((this.marks.at(-1)?.logLength ?? 0) > this.log.length)
      this.marks.pop()
    const mark = this.marks.at(-1)
    let game = mark?.game ?? this.base
    let segment: Segment = mark?.segment ?? {
      setupBefore: setupOf(game),
      actions: []
    }
    const completed = this.completed.slice(0, mark?.completed ?? 0)
    const kept = this.log.slice(0, mark?.logLength ?? 0)
    for (const action of this.log.slice(kept.length)) {
      // Each step on a copy that shares the finished plays: a whole copy per
      // action made the replay grow with the game.
      const applied = applyAction(copyGame(game), action, {
        inPlace: true,
        replay: true
      })
      if (applied.problems.length > 0) break
      const split = segmentAfter(game, action, applied, segment)
      completed.push(...split.finished)
      segment = split.current
      game = applied.state
      kept.push(action)
      if (split.finished.length > 0)
        this.marks.push({
          logLength: kept.length,
          game,
          completed: completed.length,
          segment
        })
    }
    this.log = kept
    this.actionTimes.length = kept.length
    this.playbackTimes.length = kept.length
    this.game = game
    this.completed = completed
    this.segment = segment
    this.revision++
    // Reconcile now, before a redo can reuse the position of an undone pitch.
    this.picture()
  }

  // ---- What the server should hold, and what it does not yet ----

  /**
   * What the server should hold: each play this session scored, folded with
   * its times, and the at-bat in progress, or null once the game is over.
   */
  picture(): {
    plays: Map<number, GumboPlay>
    current: CurrentPlay | null
  } {
    // Folding every play takes a phone about 25 ms 70 plate appearances in,
    // and the save, its status and the pending count all ask after a change.
    if (this.folded?.revision !== this.revision) {
      const raw = this.fold()
      const plays = new Map(
        [...raw.plays].map(([index, play]) => [
          index,
          this.tagIdentities.decorate(play, true)
        ])
      )
      const current =
        raw.current == null
          ? null
          : this.tagIdentities.decorate(raw.current, false)
      this.tagIdentities.retain([
        ...this.importedDocuments.keys(),
        ...plays.keys(),
        ...(current == null ? [] : [current.about.atBatIndex])
      ])
      this.folded = { revision: this.revision, picture: { plays, current } }
    }
    return this.folded.picture
  }

  private fold(): {
    plays: Map<number, GumboPlay>
    current: CurrentPlay | null
  } {
    const plays = new Map<number, GumboPlay>()
    const time = (
      index: number
    ): { startTime?: string | null; endTime?: string | null } => {
      const times = this.times.get(index)
      return { startTime: times?.start ?? null, endTime: times?.end ?? null }
    }
    // One pass over the game folds every play: each is folded with who has
    // been announced as the plays before it left it.
    // A completed play folds the same until an undo or a reload takes it
    // back, or its players or teams change: folding every one of them again
    // on each change cost a phone about 10 ms, and writing each out again to
    // compare with what was posted 20 ms more, at 70 plate appearances, on
    // the frame a pitch starts. So only the plays completed since are folded.
    const inputs = foldInputsOf(this.game)
    let kept = this.foldedPlays
    if (
      kept?.inputs !== inputs ||
      kept.count > this.completed.length ||
      (kept.count > 0 && this.completed[kept.count - 1] !== kept.last)
    )
      kept = null
    const folder = (kept?.folder ?? playFolder(this.game)).continuing(this.game)
    for (const [index, play] of kept?.plays ?? []) plays.set(index, play)
    // The plays split the log in order, so each play's actions, and their
    // times, start where the play before it ended.
    let offset = kept?.covered ?? 0
    for (const { play, segment } of this.completed.slice(kept?.count ?? 0)) {
      const end = offset + segment.actions.length
      plays.set(
        play.about.atBatIndex,
        folder.play(play, {
          ...segment,
          actionTimes: this.actionTimes.slice(offset, end),
          playbackTimes: this.playbackTimes.slice(offset, end),
          ...time(play.about.atBatIndex)
        })
      )
      offset = end
    }
    this.foldedPlays = {
      inputs,
      count: this.completed.length,
      last: this.completed.at(-1),
      plays: new Map(plays),
      // The at-bat in progress is folded by this one below, which carries it
      // past that play too; the next fold carries on from before it.
      folder: folder.continuing(this.game),
      covered: offset
    }
    const stamp = {
      ...this.segment,
      actionTimes: this.actionTimes.slice(offset),
      playbackTimes: this.playbackTimes.slice(offset)
    }
    if (this.game.final) {
      plays.set(
        FINAL_INDEX,
        foldFinal(this.game, { ...stamp, ...time(FINAL_INDEX) })
      )
      return { plays, current: null }
    }
    const index = this.game.liveData.plays.allPlays.length
    return {
      plays,
      current: folder.current(this.game.liveData.plays.currentPlay, {
        ...stamp,
        ...time(index)
      })
    }
  }

  private change(): SaveChange {
    // A session refused, or read back only in part, writes nothing.
    if (this.refusal != null) return { plays: [], remove: [] }
    const picture = this.picture()
    const plays = [...picture.plays]
      .filter(([index, play]) => this.posted.get(index) !== written(play))
      .map(([, play]) => play)
    // A play reopened by an undo keeps its row while it has an action of its
    // own; the close of the play before it is not one.
    const reopened = this.atBatOpen
      ? this.game.liveData.plays.allPlays.length
      : null
    const remove = [...this.stored]
      .filter(index => !picture.plays.has(index) && index !== reopened)
      .sort((a, b) => a - b)
    const current = JSON.stringify(picture.current)
    return {
      plays,
      remove,
      ...(current === this.postedCurrent
        ? {}
        : { currentPlay: picture.current }),
      fenceDistanceFt: fenceOf(this.game)
    }
  }

  private changed(): void {
    if (this.game.final && !this.times.has(FINAL_INDEX)) {
      const now = this.now().toISOString()
      this.times.set(FINAL_INDEX, { start: now, end: now })
      this.revision++
    }
    this.notify()
    this.schedule(0)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private schedule(ms: number): void {
    if (this.refusal != null || this.blocked || this.closed || this.isReplaced)
      return
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      this.flush().catch(() => undefined)
    }, ms)
  }

  private async save(): Promise<void> {
    let rebased = 0
    for (;;) {
      if (
        this.refusal != null ||
        this.blocked ||
        this.closed ||
        this.isReplaced
      )
        return
      const covering = [...this.log]
      const coveringTimes = [...this.actionTimes]
      const coveringPlaybackTimes = [...this.playbackTimes]
      const change = this.change()
      if (
        change.plays.length === 0 &&
        change.remove.length === 0 &&
        change.currentPlay === undefined
      )
        return
      let answer: StoredGame | undefined
      try {
        answer = await this.store.save(this.gameId, {
          ...change,
          ...(this.lineupsBase === undefined
            ? {}
            : { lineupsBase: this.lineupsBase }),
          ...(this.openedGeneration === undefined
            ? {}
            : { generation: this.openedGeneration })
        })
      } catch (error) {
        // The plays this session holds were reset: its changes belong to
        // none of the game's, so they are neither rebased nor sent again.
        const generation = refusedGeneration(error)
        if (generation !== undefined && generation !== this.openedGeneration) {
          this.isReplaced = true
          this.notify()
          return
        }
        // Somebody else saved the lineups since this session read them: it
        // takes theirs up and saves its own changes on top, never over them.
        if (stale(error) && this.context != null && rebased < STALE_REBASES) {
          rebased++
          try {
            await this.rebase()
          } catch (reading) {
            this.failed(reading)
            return
          }
          continue
        }
        this.failed(error)
        return
      }
      if (answer?.lineupsDigest !== undefined) {
        this.lineupsBase = answer.lineupsDigest
        this.heldLineups = held(this.heldLineups, answer.lineupsDigest)
      }
      // Found as this session last had it, the game holds only its own.
      if (answer?.playsDigest !== undefined)
        this.heldPlays =
          answer.priorPlaysDigest !== undefined &&
          answer.priorPlaysDigest === this.heldPlays.at(-1)
            ? held(this.heldPlays, answer.playsDigest)
            : []
      for (const play of change.plays) {
        this.posted.set(play.about.atBatIndex, written(play))
        this.stored.add(play.about.atBatIndex)
      }
      for (const index of change.remove) {
        this.posted.delete(index)
        this.stored.delete(index)
      }
      if (change.currentPlay !== undefined)
        this.postedCurrent = JSON.stringify(change.currentPlay)
      this.savedLog = covering
      this.savedTimes = coveringTimes
      this.savedPlaybackTimes = coveringPlaybackTimes
      this.isOffline = false
      this.failure = null
      this.retryMs = FIRST_RETRY_MS
      this.notify()
    }
  }

  private failed(error: unknown): void {
    const code = error instanceof HttpError ? error.code : null
    const message = error instanceof Error ? error.message : String(error)
    // Signed out, the scorer signs in again and the waiting changes go then.
    // Lineups that keep changing under each read are tried again later.
    if (
      code === 'offline' ||
      code === 'rateLimited' ||
      code === 'internal' ||
      code === 'unauthorized' ||
      stale(error)
    ) {
      this.isOffline = code === 'offline'
      this.failure = code === 'offline' ? null : message
      const wait = this.retryMs
      this.retryMs = Math.min(LAST_RETRY_MS, this.retryMs * 2)
      this.notify()
      this.schedule(wait)
      return
    }
    if (code === 'conflict' || code === 'forbidden' || code === 'notFound') {
      // Nothing more will be saved, so the game goes back to what the server
      // holds rather than showing changes it turned away.
      this.refusal = message
      this.isOffline = false
      this.log = [...this.savedLog]
      this.actionTimes = [...this.savedTimes]
      this.playbackTimes = [...this.savedPlaybackTimes]
      this.displaced = null
      this.marks = []
      this.rebuild()
      this.notify()
      return
    }
    // The server read the post and cannot store it: sending it again will not
    // help, so it waits for the next change.
    this.failure = message
    this.blocked = true
    this.notify()
  }
}
