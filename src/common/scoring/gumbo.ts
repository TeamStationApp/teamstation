import { asArray, asObject, asUnknown, type Cleaner } from 'cleaners'

import { asLiteral } from '../asLiteral'
import { eventTypeName } from '../gumboEventTypes'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import { cleanAction, type Problem, type ScoringAction } from './actions'
import { type Applied, applyAction } from './apply'
import {
  currentDocumentOf,
  documentOf,
  FINAL_INDEX,
  finalDocumentOf,
  PlayFolder,
  type PlayStamp
} from './document'
import {
  freshGame,
  ordinal,
  refOf,
  startAppearance,
  updateDefense
} from './lineup'
import {
  asGamePlay,
  asGameSetup,
  copyGame,
  copyState,
  type GamePlay,
  type GameSetup,
  type GameState,
  type GameTeam,
  setupOf,
  type Side
} from './state'

/**
 * A play as TeamStation stores it: a Gumbo document naming every player by
 * the server's user id, never by a session id, with TeamStation's own record
 * beside it — the setup as it stood before the play and the actions that made
 * it — so the game can be rebuilt exactly as it was scored.
 */

export interface TeamStationRecord {
  version: 1
  /** The rosters and lineups as they stood before this play's first action. */
  setupBefore: GameSetup
  /** The actions of this play, in order, lineup changes included. */
  actions: ScoringAction[]
  /**
   * When each action was taken, on the server's clock, as ISO times: one per
   * action, in the same order. A play scored before actions carried times, or
   * with an action that has none, has only the play's own times.
   */
  actionTimes?: string[]
  /** What the scoring screen recorded that Gumbo has no place for. */
  detail?: unknown
}

const asRecord: Cleaner<TeamStationRecord> = asObject({
  version: asLiteral(1),
  setupBefore: asGameSetup,
  actions: asArray(asUnknown),
  actionTimes: asUnknown,
  detail: asUnknown
}) as Cleaner<TeamStationRecord>

/**
 * Each stored record, as `recordOf` read it. A save reads the game's lineups,
 * which reads every record and then replays them, reading each again;
 * cleaning a record's setup was half of what that cost.
 */
const readRecords = new WeakMap<object, TeamStationRecord | null>()

/** The record on a stored play, or null for one TeamStation did not score. */
export function recordOf(play: unknown): TeamStationRecord | null {
  if (play == null || typeof play !== 'object') return null
  const raw = (play as { teamStation?: unknown }).teamStation
  if (raw == null) return null
  if (typeof raw !== 'object') return cleanRecord(raw)
  if (!readRecords.has(raw)) readRecords.set(raw, cleanRecord(raw))
  return readRecords.get(raw) ?? null
}

function cleanRecord(raw: unknown): TeamStationRecord | null {
  try {
    const { actionTimes, ...record } = asRecord(raw)
    const actions: ScoringAction[] = []
    for (const action of record.actions) {
      const cleaned = cleanAction(action)
      if ('problem' in cleaned) return null
      actions.push(cleaned.action)
    }
    // Times that do not line up with the actions name no action's moment, so
    // they are dropped and the play is read as one scored before them.
    const timed =
      Array.isArray(actionTimes) &&
      actionTimes.length === actions.length &&
      actionTimes.every(time => typeof time === 'string')
    return { ...record, actions, ...(timed ? { actionTimes } : {}) }
  } catch {
    return null
  }
}

export type { PlayStamp }

/** A completed play, ready to store. */
export function foldPlay(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp
): GumboPlay {
  return documentOf(state, play, stamp)
}

/** The at-bat in progress, or the place of one whose batter is on base. */
export function foldCurrentPlay(
  state: GameState,
  play: GamePlay | null,
  stamp: PlayStamp
): CurrentPlay {
  return currentDocumentOf(state, play, stamp)
}

/**
 * Folds several plays of one game, taken in the game's order, in one pass
 * over it: `play` for each completed play, then `current` for the at-bat in
 * progress.
 */
export function playFolder(state: GameState): PlayFolder {
  return new PlayFolder(state)
}

/** The last play of a game, at index 9999: its final score. */
export { FINAL_INDEX }
export function foldFinal(state: GameState, stamp: PlayStamp): GumboPlay {
  return finalDocumentOf(state, stamp)
}

/** One play's share of the log: the setup it started from and its actions. */
export interface Segment {
  setupBefore: GameSetup
  actions: ScoringAction[]
  startTime?: string | null
}

/**
 * Splits the log into plays as an action lands. An action belongs to the play
 * it was taken in, and a play ends with the action that completed it — except
 * when the action first closed a play that was already decided, as the next
 * pitch does: then it is the first action of the next play.
 */
export function segmentAfter(
  before: GameState,
  action: ScoringAction,
  applied: Applied,
  current: Segment
): { finished: Array<{ play: GamePlay; segment: Segment }>; current: Segment } {
  const completed = applied.state.liveData.plays.allPlays.slice(
    before.liveData.plays.allPlays.length
  )
  if (completed.length === 0)
    return {
      finished: [],
      current: { ...current, actions: [...current.actions, action] }
    }
  const finished: Array<{ play: GamePlay; segment: Segment }> = []
  let segment = current
  let rest = completed
  if (applied.transitions[0]?.type === 'playClosed') {
    finished.push({ play: completed[0], segment })
    const closed = applyAction(
      copyGame(before),
      { type: 'gameFlow', kind: 'closePlay' },
      { inPlace: true }
    )
    segment = { setupBefore: setupOf(closed.state), actions: [action] }
    rest = completed.slice(1)
  } else segment = { ...segment, actions: [...segment.actions, action] }
  for (const play of rest) {
    finished.push({ play, segment })
    segment = { setupBefore: setupOf(applied.state), actions: [] }
  }
  return { finished, current: segment }
}

export interface Replayed {
  state: GameState
  /** The game before any logged action: fresh, or after the derived plays. */
  base: GameState
  /**
   * Each logged play's actions, in order: completed plays, then the current
   * one, with the time each was taken where its record holds one.
   */
  segments: Array<{
    atBatIndex: number
    actions: ScoringAction[]
    actionTimes: Array<string | undefined>
  }>
  /** Plays rebuilt from their documents, which cannot be undone into. */
  derived: number
  /** An action that no longer applies, and everything after it, is dropped. */
  problems: Problem[]
}

/**
 * Rebuilds a game from what the server stored. Plays before the first one
 * TeamStation scored are read from their documents. At that play the lineup,
 * the defence and the order come from its `setupBefore`, read once; from
 * there every play's actions are applied in order, the current play's last.
 * A completed play at the current play's index was reopened by an undo, so
 * only the current play's actions count for it.
 */
export function replayPlays(
  stored: { plays: GumboPlay[]; currentPlay: CurrentPlay | null },
  context: {
    gamePk: string
    teams: Record<Side, GameTeam>
    setup: GameSetup
    fenceDistanceFt?: number
  }
): Replayed {
  const reopened = stored.currentPlay?.about.atBatIndex
  const plays = [...stored.plays]
    .filter(play => play.about.atBatIndex !== reopened)
    .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
  const records = plays.map(recordOf)
  const firstLogged = records.findIndex(record => record != null)
  const currentRecord = recordOf(stored.currentPlay)
  const prefix = firstLogged < 0 ? plays : plays.slice(0, firstLogged)
  const setup =
    (firstLogged < 0 ? null : records[firstLogged]?.setupBefore) ??
    currentRecord?.setupBefore ??
    context.setup
  let state = freshGame(
    context.gamePk,
    context.teams,
    setup,
    context.fenceDistanceFt
  )
  if (prefix.length > 0) state = fromDocuments(state, prefix)
  const base = state
  const segments: Replayed['segments'] = []
  const problems: Problem[] = []
  const logged: Array<{ atBatIndex: number; record: TeamStationRecord }> = []
  if (firstLogged >= 0)
    plays.slice(firstLogged).forEach((play, i) => {
      const record = records[firstLogged + i]
      if (record != null)
        logged.push({ atBatIndex: play.about.atBatIndex, record })
    })
  if (stored.currentPlay != null && currentRecord != null)
    logged.push({
      atBatIndex: stored.currentPlay.about.atBatIndex,
      record: currentRecord
    })
  for (const { atBatIndex, record } of logged) {
    const kept: ScoringAction[] = []
    const times: Array<string | undefined> = []
    for (const [i, action] of record.actions.entries()) {
      if (problems.length > 0) break
      // `copyGame` shares the finished plays an earlier copy made, where
      // `applyAction`'s own copy copies every one of them again: at 85 plate
      // appearances that made a replay 330 ms, and every save replays the
      // game to keep its lineups. A refused action leaves `state` whole.
      const applied = applyAction(copyGame(state), action, { inPlace: true })
      if (applied.problems.length > 0) {
        problems.push(...applied.problems)
        break
      }
      state = applied.state
      kept.push(action)
      times.push(record.actionTimes?.[i])
    }
    segments.push({ atBatIndex, actions: kept, actionTimes: times })
  }
  return { state, base, segments, derived: prefix.length, problems }
}

/** A player named on a stored play, by his user id, as this game knows him. */
function sessionId(state: GameState, raw: unknown): number | null {
  if (raw == null || typeof raw !== 'object') return null
  const id = (raw as { id?: unknown }).id
  if (typeof id !== 'number') return null
  return state.meta.identities.sourceToSession[`number:${id}`] ?? null
}

/** A base as a document names it: a number, or `'1B'` to `'3B'`. */
function baseNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  return raw === '1B' ? 1 : raw === '2B' ? 2 : raw === '3B' ? 3 : 0
}

/**
 * The state a run of plays TeamStation did not score leaves behind: the half,
 * the outs, the score, who is on base and who bats next. Each play stands in
 * the game's list so the next play takes the next index.
 */
function fromDocuments(start: GameState, plays: GumboPlay[]): GameState {
  const state = copyState(start)
  const line = state.liveData.linescore
  let half: 'top' | 'bottom' = 'top'
  let inning = 1
  let outs = 0
  let bases: Array<number | null> = [null, null, null]
  const placeholder = (index: number, doc: GumboPlay | null): GamePlay =>
    asGamePlay({
      about: {
        atBatIndex: index,
        inning: doc?.about.inning ?? inning,
        halfInning: doc?.about.halfInning ?? half,
        isComplete: true
      },
      result: {
        event: doc == null ? '' : eventTypeName(doc.result.eventType),
        eventType: doc?.result.eventType ?? '',
        description: '',
        awayScore: doc?.result.awayScore ?? line.teams.away.runs,
        homeScore: doc?.result.homeScore ?? line.teams.home.runs,
        rbi: doc?.result.rbi ?? 0
      },
      count: { balls: 0, strikes: 0, outs },
      matchup: {
        batter: { id: 0, fullName: '' },
        pitcher: { id: 0, fullName: '' },
        batSide: { code: 'R' }
      },
      runners: [],
      playEvents: [],
      source: {
        system: 'teamstation',
        teamstation: { version: 'estimated-v1', outcome: '' }
      }
    })
  for (const doc of plays) {
    while (state.liveData.plays.allPlays.length < doc.about.atBatIndex)
      state.liveData.plays.allPlays.push(
        placeholder(state.liveData.plays.allPlays.length, null)
      )
    const docHalf: 'top' | 'bottom' =
      doc.about.halfInning === 'bottom'
        ? 'bottom'
        : doc.about.halfInning === 'top'
          ? 'top'
          : half
    const docInning = doc.about.inning ?? inning
    if (docHalf !== half || docInning !== inning) {
      half = docHalf
      inning = docInning
      outs = 0
      bases = [null, null, null]
    }
    // Only TeamStation's documents list every runner; an imported play's
    // runners are left for the scorer to place by hand.
    const runners = 'teamStation' in doc ? (doc.runners ?? []) : []
    for (const runner of runners) {
      const id = sessionId(state, runner.details?.runner)
      if (id == null) continue
      bases = bases.map(base => (base === id ? null : base))
      const movement = (
        runner as { movement?: { isOut?: unknown; end?: unknown } }
      ).movement
      const end = baseNumber(movement?.end)
      if (movement?.isOut !== true && end >= 1 && end <= 3) bases[end - 1] = id
    }
    outs = doc.about.halfOuts ?? doc.count?.outs ?? outs
    if (doc.result.awayScore != null)
      line.teams.away.runs = doc.result.awayScore
    if (doc.result.homeScore != null)
      line.teams.home.runs = doc.result.homeScore
    const batter = sessionId(state, doc.matchup?.batter)
    const side: Side = half === 'top' ? 'away' : 'home'
    const order = state.liveData.boxscore.teams[side]
    if (batter != null && order.battingOrder.includes(batter))
      order.battingIndex =
        (order.battingOrder.indexOf(batter) + 1) % order.battingOrder.length
    state.liveData.plays.allPlays.push(placeholder(doc.about.atBatIndex, doc))
  }
  if (outs >= 3) {
    if (half === 'bottom') inning++
    half = half === 'top' ? 'bottom' : 'top'
    outs = 0
    bases = [null, null, null]
  }
  line.currentInning = inning
  line.currentInningOrdinal = ordinal(inning)
  line.isTopInning = half === 'top'
  line.inningState = half === 'top' ? 'Top' : 'Bottom'
  line.outs = outs
  line.balls = 0
  line.strikes = 0
  line.offense = {
    batter: null,
    first: refOf(state, bases[0]),
    second: refOf(state, bases[1]),
    third: refOf(state, bases[2])
  }
  updateDefense(state)
  state.meta.derived = true
  state.awaitingBatter = startAppearance(state)
  return state
}
