import { HttpError } from '../errors'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { Problem, ScoringAction } from './actions'
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
import { awaitingResult } from './rules'
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

export interface StoredGame {
  plays: GumboPlay[]
  currentPlay: CurrentPlay | null
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
  now?: () => Date
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30000

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
  /** The log as far as the server has acknowledged it. */
  private savedLog: ScoringAction[] = []
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
  } | null = null

  private readonly times = new Map<number, { start?: string; end?: string }>()
  /** What the server acknowledged, per index. */
  private readonly posted = new Map<number, string>()
  private postedCurrent: string | null = null
  /** Indexes of plays this session scored that the server holds. */
  private readonly stored = new Set<number>()
  /** Plays GameStation did not score, which it never writes or removes. */
  private readonly derivedIndexes = new Set<number>()
  private readonly listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private timer: unknown = null
  private retryMs = FIRST_RETRY_MS
  private blocked = false
  private refusal: string | null = null
  private failure: string | null = null
  private isOffline = false
  private readonly now: () => Date
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  /** What `open` read the game with, so `reload` can read it again. */
  private context: SessionContext | null = null

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
    const replayed = replayPlays(loaded, context)
    const session = new ScoringSession(store, gameId, replayed.base, options)
    session.context = context
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
    session.log = replayed.segments.flatMap(segment => segment.actions)
    session.rebuild()
    session.savedLog = [...session.log]
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
      for (const action of actions) state = applyAction(state, action).state
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

  /** The last save never left the device; it will be tried again. */
  get offline(): boolean {
    return this.isOffline
  }

  /** The server refused to be written to, and said why. */
  get readOnly(): boolean {
    return this.refusal != null
  }

  get problem(): string | null {
    return this.refusal ?? this.failure
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  apply(action: ScoringAction): Applied {
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
    const applied = applyAction(copyGame(this.game), action, { inPlace: true })
    if (applied.problems.length > 0)
      return {
        ...applied,
        state: this.game,
        play: this.game.liveData.plays.currentPlay
      }
    this.log.push(action)
    this.record(action, applied)
    this.blocked = false
    this.changed()
    return applied
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
    if (this.log.length === 0)
      return unchanged({ code: 'notNow', message: 'Nothing to undo' })
    this.log.pop()
    this.rebuild()
    this.blocked = false
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
        JSON.stringify(this.log[same]) === JSON.stringify(target[same]))
    )
      same++
    if (same < this.log.length) {
      this.log = this.log.slice(0, same)
      this.rebuild()
      this.changed()
    }
    for (const action of target.slice(same)) {
      const applied = this.apply(action)
      if (applied.problems.length > 0) return applied.problems
    }
    return []
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
    const fresh = await ScoringSession.open(
      this.store,
      this.gameId,
      this.context!,
      this.options
    )
    if (!idle()) return false
    if (
      fresh.refusal === this.refusal &&
      JSON.stringify(fresh.log) === JSON.stringify(this.log) &&
      JSON.stringify(fresh.game) === JSON.stringify(this.game)
    )
      return false
    this.base = fresh.base
    this.log = fresh.log
    this.savedLog = fresh.savedLog
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
    this.notify()
    return true
  }

  /** Saves whatever the server has not acknowledged. Tests await it. */
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
    })
    await this.running
  }

  // ---- The log, split into plays ----

  private record(action: ScoringAction, applied: Applied): void {
    const before = this.game
    const now = this.now().toISOString()
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
      const applied = applyAction(copyGame(game), action, { inPlace: true })
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
    this.game = game
    this.completed = completed
    this.segment = segment
    this.revision++
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
    if (this.folded?.revision !== this.revision)
      this.folded = { revision: this.revision, picture: this.fold() }
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
    for (const { play, segment } of this.completed.slice(kept?.count ?? 0))
      plays.set(
        play.about.atBatIndex,
        folder.play(play, {
          ...segment,
          ...time(play.about.atBatIndex)
        })
      )
    this.foldedPlays = {
      inputs,
      count: this.completed.length,
      last: this.completed.at(-1),
      plays: new Map(plays),
      // The at-bat in progress is folded by this one below, which carries it
      // past that play too; the next fold carries on from before it.
      folder: folder.continuing(this.game)
    }
    if (this.game.final) {
      plays.set(
        FINAL_INDEX,
        foldFinal(this.game, { ...this.segment, ...time(FINAL_INDEX) })
      )
      return { plays, current: null }
    }
    const index = this.game.liveData.plays.allPlays.length
    return {
      plays,
      current: folder.current(this.game.liveData.plays.currentPlay, {
        ...this.segment,
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
    if (this.refusal != null || this.blocked) return
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      this.flush().catch(() => undefined)
    }, ms)
  }

  private async save(): Promise<void> {
    for (;;) {
      if (this.refusal != null || this.blocked) return
      const covering = [...this.log]
      const change = this.change()
      if (
        change.plays.length === 0 &&
        change.remove.length === 0 &&
        change.currentPlay === undefined
      )
        return
      try {
        await this.store.save(this.gameId, change)
      } catch (error) {
        this.failed(error)
        return
      }
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
    if (
      code === 'offline' ||
      code === 'rateLimited' ||
      code === 'internal' ||
      code === 'unauthorized'
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
