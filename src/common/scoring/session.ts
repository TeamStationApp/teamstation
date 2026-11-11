import type { PostedEdits } from '../api'
import { HttpError, isUpdateRequired } from '../errors'
import {
  eventSignature,
  historyTargets,
  type TagDocument,
  TagIdentityRegistry,
  type TagMetadata,
  tagMetadata,
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
import {
  latestLineupChanges,
  lineupSides,
  olderThan,
  stampTime
} from './lineupTimes'
import type { SwapEffect } from './playsLost'
import { awaitingResult, closesFirst, nextDecision } from './rules'
import {
  authoredScoringMutation,
  MAX_SCORING_TIME,
  sameScoringMutation,
  type ScoringMutation
} from './scoringMutation'
import {
  copyGame,
  copyState,
  type GamePlay,
  type GameSetup,
  type GameState,
  type GameTeam,
  setupOf,
  type Side
} from './state'
import { namesIn, withoutNames } from './storedNames'
import type { ScoringUpdate } from './updates'

/** The identities and positions to which an authored play gives credit. */
function attributionOf(play: GamePlay): string {
  return JSON.stringify({
    batter: play.matchup.batter.id,
    pitcher: play.matchup.pitcher.id,
    batSide: play.matchup.batSide.code,
    events: play.playEvents
      .filter(event => event.isSubstitution !== true)
      .map(event => ({
        code: event.details.code,
        player: event.player.id,
        pitcher: event.pitcher?.id,
        catcher: event.catcher?.id
      })),
    runners: play.runners.map(runner => ({
      player: runner.details.runner.id,
      pitcher: runner.details.responsiblePitcher?.id,
      movement: runner.movement,
      credits: runner.credits.map(credit => ({
        player: credit.player?.id,
        position: credit.position,
        credit: credit.credit
      }))
    })),
    fielder: play.hitData?.fielder?.id,
    position: play.hitData?.position,
    route: play.source.teamstation.fieldingRoute?.map(hop => ({
      player: hop.player?.id,
      position: hop.position
    }))
  })
}

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

// Prior-play corrections use the same session boundary as other scoring edits.
export {
  type PriorRunner,
  priorRunners,
  returnPriorRunner
} from './priorRunner'

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
  scoringUpdates?: ScoringUpdate[]
  scoringMutation?: ScoringMutation
  superseded?: boolean
  plays: GumboPlay[]
  currentPlay: CurrentPlay | null
  /**
   * What a model calls each player, for a reader who may dictate about them.
   * The session holds it beside its setups, in `meta`, never in one: a setup
   * is compared and saved, and this is neither.
   */
  modelNames?: Record<string, string>
  /**
   * The teams whose players' first and last names this read carries, as
   * `GET /games/:gameId/events` answers it. Absent or empty: named as the
   * public reads the game, as the game socket's `playEdits` are.
   */
  halves?: string[]
  /**
   * Gumbo id → full name, for each of the game's players this reader reads
   * in full though its plays name them as the public reads them, as
   * `GET /games/:gameId/events` answers it. Absent for none, and when spoken.
   */
  readerNames?: Record<string, string>
  /**
   * The digest the server keeps of the game's lineups, as it read them or as
   * this save left them: what the next save names as its `lineupsBase`.
   * Absent from a store that keeps none.
   */
  lineupsDigest?: string
  /** A digest of the stored plays and the at-bat in progress, as read or left. */
  playsDigest?: string
  /**
   * The digest of the book `GET /games/:gameId/events` named the plays from,
   * which a `playEdits` change must name to apply to them. Absent from a
   * store that keeps none, and from a save's answer.
   */
  namesDigest?: string
  /** On a save's answer, the same digest of the game as the save found it. */
  priorPlaysDigest?: string
  /**
   * The game's play generation, one more after each reset: a save naming
   * another is refused. Absent from a store that keeps none.
   */
  generation?: number
  /**
   * What swapping home and away would do to the game, as the server decides
   * it (`swapEffect`). Absent from a store that cannot tell.
   */
  swap?: SwapEffect
  /**
   * The context to replay with when the game's teams are no longer the ones
   * the session was opened with, as after a swap of home and away; absent
   * while they are, and from every store that cannot tell.
   */
  context?: SessionContext
}
export interface SaveChange {
  /** Device-only replay baseline for a queued lineup edit; never sent. */
  deviceLineupRecovery?: LineupRecovery
  scoringMutation?: ScoringMutation
  /** Completed editable ancestry to restore if a competing branch replaced it. */
  scoringHistory?: GumboPlay[]
  /** The scoring version this delta builds on; null before any scoring. */
  scoringBase?: ScoringMutation | null
  /**
   * The plays that changed. A session saves them in their stored form
   * (`withoutNames`): nobody's name travels with a play, and the server
   * names it from the players' accounts when it is read.
   */
  plays: GumboPlay[]
  remove: number[]
  /** The at-bat in progress when it changed, in its stored form too. */
  currentPlay?: CurrentPlay | null
  /**
   * The session's name for each gumbo id the change's plays name
   * (`namesIn` of the named documents): kept on the device beside the
   * change, so a copy written on the phone reads named before the server
   * has answered (`appliedEvents`, `memoryStore`). Never sent.
   */
  names?: Record<string, string>
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
  /**
   * The session's whole log as the change leaves it, and when each action
   * was taken: kept on the device beside a queued change, so a newer build
   * can play it again on its own engine where this build's plays would not
   * read right to it (`rebuildGameEvents`). Never sent.
   */
  log?: SessionLog
}

/** A session's actions, and the time each was taken where it is known. */
export interface SessionLog {
  actions: ScoringAction[]
  times: Array<string | null>
}
/**
 * Where a session reads and writes its game. It does no I/O of its own. A
 * save answers the digests and the generation it left the game with
 * (`PostedEdits`), or the whole game, which holds them: the session reads
 * only those, each when present.
 */
export interface EventStore {
  load: (gameId: string) => Promise<StoredGame>
  save: (
    gameId: string,
    change: SaveChange
  ) => Promise<PostedEdits | StoredGame>
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
export interface LineupRecovery {
  /** Original rejected scoring identity, retained through lineup-only retries. */
  rejectedScoring?: ScoringMutation
  baseline: StoredGame
  context: SessionContext
  /** Bounds repeated conflicts without changing an ambiguously sent request. */
  attempts?: number
}
export interface SessionOptions {
  /** Live availability is staged on read and written with the next scoring change. */
  reconcileSetup?: (setup: GameSetup, game: GameState) => GameSetup
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
export function sameAction(a: ScoringAction, b: ScoringAction): boolean {
  return a === b || keyOf(a) === keyOf(b)
}

/** The appearance at which an action was authored, before any rebase. */
function actionAtBats(
  base: GameState,
  log: readonly ScoringAction[]
): Array<{ atBat: number; touched: number[] }> {
  let state = copyGame(base)
  return log.map(action => {
    const index =
      state.liveData.plays.currentPlay?.about.atBatIndex ??
      state.liveData.plays.allPlays.length
    const closes = closesFirst(action) && nextDecision(state) === 'close'
    const applied = applyAction(state, action, { inPlace: true, replay: true })
    state = applied.state
    // A pitch can close a decided play and score the next appearance in one
    // action. Keep the closing credit as well as the newly authored credit.
    const atBat =
      closes && applied.problems.length === 0
        ? (state.liveData.plays.currentPlay?.about.atBatIndex ?? index)
        : index
    return { atBat, touched: atBat === index ? [index] : [index, atBat] }
  })
}

/** A timestamped roster edit after rebase merged unrelated coach sides. */
function sameRebasedRoster(
  original: ScoringAction,
  candidate: ScoringAction,
  originalSides: readonly Side[],
  winningSides: readonly Side[]
): boolean {
  if (
    original.type !== 'lineup' ||
    original.kind !== 'roster' ||
    original.setup == null ||
    candidate.type !== 'lineup' ||
    candidate.kind !== 'roster' ||
    candidate.setup == null ||
    winningSides.length === 0 ||
    winningSides.some(side => !originalSides.includes(side))
  )
    return false
  const reference = candidate.setup
  const project = (edit: typeof candidate): ScoringAction => ({
    ...edit,
    setup: {
      ...reference,
      sides: {
        ...reference.sides,
        ...Object.fromEntries(
          winningSides.map(side => [side, edit.setup!.sides[side]])
        )
      },
      players: Object.fromEntries(
        winningSides.flatMap(side =>
          edit.setup!.sides[side].players.map(id => {
            const {
              fullName: _full,
              firstName: _first,
              lastName: _last,
              ...player
            } = edit.setup!.players[id]
            return [id, { ...player, fullName: '' }]
          })
        )
      )
    },
    confirmed: edit.confirmed?.filter(side => winningSides.includes(side)),
    unseen: edit.unseen?.filter(side => winningSides.includes(side))
  })
  return sameAction(project(original), project(candidate))
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

/**
 * A folded play as the server stores it (`withoutNames`), worked out once
 * per play and kept with its text: what changed is decided by the text, so
 * a play whose only change is a player's name is never written again, and a
 * save sends the stored form it was decided on (`storedChange`).
 */
const writtenPlays = new WeakMap<
  GumboPlay,
  { stored: GumboPlay; text: string }
>()
function storedPlay(play: GumboPlay): { stored: GumboPlay; text: string } {
  let form = writtenPlays.get(play)
  if (form == null) {
    const stored = withoutNames(play)
    form = { stored, text: JSON.stringify(stored) }
    writtenPlays.set(play, form)
  }
  return form
}
function written(play: GumboPlay): string {
  return storedPlay(play).text
}

/** The at-bat in progress as the server stores it, written out. */
function writtenCurrent(current: CurrentPlay | null | undefined): string {
  return JSON.stringify(current == null ? current : withoutNames(current))
}

/**
 * A change as a store is sent it: its plays and at-bat in their stored form,
 * and beside them the names those documents carried.
 */
export function storedChange(change: SaveChange): SaveChange {
  const names: Record<string, string> = { ...change.names }
  for (const play of [
    ...change.plays,
    ...(change.scoringHistory ?? []),
    change.currentPlay
  ])
    if (play != null)
      for (const [id, name] of namesIn(play))
        if (!(String(id) in names)) names[String(id)] = name
  return {
    ...change,
    plays: change.plays.map(play => storedPlay(play).stored),
    ...(change.scoringHistory == null
      ? {}
      : {
          scoringHistory: change.scoringHistory.map(
            play => storedPlay(play).stored
          )
        }),
    ...(change.currentPlay === undefined
      ? {}
      : {
          currentPlay:
            change.currentPlay == null ? null : withoutNames(change.currentPlay)
        }),
    names
  }
}

export class ScoringSession {
  /** Server-accepted descriptions, never synthesized by optimistic writes. */
  scoringUpdates: readonly ScoringUpdate[] = []
  private mutationPending = false
  private knownMutation: ScoringMutation | undefined
  private authoredMutation: ScoringMutation | undefined
  /** Sent identities whose acknowledgments may have been lost. */
  private unconfirmedScoring: ScoringMutation[] = []
  /** Exact bytes for an ambiguous save; annotations must not change a retry. */
  private attemptedSave?: {
    mutation: ScoringMutation | undefined
    change: SaveChange
    request: SaveChange
    covering: ScoringAction[]
    times: Array<string | undefined>
    playbackTimes: Array<string | undefined>
    tags: Map<string, string | null>
    sends: number
    unknownFailures: number
  }

  private lastAuthoredAt = -1

  /** The scoring identity restored with this session's cached picture. */
  get observedScoringMutation(): ScoringMutation | undefined {
    return this.knownMutation == null ? undefined : { ...this.knownMutation }
  }

  /** Capture the calibrated time of input before rendering or animation runs. */
  captureScoringAction(at = this.now().getTime()): ScoringMutation {
    // Calibration may move wall time backwards. Keep local action identities
    // increasing; the server resolves conflicts against the observed base.
    this.lastAuthoredAt = Math.min(
      MAX_SCORING_TIME,
      Math.max(
        at,
        this.lastAuthoredAt + 1,
        (this.knownMutation?.at ?? -1) + 1,
        (this.authoredMutation?.at ?? -1) + 1
      )
    )
    return authoredScoringMutation(this.lastAuthoredAt)
  }

  private authorMutation(automatic = false, at?: number): void {
    const original = this.authoredMutation ?? this.knownMutation
    this.mutationPending = !automatic || original != null
    if (automatic && original != null)
      this.authoredMutation = {
        ...original,
        revision: original.revision + 1
      }
    else if (!automatic) this.authoredMutation = this.captureScoringAction(at)
  }

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
  /**
   * Refused as older than the server reads (`updateRequired`): nothing more
   * is sent from this build, and what is not saved stays on the log.
   */
  private isOutdated = false
  /** Closed for good: nothing more is saved from it. */
  private closed = false
  private swapLost = 0
  private refusal: string | null = null
  private failure: string | null = null
  private isOffline = false
  private readonly now: () => Date
  private readActions = new WeakSet<ScoringAction>()
  /** Unchanged history carried through a correction and any save retry. */
  private readonly retainedHistory = new WeakSet<ScoringAction>()
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
  /** What a swap does to the game, by the last read this session took up. */
  private readSwap: SwapEffect | undefined
  /** The game's plays were reset under this session: it saves nothing more. */
  private isReplaced = false
  /** Counts each time a save took the server's copy up under its own changes. */
  private rebaseCount = 0
  private rebasedPeer = false
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
    session.postedCurrent = writtenCurrent(session.picture().current)
    return session
  }

  /** Replay only a queued child's lineup edits after its scoring parent loses. */
  static async rebaseQueuedLineups(
    gameId: string,
    parent: StoredGame,
    child: StoredGame,
    winner: StoredGame,
    context: SessionContext,
    rejectedScoring?: ScoringMutation
  ): Promise<SaveChange | undefined> {
    const options = { setTimer: () => null, clearTimer: () => undefined }
    let held = parent
    const store: EventStore = {
      load: async () => held,
      save: async () => {
        throw new Error('Queued reconciliation must not send')
      }
    }
    const session = await ScoringSession.open(store, gameId, context, options)
    const desired = await ScoringSession.open(
      { ...store, load: async () => child },
      gameId,
      context,
      options
    )
    try {
      if (session.problem != null || desired.problem != null) return undefined
      const scoring = (actions: readonly ScoringAction[]): ScoringAction[] =>
        actions.filter(
          action =>
            action.type !== 'lineup' &&
            !(action.type === 'gameFlow' && action.kind === 'closePlay')
        )
      const before = scoring(session.log)
      const after = scoring(desired.log)
      if (rejectedScoring != null) {
        if (
          winner.scoringMutation == null ||
          sameScoringMutation(rejectedScoring, winner.scoringMutation)
        )
          return undefined
      } else if (
        before.length !== after.length ||
        before.some((action, index) => !sameAction(action, after[index]))
      )
        return undefined
      const desiredLineups = desired.log.flatMap((action, index) =>
        action.type === 'lineup'
          ? [{ action, time: desired.actionTimes[index] }]
          : []
      )
      const originalSides = session.lineupSides
      const removedLineups = session.log.flatMap((action, index) => {
        if (action.type !== 'lineup') return []
        const time = session.actionTimes[index]
        const match = desiredLineups.findIndex(
          entry => entry.time === time && sameAction(entry.action, action)
        )
        if (match >= 0) {
          desiredLineups.splice(match, 1)
          return []
        }
        return [{ action, time, sides: originalSides[index] ?? [] }]
      })
      if (
        rejectedScoring != null &&
        desiredLineups.length === 0 &&
        removedLineups.length === 0
      )
        return undefined
      if (removedLineups.some(entry => entry.time == null)) return undefined
      if (session.sync(desired.log, [], true).length > 0) return undefined
      session.authoredMutation = rejectedScoring
      session.mutationPending = rejectedScoring != null
      // Replaying the queued lineup uses the time it was authored, so an
      // independently newer coach edit remains newer during normal rebase.
      session.actionTimes = [...desired.actionTimes]
      session.playbackTimes = [...desired.playbackTimes]
      session.revision++
      held = winner
      await session.rebase()
      if (session.refusal != null || session.failure != null) return undefined
      if (removedLineups.length > 0) {
        const winningSides = session.lineupSides
        const keptTimes: Array<string | undefined> = []
        const keptPlayback: Array<string | undefined> = []
        const target = session.log.filter((action, index) => {
          const removed = removedLineups.findIndex(
            entry =>
              entry.time === session.actionTimes[index] &&
              (sameAction(entry.action, action) ||
                sameRebasedRoster(
                  entry.action,
                  action,
                  entry.sides,
                  winningSides[index] ?? []
                ))
          )
          if (removed >= 0) {
            removedLineups.splice(removed, 1)
            return false
          }
          keptTimes.push(session.actionTimes[index])
          keptPlayback.push(session.playbackTimes[index])
          return true
        })
        if (session.sync(target, [], true).length > 0) return undefined
        session.actionTimes = keptTimes
        session.playbackTimes = keptPlayback
        session.revision++
      }
      return {
        ...storedChange({
          ...session.change(),
          currentPlay: session.picture().current
        }),
        scoringBase: session.knownMutation ?? null,
        ...(session.lineupsBase === undefined
          ? {}
          : { lineupsBase: session.lineupsBase })
      }
    } finally {
      session.close()
      desired.close()
    }
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
    const session = new ScoringSession(
      store,
      gameId,
      loaded.modelNames == null
        ? replayed.base
        : {
            ...replayed.base,
            meta: { ...replayed.base.meta, modelNames: loaded.modelNames }
          },
      options
    )
    session.scoringUpdates = loaded.scoringUpdates ?? []
    session.knownMutation = loaded.scoringMutation
    session.context = loaded.context ?? context
    session.lineupsBase = loaded.lineupsDigest
    session.openedGeneration = loaded.generation
    session.readSwap = loaded.swap
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
      if (session.stored.has(index)) session.posted.set(index, written(play))
    session.postedCurrent = writtenCurrent(picture.current)
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
      this.postedCurrent === writtenCurrent(before.current)
    if (!this.tagIdentities.setTag(targetId, tag)) return false
    this.attemptedSave?.tags.set(targetId, tag)
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
      this.postedCurrent = writtenCurrent(picture.current)
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
      const setup = this.options.reconcileSetup?.(before, state)
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
    // Returning to the acknowledged picture by Undo is still pending when
    // an earlier request may already have committed. Do not let a passive
    // reload discard that Undo before its ambiguous predecessor is resolved.
    return Math.max(
      this.attemptedSave == null ? 0 : 1,
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
    return (
      this.refusal ??
      this.failure ??
      this.dropped ??
      this.game.lineupWarning ??
      null
    )
  }

  /**
   * Whether a notice describes the latest plays this session read or saved.
   * An earlier owned digest can be a peer Undo, not just a delayed echo.
   */
  holdsPlays(digest: string): boolean {
    return this.heldPlays.at(-1) === digest
  }

  /** Only the latest lineup digest is an echo; a peer can restore an older one. */
  holdsLineups(digest: string): boolean {
    return this.heldLineups.at(-1) === digest
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

  /** The last rebase adopted another scorer instead of replaying our scoring. */
  get rebaseFollowsPeer(): boolean {
    return this.rebasedPeer
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
   * What swapping home and away does to the game, by the server's word
   * (`swapEffect`) on the last read this session took up: when it opened,
   * reloaded or rebased. Absent from a store that cannot tell.
   */
  get serverSwap(): SwapEffect | undefined {
    return this.readSwap
  }

  /**
   * Whether the game holds plays TeamStation did not score, which this
   * session never writes or removes, so a swap stays refused whatever it
   * scores on top of them.
   */
  get holdsImported(): boolean {
    return this.derivedIndexes.size > 0
  }

  /**
   * True once a save was refused because the game's plays were reset since
   * this session opened it: nothing more is saved, nor taken up under the
   * reset game, and the screen opens the game again.
   */
  get replaced(): boolean {
    return this.isReplaced
  }

  /** Closed for good (`close`): it saves nothing more. */
  get isClosed(): boolean {
    return this.closed
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

  /**
   * Applies `action` and saves it. `time`, an ISO time, is when the change
   * was made, when not now: a lineup saved from another device's queue. It
   * is the action's time; the action plays at the time it is applied.
   */
  apply(action: ScoringAction, options: { time?: string } = {}): Applied {
    return this.append(action, true, false, options.time)
  }

  /**
   * The sides each action of `actions` changes the lineup of, or null for
   * one that is no lineup change (`lineupSides`).
   */
  get lineupSides(): Array<readonly Side[] | null> {
    return lineupSides(this.base, this.log)
  }

  /**
   * A save was refused as older than the server reads (`updateRequired`):
   * nothing more is sent from this build, and what is not saved stays on
   * `actions` for a newer one.
   */
  get outdated(): boolean {
    return this.isOutdated
  }

  /** When each action of `actions` was taken, as an ISO time, where known. */
  get actionStamps(): ReadonlyArray<string | undefined> {
    return this.actionTimes
  }

  private append(
    action: ScoringAction,
    save: boolean,
    replay = false,
    time?: string
  ): Applied {
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
      replay,
      requireCurrentSetup: !replay && this.options.requireCurrentSetup === true
    })
    if (applied.problems.length > 0)
      return {
        ...applied,
        state: this.game,
        play: this.game.liveData.plays.currentPlay
      }
    // `time` is when the change was made, on another device and maybe long
    // before: retain its authorship time for lineup reconciliation. It plays, and
    // its event is recorded, now, as it enters the log after what was
    // logged meanwhile, so the log's play times run forward.
    const now = this.now().toISOString()
    this.log.push(action)
    this.actionTimes.push(time ?? now)
    this.playbackTimes.push(now)
    this.displaced?.stamped.push(now)
    this.record(action, applied, now)
    if (!this.holding) this.align()
    if (this.blocked && this.attemptedSave != null)
      this.attemptedSave.unknownFailures = 0
    this.blocked = false
    this.dropped = null
    if (save) {
      if (action.type !== 'lineup')
        this.authorMutation(
          action.type === 'gameFlow' && action.kind === 'closePlay',
          Date.parse(time ?? now)
        )
      this.changed()
    }
    return applied
  }

  private reconcileCurrent(): void {
    const before = setupOf(this.game)
    const setup = this.options.reconcileSetup?.(before, this.game)
    if (setup == null || JSON.stringify(setup) === JSON.stringify(before))
      return
    const action: ScoringAction = { type: 'lineup', kind: 'roster', setup }
    if (this.append(action, false).problems.length === 0)
      this.readActions.add(action)
  }

  undo(authorship?: ScoringMutation): Applied {
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
    if (this.log.slice(length - 1).some(action => action.type !== 'lineup')) {
      if (
        authorship != null &&
        authorship.id !== (this.authoredMutation ?? this.knownMutation)?.id
      ) {
        this.authoredMutation = { ...authorship }
        this.mutationPending = true
      } else this.authorMutation(authorship != null)
    }
    this.settle(this.cut(length - 1))
    this.rebuild()
    this.reconcileCurrent()
    if (this.blocked && this.attemptedSave != null)
      this.attemptedSave.unknownFailures = 0
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
  sync(
    target: readonly ScoringAction[],
    retainedEvents: ReadonlyArray<{
      atBatIndex: number
      before: number
      after: number
    }> = [],
    preserveHistory = false,
    authorship?: ScoringMutation | null
  ): Problem[] {
    if (this.refusal != null) return [{ code: 'notNow', message: this.refusal }]
    // Corrections may retain actions from older scoring versions. Only exact
    // actions already in this session qualify; edited/new actions stay strict.
    const history = new Set(preserveHistory ? this.log : [])
    if (preserveHistory) {
      let trial = copyState(this.base)
      for (const action of target) {
        const applied = applyAction(trial, action, {
          inPlace: true,
          replay: history.has(action),
          requireCurrentSetup:
            !history.has(action) && this.options.requireCurrentSetup === true
        })
        if (applied.problems.length > 0) return applied.problems
        trial = applied.state
      }
    }
    const original =
      retainedEvents.length === 0
        ? null
        : { game: this.game, picture: this.picture() }
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
    const oldScoring = this.log
      .slice(same)
      .filter(action => action.type !== 'lineup')
    const newScoring = target
      .slice(same)
      .filter(action => action.type !== 'lineup')
    const authored =
      oldScoring.length !== newScoring.length ||
      oldScoring.some((action, index) => !sameAction(action, newScoring[index]))
    const automatic =
      same === this.log.length &&
      newScoring.every(
        action => action.type === 'gameFlow' && action.kind === 'closePlay'
      )
    // Resuming an automatic award may put its close in the display log.
    // Keep that normalization in the log so roster Undo sees the same history,
    // but a roster-only save does not author it as a new scoring decision.
    const rosterCompletion =
      automatic && target.slice(same).some(action => action.type === 'lineup')
    const appended = target.slice(same)
    let cut: Displaced | null = null
    let changed = false
    // The run is matched against what the cut displaced once, at its end:
    // a correction far back re-applies hundreds of actions.
    this.holding = true
    try {
      if (same < this.log.length) {
        cut = this.cut(same)
        this.rebuild()
        changed = true
      }
      for (const action of appended) {
        const applied = this.append(action, false, history.has(action))
        if (applied.problems.length > 0) return applied.problems
        if (history.has(action)) this.retainedHistory.add(action)
        changed = true
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
      // Publish the completed rewrite once. Intermediate pictures would prune
      // tag identities belonging to the unchanged at-bats being replayed.
      if (changed) {
        if (original != null) {
          const folded = this.fold()
          for (const atBatIndex of new Set(
            retainedEvents.map(event => event.atBatIndex)
          )) {
            const oldPlay = original.game.liveData.plays.allPlays.find(
              play => play.about.atBatIndex === atBatIndex
            )
            const newPlay = this.game.liveData.plays.allPlays.find(
              play => play.about.atBatIndex === atBatIndex
            )
            const before = original.picture.plays.get(atBatIndex)
            const after = folded.plays.get(atBatIndex)
            if (
              oldPlay == null ||
              newPlay == null ||
              before == null ||
              after == null
            )
              continue
            // Stored documents may insert substitution announcements or omit
            // provisional runner events. Match the retained engine events to
            // their stored positions without treating ordinals as identities.
            const indexes = (
              play: GamePlay,
              document: GumboPlay
            ): Map<number, number> => {
              const stored = (
                document.playEvents as Array<Record<string, unknown>>
              )
                .map((event, index) => ({ event, index }))
                .filter(({ event }) => event.isSubstitution !== true)
              const engine = play.playEvents.filter(
                event =>
                  event.isSubstitution !== true &&
                  (event.details.runnerEntry == null ||
                    play.runners[event.details.runnerEntry]?.details
                      .byAction === true)
              )
              return new Map(
                engine.flatMap((event, i) =>
                  stored[i] == null ? [] : [[event.index, stored[i].index]]
                )
              )
            }
            const oldIndexes = indexes(oldPlay, before)
            const newIndexes = indexes(newPlay, after)
            const metadata = tagMetadata(before)
            const events = retainedEvents
              .filter(event => event.atBatIndex === atBatIndex)
              .flatMap(event => {
                const oldIndex = oldIndexes.get(event.before)
                const index = newIndexes.get(event.after)
                const identity = metadata.events.find(
                  target => target.index === oldIndex
                )
                return identity == null ||
                  index == null ||
                  identity.signature !==
                    eventSignature((after.playEvents as unknown[])[index])
                  ? []
                  : [{ ...identity, index }]
              })
            const substitutions = tagMetadata(
              this.tagIdentities.decorate(after, true)
            ).events.filter(
              event =>
                (after.playEvents as Array<Record<string, unknown>>)[
                  event.index
                ].isSubstitution === true
            )
            this.tagIdentities.restore({
              ...after,
              tagTargets: { ...metadata, events: [...substitutions, ...events] }
            })
          }
        }
        this.picture()
        if (authored && !rosterCompletion) {
          if (
            authorship != null &&
            authorship.id !== (this.authoredMutation ?? this.knownMutation)?.id
          ) {
            this.authoredMutation = { ...authorship }
            this.mutationPending = true
          } else
            this.authorMutation(authorship === undefined ? automatic : true)
        }
        this.changed()
      }
    }
  }

  /**
   * Reads the game the server holds again and takes it up, so a change
   * somebody else saved arrives here. It does so only while nothing here is
   * waiting to be saved, so pending changes retain their observed base.
   * The optional guard also protects UI input not yet
   * represented by a pending save. Says whether the game changed.
   */
  async reload(canAdopt: () => boolean = () => true): Promise<boolean> {
    const idle = (): boolean =>
      this.context != null &&
      this.refusal == null &&
      this.running == null &&
      this.pending === 0 &&
      canAdopt()
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
    const updatesMoved =
      this.scoringUpdates.at(-1)?.id !== fresh.scoringUpdates.at(-1)?.id
    this.scoringUpdates = fresh.scoringUpdates
    this.knownMutation = fresh.knownMutation
    this.lineupsBase = fresh.lineupsBase
    this.heldPlays = fresh.heldPlays
    this.heldLineups = fresh.heldLineups
    // Taken up even when the plays are as they were: a withdrawal, or a game
    // marked under way elsewhere, changes only this.
    const swapMoved = fresh.readSwap !== this.readSwap
    this.readSwap = fresh.readSwap
    if (
      fresh.refusal === this.refusal &&
      JSON.stringify(fresh.log) === JSON.stringify(this.log) &&
      JSON.stringify(fresh.game) === JSON.stringify(this.game) &&
      JSON.stringify(fresh.eventTargets) === JSON.stringify(this.eventTargets)
    ) {
      if (swapMoved || updatesMoved) this.notify()
      return false
    }
    this.adopt(fresh)
    this.notify()
    return true
  }

  /** Takes up everything `fresh`, a new read of the same game, holds. */
  private adopt(fresh: ScoringSession): void {
    this.scoringUpdates = fresh.scoringUpdates
    this.knownMutation = fresh.knownMutation
    this.authoredMutation = undefined
    this.unconfirmedScoring = []
    this.attemptedSave = undefined
    this.mutationPending = false
    this.context = fresh.context
    this.readSwap = fresh.readSwap
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
    // No stored action reached the server after this read began.
    const readAt = this.now().getTime()
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
    const ownMutation = this.mutationPending ? this.authoredMutation : undefined
    const ordered =
      ownMutation != null &&
      (this.knownMutation != null || fresh.knownMutation != null)
    const oursWins =
      ordered &&
      (sameScoringMutation(this.knownMutation, fresh.knownMutation) ||
        this.unconfirmedScoring.some(mutation =>
          sameScoringMutation(mutation, fresh.knownMutation)
        ))
    const fork = agree(this.log, fresh.log)
    const same = oursWins ? fork : agree(this.savedLog, this.log)
    const kept = oursWins ? fork : agree(this.savedLog, fresh.log)
    const ours = this.log.slice(same)
    const theirs = fresh.log.slice(kept)
    // The latest creation time wins a lineup: each side's latest change of
    // theirs, against which each of our lineup changes is weighed.
    const ourSides = this.lineupSides.slice(same)
    const peerSides = fresh.lineupSides.slice(kept)
    // Only what other devices stored counts: the read's own actions (a roster
    // its open reconciled, stamped with the rebase's now) are no device's.
    // Each counts no later than this read, as the lineups route counts a
    // stored stamp no later than the game's last write: a device whose clock
    // runs ahead does not win every change after its own.
    const ourLatest = latestLineupChanges(
      this.lineupSides,
      this.actionTimes.map((time, index) =>
        this.readActions.has(this.log[index])
          ? undefined
          : stampTime(time) != null && stampTime(time)! > readAt
            ? new Date(readAt).toISOString()
            : time
      ),
      same
    )
    const theirLatest = latestLineupChanges(
      fresh.lineupSides,
      fresh.actionTimes.map((time, index) => {
        if (fresh.readActions.has(fresh.log[index])) return undefined
        const at = stampTime(time)
        return at == null || at <= readAt
          ? time
          : new Date(readAt).toISOString()
      }),
      kept
    )
    // Each action put back keeps the time it was taken, not the rebase's.
    const ourTimes = this.actionTimes.slice(same)
    const theirTimes = fresh.actionTimes.slice(kept)
    const ourPlaybackTimes = this.playbackTimes.slice(same)
    const theirPlaybackTimes = fresh.playbackTimes.slice(kept)
    const ourAtBats = actionAtBats(this.base, this.log).slice(same)
    const theirAtBats = actionAtBats(fresh.base, fresh.log).slice(kept)
    const protectAuthored = ordered || ownMutation == null
    const winnerActions = oursWins ? ours : fresh.log
    const winnerAtBats = oursWins
      ? ourAtBats
      : actionAtBats(fresh.base, fresh.log)
    const winnerGame = oursWins ? this.game : fresh.game
    const authoredIndexes = new Set(
      protectAuthored
        ? winnerActions.flatMap((action, index) =>
            action.type === 'lineup' ? [] : winnerAtBats[index].touched
          )
        : []
    )
    const authoredCredits = new Map(
      [
        ...winnerGame.liveData.plays.allPlays,
        ...(winnerGame.liveData.plays.currentPlay == null
          ? []
          : [winnerGame.liveData.plays.currentPlay])
      ]
        .filter(play => authoredIndexes.has(play.about.atBatIndex))
        .map(play => [play.about.atBatIndex, attributionOf(play)])
    )
    const authoredBoundary = Math.max(-1, ...authoredIndexes) + 1
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
    if (oursWins) {
      this.log = this.log.slice(0, fork)
      this.actionTimes = this.actionTimes.slice(0, fork)
      this.playbackTimes = this.playbackTimes.slice(0, fork)
      this.rebuild()
    }
    // An action of this session's undone before the server's came after it.
    const independent = oursWins
      ? theirs.flatMap((action, index) =>
          action.type === 'lineup' ? [index] : []
        )
      : []
    const own = ours.map((action, index) => ({
      action,
      time: ourTimes[index],
      playback: ourPlaybackTimes[index],
      sides: ourSides[index],
      historical: false,
      affected: ourSides[index],
      atBat: ourAtBats[index].atBat
    }))
    const peer = (index: number): (typeof own)[number] => ({
      action: theirs[index],
      time: theirTimes[index],
      playback: theirPlaybackTimes[index],
      sides: null,
      historical: true,
      affected: peerSides[index],
      atBat: theirAtBats[index].atBat
    })
    const replay: typeof own = []
    if (oursWins) {
      // A coach edit made after the competing at-bat must not change the
      // batter or pitcher credited to its replacement. Keep that boundary.
      let next = 0
      for (const entry of own) {
        while (
          next < independent.length &&
          theirAtBats[independent[next]].atBat < entry.atBat
        )
          replay.push(peer(independent[next++]))
        replay.push(entry)
      }
      for (; next < independent.length; next++)
        replay.push(peer(independent[next]))
    } else {
      if (!ordered && same < kept)
        replay.push(...theirs.map((_action, index) => peer(index)))
      replay.push(...own)
    }
    if (!ordered && same < kept) {
      this.log = this.log.slice(0, same)
      this.rebuild()
    }
    // Plays this session started keep the times it started them.
    for (const [index, time] of times)
      if (!this.times.has(index)) this.times.set(index, time)
    const refused: string[] = []
    // Preview and committed replay must scope full rosters and reject stale
    // lineup sides identically, or the preview can hide an attribution change.
    const prepare = (
      entry: (typeof own)[number],
      state: GameState,
      diagnostics?: string[]
    ): ScoringAction | null => {
      let action = entry.action
      if (
        entry.historical &&
        action.type === 'lineup' &&
        action.kind === 'roster' &&
        action.setup != null &&
        entry.affected != null
      ) {
        const setup = setupOf(state)
        const keep = entry.affected.filter(
          side => !olderThan([side], entry.time, ourLatest)
        )
        if (entry.affected.length > 0 && keep.length === 0) return null
        for (const side of keep) {
          setup.sides[side] = copyState(action.setup.sides[side])
          for (const id of setup.sides[side].players) {
            if (action.setup.players[id] != null)
              setup.players[id] = copyState(action.setup.players[id])
            if (!setup.tagOrder.includes(id)) setup.tagOrder.push(id)
          }
        }
        action = {
          ...action,
          setup,
          ...(action.effectiveSides == null &&
          keep.length === entry.affected.length
            ? {}
            : { effectiveSides: keep }),
          ...(action.confirmed == null
            ? {}
            : {
                confirmed: action.confirmed.filter(side => keep.includes(side))
              })
        }
      } else if (
        entry.historical &&
        entry.affected != null &&
        olderThan(entry.affected, entry.time, ourLatest)
      )
        return null
      if (
        ownMutation == null &&
        !entry.historical &&
        action.type === 'gameFlow' &&
        action.kind === 'closePlay'
      )
        return null
      if (ordered && !oursWins && action.type !== 'lineup') return null
      // Our lineup change of a side another device changed later is
      // dropped: theirs stands.
      const sides = entry.sides
      if (
        sides != null &&
        action.type === 'lineup' &&
        action.kind === 'roster' &&
        action.setup != null &&
        action.shown !== true
      ) {
        const keep = sides.filter(
          side => !olderThan([side], entry.time, theirLatest)
        )
        if (keep.length < sides.length)
          diagnostics?.push('another device changed that lineup later')
        if (sides.length > 0 && keep.length === 0) return null
        // A roster editor submits both sides. Replay only the sides it
        // actually changed, leaving independent coach work in place.
        const setup = setupOf(state)
        for (const side of keep) {
          setup.sides[side] = copyState(action.setup.sides[side])
          for (const id of setup.sides[side].players) {
            if (action.setup.players[id] != null)
              setup.players[id] = copyState(action.setup.players[id])
            if (!setup.tagOrder.includes(id)) setup.tagOrder.push(id)
          }
        }
        action = {
          ...action,
          setup,
          ...(action.confirmed == null
            ? {}
            : {
                confirmed: action.confirmed.filter(
                  side => !olderThan([side], entry.time, theirLatest)
                )
              })
        }
      } else if (sides != null && olderThan(sides, entry.time, theirLatest)) {
        diagnostics?.push('another device changed that lineup later')
        return null
      }
      return action
    }
    let replayedOwnScoring = false
    for (const [replayIndex, entry] of replay.entries()) {
      const original = entry.action
      let action = prepare(entry, this.game, refused)
      if (action == null) continue
      const currentIndex =
        this.game.liveData.plays.currentPlay?.about.atBatIndex ??
        this.game.liveData.plays.allPlays.length
      let changesAttribution = false
      if (
        protectAuthored &&
        (entry.historical || !oursWins) &&
        action.type === 'lineup' &&
        this.game.pending == null &&
        currentIndex < authoredBoundary
      ) {
        let trial = applyAction(copyGame(this.game), action, {
          inPlace: true,
          replay: true
        })
        // A delayed batch may contain several already-authored appearances.
        // Test the remaining local suffix, not just the current matchup: a
        // future batter reorder can be safe now but change its next play.
        const trialLog = [...this.log, action]
        for (const remaining of replay.slice(replayIndex + 1)) {
          if (remaining.historical || trial.problems.length > 0) continue
          const prepared = prepare(remaining, trial.state)
          if (prepared == null) continue
          const roster = reconcileShownLineup(prepared, trialLog, trial.state)
          if (roster == null) continue
          const historical =
            roster === prepared && this.retainedHistory.has(remaining.action)
          trial = applyAction(trial.state, roster, {
            inPlace: true,
            replay: historical,
            requireCurrentSetup:
              !historical && this.options.requireCurrentSetup === true
          })
          trialLog.push(roster)
        }
        changesAttribution =
          trial.problems.length > 0 ||
          [
            ...trial.state.liveData.plays.allPlays,
            ...(trial.state.liveData.plays.currentPlay == null
              ? []
              : [trial.state.liveData.plays.currentPlay])
          ].some(play => {
            const before = authoredCredits.get(play.about.atBatIndex)
            return before != null && before !== attributionOf(play)
          })
      }
      if (
        protectAuthored &&
        (entry.historical || !oursWins) &&
        action.type === 'lineup' &&
        ((ordered && entry.atBat > currentIndex) ||
          this.game.pending != null ||
          changesAttribution)
      )
        action = {
          ...action,
          effectiveAtBat: Math.max(
            action.effectiveAtBat ?? 0,
            ordered ? entry.atBat : currentIndex,
            changesAttribution || this.game.pending != null
              ? authoredBoundary
              : 0,
            currentIndex +
              (this.game.pending == null && !changesAttribution ? 0 : 1)
          ),
          effectiveSides: [
            ...(action.effectiveSides ??
              (action.side == null
                ? (entry.affected ?? ['away', 'home'])
                : [action.side]))
          ]
        }
      // A roster the screen logged while showing a default in place of an
      // unseen order. It replaces only a side that is still that order.
      // Every other side stays as the server holds it, and the pitch that
      // follows is scored from that lineup.
      const roster = reconcileShownLineup(action, this.log, this.game)
      if (roster == null) continue
      const historical =
        entry.historical ||
        (roster === action && this.retainedHistory.has(original))
      const applied = applyAction(copyGame(this.game), roster, {
        inPlace: true,
        requireCurrentSetup:
          !historical && this.options.requireCurrentSetup === true,
        replay: historical
      })
      if (applied.problems.length > 0) {
        refused.push(applied.problems[0].message)
        continue
      }
      // An action that had no time, scored by an app before actions carried
      // them, stays without one; its play keeps only its own times.
      const time = entry.time
      if (!entry.historical && roster.type !== 'lineup')
        replayedOwnScoring = true
      if (historical) this.retainedHistory.add(roster)
      this.log.push(roster)
      this.actionTimes.push(time)
      this.playbackTimes.push(entry.playback)
      this.record(roster, applied, time ?? this.now().toISOString())
    }
    this.dropped =
      lost > 0
        ? `Home and away were swapped, so ${lost === 1 ? 'a change' : `${lost} changes`} not yet saved before the swap ${lost === 1 ? 'was' : 'were'} not kept.`
        : refused.length === 0
          ? null
          : `${refused.length === 1 ? 'A change' : `${refused.length} changes`} could not follow another device's lineup change: ${refused[0]}`
    this.authoredMutation =
      !swapped && ownMutation != null && (!ordered || oursWins)
        ? { ...ownMutation, revision: ownMutation.revision + 1 }
        : undefined
    this.mutationPending = this.authoredMutation != null
    this.rebasedPeer =
      swapped ||
      (ordered && !oursWins) ||
      (ownMutation == null && !replayedOwnScoring)
    this.rebaseCount++
    this.isOffline = false
    this.retryMs = FIRST_RETRY_MS
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
    if (!this.holding) this.picture()
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

  /**
   * The whole game as this engine folds it, in its stored form: every play,
   * the at-bat in progress, and every stored index the log no longer makes.
   * What a newer build sends in place of a save an older one queued, once it
   * has played that save's log again.
   */
  wholeChange(): SaveChange {
    const picture = this.picture()
    const reopened = this.atBatOpen
      ? this.game.liveData.plays.allPlays.length
      : null
    return storedChange(
      this.scoringMetadata({
        plays: [...picture.plays.values()],
        remove: [...this.stored]
          .filter(index => !picture.plays.has(index) && index !== reopened)
          .sort((a, b) => a - b),
        currentPlay: picture.current,
        fenceDistanceFt: fenceOf(this.game)
      })
    )
  }

  private scoringMetadata(change: SaveChange): SaveChange {
    const mutation = this.mutationPending ? this.authoredMutation : undefined
    if (mutation != null) {
      const picture = this.picture()
      // Keep ancestry for durable lineup recovery. It never authorizes a
      // scoring write after another timeline has displaced its observed base.
      change.scoringHistory = [...picture.plays.values()]
      change.scoringBase = this.knownMutation ?? null
      // An accepted current-version Undo can rewind its tail. Always state its
      // current play explicitly; omission means unchanged for legacy writes.
      change.currentPlay = picture.current
      change.scoringMutation = {
        ...mutation,
        frontier:
          picture.current?.about.atBatIndex ??
          Math.max(
            -1,
            ...[
              ...this.importedDocuments.keys(),
              ...picture.plays.keys()
            ].filter(index => index !== FINAL_INDEX)
          ) + 1
      }
    }
    change.scoringBase = this.knownMutation ?? null
    return change
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
    const current = writtenCurrent(picture.current)
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
    if (
      this.refusal != null ||
      this.blocked ||
      this.isOutdated ||
      this.closed ||
      this.isReplaced
    )
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
        this.isOutdated ||
        this.closed ||
        this.isReplaced
      )
        return
      const mutation = this.mutationPending ? this.authoredMutation : undefined
      if (this.attemptedSave == null) {
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
        this.scoringMetadata(change)
        const lineupKey = (log: readonly ScoringAction[]): string =>
          JSON.stringify(
            log
              .filter(
                action =>
                  action.type === 'lineup' && !this.readActions.has(action)
              )
              .map(keyOf)
          )
        if (
          this.context != null &&
          (mutation == null || lineupKey(this.log) !== lineupKey(this.savedLog))
        )
          change.deviceLineupRecovery = {
            baseline: {
              plays: [
                ...this.importedDocuments.values(),
                ...[...this.posted.values()].map(
                  text => JSON.parse(text) as GumboPlay
                )
              ],
              currentPlay:
                this.postedCurrent == null
                  ? null
                  : (JSON.parse(this.postedCurrent) as CurrentPlay | null),
              scoringMutation: this.knownMutation,
              lineupsDigest: this.lineupsBase,
              generation: this.openedGeneration
            },
            context: { ...this.context, fenceDistanceFt: fenceOf(this.game) }
          }
        // A plain browser save can commit while its reply is lost. Retain the
        // attempted identity so a later read recognizes our accepted ancestor,
        // without granting ownership of a subsequent peer's scoring identity.
        if (
          change.scoringMutation != null &&
          !this.unconfirmedScoring.some(sent =>
            sameScoringMutation(sent, change.scoringMutation)
          )
        )
          this.unconfirmedScoring.push(change.scoringMutation)
        this.attemptedSave = {
          mutation,
          change,
          request: {
            ...storedChange(change),
            log: {
              actions: covering,
              times: coveringTimes.map(time => time ?? null)
            },
            ...(this.lineupsBase === undefined
              ? {}
              : { lineupsBase: this.lineupsBase }),
            ...(this.openedGeneration === undefined
              ? {}
              : { generation: this.openedGeneration })
          },
          covering,
          times: coveringTimes,
          playbackTimes: coveringPlaybackTimes,
          tags: new Map(),
          sends: 0,
          unknownFailures: 0
        }
      }
      const attempt = this.attemptedSave
      const {
        change,
        covering,
        times: coveringTimes,
        playbackTimes: coveringPlaybackTimes
      } = attempt
      let answer: PostedEdits | StoredGame | undefined
      try {
        attempt.sends++
        answer = await this.store.save(this.gameId, attempt.request)
      } catch (error) {
        const code = error instanceof HttpError ? error.code : null
        if (
          [
            'badRequest',
            'forbidden',
            'notFound',
            'conflict',
            'gone',
            'tooLarge',
            'unsupportedMedia',
            'membersOnly',
            'invalidLocation'
          ].includes(code ?? '')
        )
          this.attemptedSave = undefined
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
        this.failed(error, true)
        return
      }
      // An equal-identity retry may answer with a coach's newer lineup
      // digest. Read those documents before claiming to hold that version.
      const retryLineupsMoved =
        attempt.sends > 1 &&
        answer?.lineupsDigest !== undefined &&
        answer.lineupsDigest !== attempt.request.lineupsBase
      const scoringMoved =
        attempt.request.scoringMutation != null &&
        answer?.scoringMutation != null &&
        !sameScoringMutation(
          answer.scoringMutation,
          attempt.request.scoringMutation
        )
      if (
        (answer?.superseded === true || retryLineupsMoved || scoringMoved) &&
        this.context != null
      ) {
        try {
          await this.rebase()
        } catch (reading) {
          this.failed(reading)
          return
        }
        continue
      }
      this.attemptedSave = undefined
      this.unconfirmedScoring = []
      if (this.authoredMutation === attempt.mutation)
        this.mutationPending = false
      if (answer?.scoringUpdates != null)
        this.scoringUpdates = answer.scoringUpdates
      if (answer?.scoringMutation != null)
        this.knownMutation = answer.scoringMutation
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
      // Tags acknowledged while this request was in flight belong in its
      // baseline, without acknowledging any newer scoring actions.
      const annotated = <T extends TagDocument>(play: T): T => {
        if (attempt.tags.size === 0) return play
        // These documents were produced by our folder. Preserve their key
        // order too: the pending comparison uses their serialized form.
        const metadata = play.tagTargets as TagMetadata
        const label = <T extends { id: string; tag: string | null }>(
          target: T
        ): T =>
          attempt.tags.has(target.id)
            ? { ...target, tag: attempt.tags.get(target.id) ?? null }
            : target
        return {
          ...play,
          tagTargets: {
            ...metadata,
            play: metadata.play == null ? null : label(metadata.play),
            events: metadata.events.map(label)
          }
        }
      }
      for (const play of change.plays) {
        this.posted.set(play.about.atBatIndex, written(annotated(play)))
        this.stored.add(play.about.atBatIndex)
      }
      for (const index of change.remove) {
        this.posted.delete(index)
        this.stored.delete(index)
      }
      if (change.currentPlay !== undefined)
        this.postedCurrent = writtenCurrent(
          change.currentPlay == null ? null : annotated(change.currentPlay)
        )
      this.savedLog = covering
      this.savedTimes = coveringTimes
      this.savedPlaybackTimes = coveringPlaybackTimes
      this.isOffline = false
      this.failure = null
      this.retryMs = FIRST_RETRY_MS
      this.notify()
    }
  }

  private failed(error: unknown, retryUnknown = false): void {
    const code = error instanceof HttpError ? error.code : null
    if (this.attemptedSave != null) {
      if (code != null) this.attemptedSave.unknownFailures = 0
      else if (retryUnknown) this.attemptedSave.unknownFailures++
    }
    const message = error instanceof Error ? error.message : String(error)
    // This build is older than the server reads: what is not saved stays,
    // and nothing more is sent until the update the notice asks for.
    if (isUpdateRequired(error)) {
      this.failure = message
      this.isOffline = false
      this.isOutdated = true
      this.notify()
      return
    }
    // Signed out, the scorer signs in again and the waiting changes go then.
    // Lineups that keep changing under each read are tried again later.
    if (
      (code == null &&
        retryUnknown &&
        (this.attemptedSave?.unknownFailures ?? 0) < 3) ||
      code === 'offline' ||
      code === 'rateLimited' ||
      code === 'internal' ||
      code === 'unavailable' ||
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
