import { GAME_POSITIONS } from '../gumbo/reference'
import { eventTypeName } from '../gumboEventTypes'
import {
  asCurrentPlay,
  asGumboPlay,
  type CurrentPlay,
  type GumboPlay
} from '../gumboPlay'
import type { ScoringAction } from './actions'
import { ordinal } from './lineup'
import {
  type GamePlay,
  type GameSetup,
  type GameState,
  type PlayerRef,
  type Side,
  withoutUndefined
} from './state'

/**
 * The stored play: a projection of the engine's state in Gumbo's own shape
 * and vocabulary. Nothing else writes one. The engine keeps numeric bases,
 * its reason labels and its own result types; this is where they become
 * `'1B'`, `r_adv_force` and `catcher_interf`. What Gumbo has no field for
 * stays in the `gameStation` record beside it.
 */

export interface PlayStamp {
  setupBefore: GameSetup
  actions: ScoringAction[]
  startTime?: string | null
  endTime?: string | null
}

// ---- Event types ----

/** The engine's result types MLB writes under another code. */
const LISTED_TYPES: Record<string, string> = {
  catcher_interference: 'catcher_interf',
  manual_placement: 'gs_manual_placement',
  placed_runner: 'runner_placed'
}
const BATTER_OUT_OTHER = 'Batter Out — Other'

/**
 * The event type a stored play carries for the engine's `type`. `other_out`
 * is MLB's runner out between pitches; the batter's own out of that kind, a
 * completed plate appearance, is `gs_batter_out`.
 */
export function storedEventType(type: string, outcome?: string): string {
  if (type === 'other_out' && outcome === BATTER_OUT_OTHER)
    return 'gs_batter_out'
  return LISTED_TYPES[type] ?? type
}

function playEventType(play: GamePlay): string {
  return storedEventType(play.result.eventType, play.source.gamestation.outcome)
}

// ---- Runners ----

type Runner = GamePlay['runners'][number]

const BASE_NAMES = [null, '1B', '2B', '3B', 'score'] as const
/** A base as Gumbo names it; the plate is none. */
function baseName(base: number): '1B' | '2B' | '3B' | 'score' | null {
  return BASE_NAMES[base] ?? null
}
/** Where a runner was put out: the batter retired at the plate is out at first. */
function outBaseName(base: number): string {
  return base <= 1 ? '1B' : base >= 4 ? '4B' : `${base}B`
}
/** The base a steal or a caught stealing was headed for: `2b`, `3b`, `home`. */
function target(base: number): string {
  return base >= 4 ? 'home' : `${base}b`
}

/**
 * The event type of the action that made a movement, read from the engine's
 * reason for it, or null when the reason names no action of its own.
 */
function actionType(runner: Runner): string | null {
  const { start: from, end: to } = runner.movement
  switch (runner.details.movementReason) {
    case 'Wild Pitch':
      return 'wild_pitch'
    case 'Passed Ball':
      return 'passed_ball'
    case 'Balk':
      return 'balk'
    case 'Steal':
      return `stolen_base_${target(to)}`
    case 'Caught Stealing':
      return `caught_stealing_${target(to)}`
    case 'Picked Off':
      return to > from
        ? `pickoff_caught_stealing_${target(to)}`
        : `pickoff_${from}b`
    case 'Safe from Pickoff':
      return `pickoff_${from}b`
    case 'Defensive Indifference':
      return 'defensive_indiff'
    case 'Throwing Error':
    case 'Fielding Error':
      return 'error'
    case 'Place a Runner (Tiebreaker)':
      return 'runner_placed'
    default:
      return null
  }
}

/**
 * Why a runner other than the batter moved, as MLB's runner detail types say
 * it. `onThrow` is a runner who took his base while the defence made a play
 * on another runner — not on the batter, whose out at first or on a catch is
 * the play every runner advances on.
 */
function movementReason(runner: Runner, onThrow: boolean): string {
  const { start: from, end: to, isOut } = runner.movement
  const reason = runner.details.movementReason
  if (isOut) {
    if (runner.movement.forceOut) return 'r_force_out'
    switch (reason) {
      case 'Caught Stealing':
        return `r_caught_stealing_${target(to)}`
      case 'Picked Off':
        return to > from
          ? `r_pickoff_caught_stealing_${target(to)}`
          : `r_pickoff_${from}b`
      case 'Ball Caught':
        return 'r_doubled_off'
      case 'Offensive Interference':
      case 'Batter Interference':
        return 'r_interference'
      case 'Out on Appeal':
        return 'r_out_appeal'
      case 'Back':
        return 'r_out_returning'
      default:
        return 'r_thrown_out'
    }
  }
  // A balk moves every runner up, but only the batter forces one.
  if (runner.movement.forced === true && reason !== 'Balk') return 'r_adv_force'
  if (reason === 'Steal') return `r_stolen_base_${target(to)}`
  if (onThrow) return 'r_adv_throw'
  return 'r_adv_play'
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

/**
 * The play's runners as Gumbo writes them, one entry per engine movement in
 * the order the engine made them.
 */
function runnersOf(
  state: GameState,
  setup: GameSetup,
  play: GamePlay
): Array<Record<string, unknown>> {
  const who = (ref: PlayerRef): Person => person(state, setup, ref)
  const type = playEventType(play)
  const origin = new Map<number, number>()
  return play.runners.map((runner, i) => {
    const { movement, details } = runner
    const id = details.runner.id
    if (!origin.has(id)) origin.set(id, movement.start)
    const batter = id === play.matchup.batter.id && movement.start === 0
    const scored = movement.runScored === true && !movement.isOut
    // A run a third-out force took back leaves the runner where he stood.
    const end = movement.isOut
      ? null
      : movement.end === 4 && !scored
        ? baseName(movement.start)
        : baseName(movement.end)
    const eventType =
      actionType(runner) ??
      (details.byAction === true
        ? movement.isOut
          ? 'other_out'
          : 'other_advance'
        : type)
    const onThrow =
      details.movementReason === 'Advance' &&
      details.byAction !== true &&
      play.runners
        .slice(0, i)
        .some(
          other =>
            other.details.runner.id !== id &&
            other.movement.start !== 0 &&
            other.details.playIndex === details.playIndex &&
            (other.movement.isOut ||
              other.details.movementReason === 'Safe at home')
        )
    const charged =
      scored || (batter && (type === 'walk' || type === 'intent_walk'))
    const pitcher = details.responsiblePitcher
    return {
      movement: {
        originBase: baseName(origin.get(id)!),
        start: baseName(movement.start),
        end,
        outBase: movement.isOut ? outBaseName(movement.end) : null,
        isOut: movement.isOut,
        outNumber: movement.isOut ? (movement.outNumber ?? null) : null
      },
      details: {
        event: eventTypeName(eventType),
        eventType,
        movementReason: batter ? null : movementReason(runner, onThrow),
        runner: who(details.runner),
        responsiblePitcher:
          charged && pitcher != null
            ? { id: playerOf(state, setup, pitcher.id)?.userId ?? null }
            : null,
        isScoringEvent: scored,
        rbi: details.rbi === true,
        earned: details.earned === true,
        teamUnearned: details.teamUnearned === true,
        playIndex: details.playIndex ?? null
      },
      credits: runner.credits.map(credit => {
        const position = GAME_POSITIONS.get(credit.position)
        return {
          player: who(credit.player),
          ...(position == null ? {} : { position: { ...position } }),
          credit: credit.credit
        }
      })
    }
  })
}

// ---- Highlight credits ----

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
  'catcher_interf',
  'gs_manual_placement',
  'sac_fly',
  'sac_fly_double_play',
  'sac_bunt'
])
const PITCHER_CREDITED = new Set(['strikeout', 'strikeout_double_play'])
const FIELDER_CREDITED = new Set([
  'field_out',
  'other_out',
  'gs_batter_out',
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
 * runner who scored or stole. All of it is read from the engine's play — its
 * numeric bases, `runScored` and its own steal — never from what is stored.
 * A play nobody did anything worth watching on carries an empty list.
 */
function highlightCredits(
  state: GameState,
  setup: GameSetup,
  play: GamePlay
): HighlightCredit[] {
  const type = playEventType(play)
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

// ---- Documents ----

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
    runners: runnersOf(state, setup, play),
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
export function documentOf(
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
        eventType: playEventType(play),
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
export function currentDocumentOf(
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
export function finalDocumentOf(state: GameState, stamp: PlayStamp): GumboPlay {
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
