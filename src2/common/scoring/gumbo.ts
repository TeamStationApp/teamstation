import { asArray, asObject, asUnknown, asValue, type Cleaner } from 'cleaners'

import { eventTypeName } from '../gumboEventTypes'
import {
  asCurrentPlay,
  asGumboPlay,
  type CurrentPlay,
  type GumboPlay
} from '../gumboPlay'
import { cleanAction, type Problem, type ScoringAction } from './actions'
import { type Applied, applyAction } from './apply'
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
  copyState,
  type GamePlay,
  type GameSetup,
  type GameState,
  type GameTeam,
  type PlayerRef,
  setupOf,
  type Side,
  withoutUndefined
} from './state'

/**
 * A play as GameStation stores it: a Gumbo document naming every player by
 * the server's user id, never by a session id, with GameStation's own record
 * beside it — the setup as it stood before the play and the actions that made
 * it — so the game can be rebuilt exactly as it was scored.
 */

export interface GameStationRecord {
  version: 1
  /** The rosters and lineups as they stood before this play's first action. */
  setupBefore: GameSetup
  /** The actions of this play, in order, lineup changes included. */
  actions: ScoringAction[]
  /** What the scoring screen recorded that Gumbo has no place for. */
  detail?: unknown
}

const asRecord: Cleaner<GameStationRecord> = asObject({
  version: asValue(1),
  setupBefore: asGameSetup,
  actions: asArray(asUnknown),
  detail: asUnknown
}) as Cleaner<GameStationRecord>

/** The record on a stored play, or null for one GameStation did not score. */
export function recordOf(play: unknown): GameStationRecord | null {
  if (play == null || typeof play !== 'object') return null
  const raw = (play as { gameStation?: unknown }).gameStation
  if (raw == null) return null
  try {
    const record = asRecord(raw)
    const actions: ScoringAction[] = []
    for (const action of record.actions) {
      const cleaned = cleanAction(action)
      if ('problem' in cleaned) return null
      actions.push(cleaned.action)
    }
    return { ...record, actions }
  } catch {
    return null
  }
}

export interface PlayStamp {
  setupBefore: GameSetup
  actions: ScoringAction[]
  startTime?: string | null
  endTime?: string | null
}

interface Person {
  id?: number
  fullName: string
}

function playerOf(
  state: GameState,
  setup: GameSetup,
  id: number
): { userId: number | null; fullName: string; teamId: string } | null {
  const player = state.gameData.players[id] ?? setup.players[id]
  return player == null
    ? null
    : {
        userId: player.userId,
        fullName: player.fullName,
        teamId: player.teamId
      }
}

/** A player as a stored play names him: his user id, or only his name. */
function person(state: GameState, setup: GameSetup, ref: PlayerRef): Person {
  const player = playerOf(state, setup, ref.id)
  const fullName = player?.fullName ?? ref.fullName
  return player?.userId == null ? { fullName } : { id: player.userId, fullName }
}

function sideOf(state: GameState, teamId: string | undefined): Side {
  return teamId === state.gameData.teams.home.id ? 'home' : 'away'
}

interface HighlightCredit {
  eventType: string
  label: string
  teamId: Side
  creditUserId: number | null
  credit: { name: string; role: string; position: string | null }
}

const BATTER_CREDITED = new Set([
  'single',
  'double',
  'triple',
  'home_run',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'catcher_interference',
  'manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt'
])
const PITCHER_CREDITED = new Set(['strikeout', 'strikeout_double_play'])
const FIELDER_CREDITED = new Set([
  'field_out',
  'other_out',
  'grounded_into_double_play',
  'triple_play',
  'caught_stealing',
  'pickoff_1b',
  'pickoff_2b',
  'pickoff_3b'
])

/**
 * The credits a highlight shows for a completed play: the batter who reached,
 * the pitcher who struck him out, the fielders who made the outs, and each
 * runner who scored or stole. A play nobody did anything worth watching on
 * carries an empty list.
 */
function highlightCredits(
  state: GameState,
  setup: GameSetup,
  play: GamePlay
): HighlightCredit[] {
  const type = play.result.eventType
  const credits: HighlightCredit[] = []
  const add = (
    ref: PlayerRef,
    eventType: string,
    head: string,
    role: string,
    position: string | null = null,
    detail = ''
  ): void => {
    const player = playerOf(state, setup, ref.id)
    const name = player?.fullName ?? ref.fullName
    credits.push({
      eventType,
      label: `${head}: ${name}${position == null ? '' : ` (${position})`}${detail}`,
      teamId: sideOf(state, player?.teamId),
      creditUserId: player?.userId ?? null,
      credit: { name, role, position }
    })
  }
  if (BATTER_CREDITED.has(type))
    add(play.matchup.batter, type, eventTypeName(type), 'batter')
  if (PITCHER_CREDITED.has(type))
    add(play.matchup.pitcher, type, eventTypeName(type), 'pitcher')
  if (FIELDER_CREDITED.has(type))
    for (const runner of play.runners)
      if (runner.movement.isOut) {
        const putout = runner.credits.find(c => c.credit === 'f_putout')
        if (putout == null) continue
        const assists = runner.credits
          .filter(c => c.credit === 'f_assist')
          .map(c => `${c.player.fullName} (${c.position})`)
        add(
          putout.player,
          type,
          runner.movement.end === 0
            ? 'Out'
            : `Out at ${runner.movement.end === 4 ? 'home' : ordinal(runner.movement.end)}`,
          'fielder',
          putout.position,
          assists.length === 0 ? '' : ` from ${assists.join(', ')}`
        )
      }
  for (const runner of play.runners) {
    if (runner.movement.runScored === true && !runner.movement.isOut)
      add(runner.details.runner, 'run', 'Run', 'runner')
    if (runner.details.movementReason === 'Steal' && !runner.movement.isOut)
      add(runner.details.runner, 'stolen_base', 'Stolen base', 'runner')
  }
  return credits
}

function documentBody(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp
): Record<string, unknown> {
  const setup = stamp.setupBefore
  const who = (ref: PlayerRef): Person => person(state, setup, ref)
  return {
    about: {
      atBatIndex: play.about.atBatIndex,
      inning: play.about.inning,
      halfInning: play.about.halfInning,
      isComplete: play.about.isComplete,
      isScoringPlay: play.runners.some(
        runner => runner.movement.runScored === true && !runner.movement.isOut
      ),
      startTime: stamp.startTime ?? null,
      endTime: stamp.endTime ?? null
    },
    count: { ...play.count },
    matchup: {
      batter: who(play.matchup.batter),
      pitcher: who(play.matchup.pitcher),
      batSide: { code: play.matchup.batSide.code }
    },
    runners: play.runners.map(runner => ({
      movement: { ...runner.movement },
      details: {
        runner: who(runner.details.runner),
        movementReason: runner.details.movementReason
      },
      credits: runner.credits.map(credit => ({
        player: who(credit.player),
        position: { abbreviation: credit.position },
        credit: credit.credit
      }))
    })),
    playEvents: play.playEvents.map(event => ({
      index: event.index,
      isPitch: event.isPitch,
      type: event.type,
      details: { ...event.details },
      count: { ...event.count },
      player: who(event.player)
    })),
    ...(play.hitData == null
      ? {}
      : {
          hitData: {
            launchAngle: play.hitData.launchAngle,
            trajectory: play.hitData.trajectory,
            coordinates: { ...play.hitData.coordinates },
            ...(play.hitData.fielder == null
              ? {}
              : { fielder: who(play.hitData.fielder) })
          }
        }),
    gameStation: {
      version: 1,
      setupBefore: stamp.setupBefore,
      actions: stamp.actions,
      detail: play.source.gamestation
    }
  }
}

/** A completed play, ready to store. */
export function foldPlay(
  state: GameState,
  play: GamePlay,
  stamp: PlayStamp
): GumboPlay {
  return asGumboPlay(
    withoutUndefined({
      ...documentBody(state, play, stamp),
      result: {
        type: 'atBat',
        event: play.result.event,
        eventType: play.result.eventType,
        description: play.result.description,
        rbi: play.result.rbi,
        awayScore: play.result.awayScore,
        homeScore: play.result.homeScore
      },
      credits: highlightCredits(state, stamp.setupBefore, play)
    })
  )
}

/**
 * The at-bat in progress: no outcome and no score, because it has none yet.
 * When the batter due is on base there is no play, and the record rides on a
 * play that names only its place in the game.
 */
export function foldCurrentPlay(
  state: GameState,
  play: GamePlay | null,
  stamp: PlayStamp
): CurrentPlay {
  if (play == null) {
    const line = state.liveData.linescore
    return asCurrentPlay({
      about: {
        atBatIndex: state.liveData.plays.allPlays.length,
        inning: line.currentInning,
        halfInning: line.isTopInning ? 'top' : 'bottom',
        isComplete: false
      },
      gameStation: {
        version: 1,
        setupBefore: stamp.setupBefore,
        actions: stamp.actions
      }
    })
  }
  const body = documentBody(state, play, stamp)
  return asCurrentPlay(
    withoutUndefined({
      ...body,
      about: { ...(body.about as object), isComplete: false }
    })
  )
}

/** The last play of a game, at index 9999: its final score. */
export const FINAL_INDEX = 9999
export function foldFinal(state: GameState, stamp: PlayStamp): GumboPlay {
  const line = state.liveData.linescore
  return asGumboPlay({
    about: {
      atBatIndex: FINAL_INDEX,
      inning: line.currentInning,
      halfInning: line.isTopInning ? 'top' : 'bottom',
      isComplete: true,
      startTime: stamp.startTime ?? null,
      endTime: stamp.endTime ?? null
    },
    result: {
      type: 'atBat',
      event: 'Game over',
      eventType: 'final_score',
      description: 'Game over',
      awayScore: line.teams.away.runs,
      homeScore: line.teams.home.runs,
      rbi: 0
    },
    credits: [],
    gameStation: {
      version: 1,
      setupBefore: stamp.setupBefore,
      actions: stamp.actions
    }
  })
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
    const closed = applyAction(before, { type: 'gameFlow', kind: 'closePlay' })
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
  /** Each logged play's actions, in order: completed plays, then the current one. */
  segments: Array<{ atBatIndex: number; actions: ScoringAction[] }>
  /** Plays rebuilt from their documents, which cannot be undone into. */
  derived: number
  /** An action that no longer applies, and everything after it, is dropped. */
  problems: Problem[]
}

/**
 * Rebuilds a game from what the server stored. Plays before the first one
 * GameStation scored are read from their documents. At that play the lineup,
 * the defence and the order come from its `setupBefore`, read once; from
 * there every play's actions are applied in order, the current play's last.
 * A completed play at the current play's index was reopened by an undo, so
 * only the current play's actions count for it.
 */
export function replayPlays(
  stored: { plays: GumboPlay[]; currentPlay: CurrentPlay | null },
  context: { gamePk: string; teams: Record<Side, GameTeam>; setup: GameSetup }
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
  let state = freshGame(context.gamePk, context.teams, setup)
  if (prefix.length > 0) state = fromDocuments(state, prefix)
  const segments: Replayed['segments'] = []
  const problems: Problem[] = []
  const logged: Array<{ atBatIndex: number; record: GameStationRecord }> = []
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
    for (const action of record.actions) {
      if (problems.length > 0) break
      const applied = applyAction(state, action)
      if (applied.problems.length > 0) {
        problems.push(...applied.problems)
        break
      }
      state = applied.state
      kept.push(action)
    }
    segments.push({ atBatIndex, actions: kept })
  }
  return { state, segments, derived: prefix.length, problems }
}

/** A player named on a stored play, by his user id, as this game knows him. */
function sessionId(state: GameState, raw: unknown): number | null {
  if (raw == null || typeof raw !== 'object') return null
  const id = (raw as { id?: unknown }).id
  if (typeof id !== 'number') return null
  return state.meta.identities.sourceToSession[`number:${id}`] ?? null
}

/**
 * The state a run of plays GameStation did not score leaves behind: the half,
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
        system: 'gamestation',
        gamestation: { version: 'estimated-v1', outcome: '' }
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
    for (const runner of doc.runners ?? []) {
      const id = sessionId(state, runner.details?.runner)
      if (id == null) continue
      bases = bases.map(base => (base === id ? null : base))
      const movement = (
        runner as { movement?: { isOut?: unknown; end?: unknown } }
      ).movement
      const end = typeof movement?.end === 'number' ? movement.end : 0
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
