import { type CurrentPlay, type GumboPlay, isRealPlay } from '../gumboPlay'
import { pitchCode } from '../pitchStrike'
import type { Destination, ResultType, ScoringAction } from './actions'
import { applyAction } from './apply'
import { recordOf, type TeamStationRecord } from './gumbo'
import { baseIds, freshGame, newSetup, type RosterPlayer } from './lineup'
import { PITCH_TYPES, type PitchType } from './pitchType'
import { nextDecision } from './rules'
import {
  copyGame,
  type FielderRef,
  type GameSetup,
  type GameState,
  type GameTeam,
  isPosition,
  type Position,
  setupOf,
  type Side
} from './state'

/**
 * A TeamStation record for a play that came without one: from an outside
 * scorer, or typed in by hand. The play's own document says
 * what happened — its timed pitches, its lineup changes, its runners — and
 * this module says it again as the actions a scorer would have taken, applied
 * through the same engine, so the game replays, edits and counts exactly as
 * one scored in TeamStation.
 *
 * Every action is applied as it is chosen. One the engine refuses is dropped,
 * and the play is finished another way, never stopped; whatever the engine
 * still disagrees with the stored play about — the outs, the score, the bases,
 * the batter, the pitcher — is put right with the override a scorer uses for
 * that. A record made here therefore always replays without a problem, and
 * its replay ends every play where the stored play ended.
 */

/** What a converted play needed beyond its own events, for the report. */
export interface ImportedCorrection {
  atBatIndex: number
  /** Short words for what was put right: `outs`, `bases`, `refused …`. */
  notes: string[]
}

export interface ImportedRecords {
  /** A record for each play that had none, by its `atBatIndex`. */
  records: Map<number, TeamStationRecord>
  corrections: ImportedCorrection[]
  /**
   * Why the game has no records: a play names its batter or pitcher as
   * nobody, and the engine needs a player in every turn; or no play is a
   * turn at bat at all, so there is nothing to replay.
   */
  unconvertible?: 'unnamedPlayers' | 'noPlayByPlay'
}

/** Whether a play is a turn at bat, not a lineup change or a placeholder. */
export function isTurnAtBat(play: GumboPlay): boolean {
  return isRealPlay(play) && !PLACEHOLDERS.has(play.result.eventType)
}

/** What a runner does with no batter at the plate. */
const RUNNER_EVENT =
  /^(other_out|caught_stealing|pickoff|stolen_base|wild_pitch|passed_ball|balk|runner_placed|defensive_indiff|other_advance|runner_double_play)/

/** Plays that stand for no turn at bat: a score put right, the final score. */
const PLACEHOLDERS = new Set([
  'score_correction',
  'final_score',
  'game_advisory'
])

/**
 * Whether a play names nobody where the engine needs somebody: a batter with
 * no id who did something, or had pitches thrown to him. A runner's play
 * needs no batter, and a pitcher with no id is the one on the mound.
 */
export function namesNobody(play: GumboPlay): boolean {
  if (!isTurnAtBat(play) || idOf(play.matchup?.batter) != null) return false
  // A runner put out, or moved, with no batter up names nobody it needs;
  // anything else a batter did, or pitches thrown to him, needs the batter.
  return (
    !RUNNER_EVENT.test(play.result.eventType) ||
    eventsOf(play).some(event => event.isPitch === true)
  )
}

export interface ImportedContext {
  gamePk: string
  teams: Record<Side, GameTeam>
  /** The setup a game whose first play has no record starts from. */
  setup: GameSetup
  fenceDistanceFt?: number
  /** The game is over: its last converted play ends it, as a scorer does. */
  final?: boolean
}

type Json = Record<string, unknown>

function object(raw: unknown): raw is Json {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
}

type StoredRunner = NonNullable<GumboPlay['runners']>[number]

/**
 * A play's runners in the order they moved. A feed lists a runner's move on
 * the ball in play before his steal earlier in the at-bat; each entry's
 * `playIndex` is the event it belongs to, so that is the order kept here.
 */
function runnersOf(play: GumboPlay): StoredRunner[] {
  const index = (runner: StoredRunner): number => {
    const at = (runner.details as { playIndex?: unknown } | undefined)
      ?.playIndex
    return typeof at === 'number' ? at : Number.MAX_SAFE_INTEGER
  }
  return (play.runners ?? [])
    .map((runner, order) => ({ runner, order }))
    .sort((a, b) => {
      const by = index(a.runner) - index(b.runner)
      return by !== 0 ? by : a.order - b.order
    })
    .map(item => item.runner)
}

/** The pitcher a pitch event names as throwing it, when it names one. */
function pitcherOf(event: Json): number | null {
  return event.isPitch === true ? idOf(event.pitcher) : null
}

/** A play's events, each an object. */
function eventsOf(play: GumboPlay): Json[] {
  const events: unknown = play.playEvents
  return Array.isArray(events) ? events.filter(object) : []
}

function idOf(raw: unknown): number | null {
  const id = object(raw) ? raw.id : undefined
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
    ? id
    : null
}

function endTimeOf(raw: unknown): string | undefined {
  if (!object(raw)) return undefined
  const time = raw.endTime
  return typeof time === 'string' && !Number.isNaN(Date.parse(time))
    ? time
    : undefined
}

function timeOf(raw: unknown): string | undefined {
  if (!object(raw)) return undefined
  const time = raw.startTime
  return typeof time === 'string' && !Number.isNaN(Date.parse(time))
    ? time
    : undefined
}

const BASE_NAMES = ['1B', '2B', '3B'] as const

/** A base as a document names it — `'1B'`, `2`, `'score'` — as 0 to 4. */
function baseNumber(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number') return raw >= 1 && raw <= 4 ? raw : null
  if (raw === '1B') return 1
  if (raw === '2B') return 2
  if (raw === '3B') return 3
  if (raw === 'score' || raw === 'home' || raw === 'HM' || raw === '4B')
    return 4
  return null
}

function destination(base: number): Destination {
  return base >= 4 ? 'home' : BASE_NAMES[base - 1]
}

// ---------------------------------------------------------------------------
// The setup a game starts from

/**
 * The lineups a game whose plays carry no record starts from. Every player on
 * either roster, and everyone its plays name, plays for his side; each side
 * bats in the order its batters first came up, before anyone was
 * substituted, until its first batter comes up again; and each side's first
 * pitcher is on the mound.
 * The fielders the first half's credits name stand at their positions, and
 * a starter they leave out stands at the first one a later credit gives him.
 */
export function importedSetup(
  plays: readonly GumboPlay[],
  rosters: Record<Side, readonly RosterPlayer[]>,
  teams: Record<Side, GameTeam>
): GameSetup {
  const sorted = [...plays].sort(
    (a, b) => a.about.atBatIndex - b.about.atBatIndex
  )
  const named: Record<Side, number[]> = { away: [], home: [] }
  const order: Record<Side, number[]> = { away: [], home: [] }
  const orderTurned: Record<Side, boolean> = { away: false, home: false }
  const pitcher: Record<Side, number | null> = { away: null, home: null }
  const fielders: Record<Side, Partial<Record<Position, number>>> = {
    away: {},
    home: {}
  }
  const replaced: Record<Side, Map<number, number>> = {
    away: new Map(),
    home: new Map()
  }
  // Each side's first half in the field, as `inning-half`.
  const firstHalf: Record<Side, string | null> = { away: null, home: null }
  // Every position a credit gives a fielder, in the order the game gives it.
  const credited: Record<Side, Array<[Position, number]>> = {
    away: [],
    home: []
  }
  // How strongly the plays put each player on each side: batting and
  // pitching say it outright, a credit or a substitution less so.
  const weight = new Map<number, Record<Side, number>>()
  const name = (side: Side, raw: unknown, strength = 1): void => {
    const id = idOf(raw)
    if (id == null) return
    if (!named[side].includes(id)) named[side].push(id)
    const held = weight.get(id) ?? { away: 0, home: 0 }
    held[side] += strength
    weight.set(id, held)
  }
  for (const play of sorted) {
    const batting: Side = play.about.halfInning === 'bottom' ? 'home' : 'away'
    const fielding: Side = batting === 'away' ? 'home' : 'away'
    const half = `${String(play.about.inning)}-${batting}`
    firstHalf[fielding] ??= half
    // A lineup change stored as a play of its own puts nobody in the game.
    if (isTurnAtBat(play)) {
      name(batting, play.matchup?.batter, 10)
      name(fielding, play.matchup?.pitcher, 10)
    }
    for (const base of startingOffense(play) ?? [])
      if (base != null) name(batting, { id: base }, 5)
    for (const event of eventsOf(play)) {
      const thrower = pitcherOf(event)
      if (thrower != null) name(fielding, { id: thrower }, 10)
      if (event.isSubstitution !== true) continue
      const incoming = idOf(event.player)
      const leaving = idOf(event.replacedPlayer)
      const side = sideOfSubstitution(event, batting)
      name(side, event.player)
      name(side, event.replacedPlayer)
      if (side === batting && incoming != null && leaving != null)
        replaced[batting].set(incoming, leaving)
    }
    // A substitute bats in the slot of the man he replaced: that man is the
    // one the order starts with.
    let batter = idOf(play.matchup?.batter)
    for (let hops = 0; batter != null && hops < 20; hops++) {
      const before = replaced[batting].get(batter)
      if (before == null) break
      batter = before
    }
    // The order runs until its first batter comes up again: nine, or the
    // ten to twelve of a continuous order.
    if (batter != null && batter === order[batting][0])
      orderTurned[batting] = true
    if (
      batter != null &&
      !orderTurned[batting] &&
      !order[batting].includes(batter)
    )
      order[batting].push(batter)
    pitcher[fielding] ??= idOf(play.matchup?.pitcher)
    for (const runner of runnersOf(play)) {
      name(batting, runner.details?.runner, 5)
      const credits: unknown = (runner as { credits?: unknown }).credits
      if (!Array.isArray(credits)) continue
      for (const credit of credits) {
        if (!object(credit)) continue
        name(fielding, credit.player)
        const position = positionOf(credit.position)
        const id = idOf(credit.player)
        if (position != null && position !== 'P' && id != null)
          credited[fielding].push([position, id])
        if (
          firstHalf[fielding] === half &&
          position != null &&
          position !== 'P' &&
          id != null &&
          fielders[fielding][position] == null &&
          !Object.values(fielders[fielding]).includes(id)
        )
          fielders[fielding][position] = id
      }
    }
  }
  // A starter the first half's credits leave without a position takes the
  // first one a later credit gives him, while nobody holds it: a catcher
  // first credited on a strikeout in the third stands behind the plate from
  // the first. Nobody outside the starting order is put on the field.
  for (const side of ['away', 'home'] as const) {
    const placed = fielders[side]
    for (const [position, id] of credited[side])
      if (
        placed[position] == null &&
        order[side].includes(id) &&
        !Object.values(placed).includes(id)
      )
        placed[position] = id
  }
  // A player the plays or both rosters put on both sides plays for the one
  // they put him on more strongly; a tie goes to the side whose roster has
  // him, then to the home side.
  const sideOf = (id: number): Side => {
    const held = weight.get(id) ?? { away: 0, home: 0 }
    if (held.away !== held.home) return held.away > held.home ? 'away' : 'home'
    const onAway = rosters.away.some(row => row.gumboId === id)
    const onHome = rosters.home.some(row => row.gumboId === id)
    return onAway && !onHome ? 'away' : 'home'
  }
  const roster = (side: Side): RosterPlayer[] => {
    const known = new Set<number | null>()
    // A roster can list a player twice (a guest who is also rostered).
    const rows = rosters[side].filter(row => {
      if (row.gumboId == null || known.has(row.gumboId)) return false
      if (sideOf(row.gumboId) !== side) return false
      known.add(row.gumboId)
      return true
    })
    for (const id of [...named.away, ...named.home])
      if (!known.has(id) && sideOf(id) === side) {
        const other = rosters[side === 'away' ? 'home' : 'away'].some(
          row => row.gumboId === id
        )
        if (other && (weight.get(id)?.[side] ?? 0) === 0) continue
        rows.push({ gumboId: id, shortName: '' })
        known.add(id)
      }
    return rows
  }
  const setup = newSetup(teams, { away: roster('away'), home: roster('home') })
  for (const side of ['away', 'home'] as const) {
    const team = setup.sides[side]
    const batters = order[side].filter(id => team.players.includes(id))
    if (batters.length > 0) {
      team.battingOrder = batters
      team.battingIndex = 0
    }
    for (const position of Object.keys(team.defense) as Position[])
      team.defense[position] = null
    for (const [position, id] of Object.entries(fielders[side]))
      if (team.players.includes(id)) team.defense[position as Position] = id
    const first = pitcher[side]
    if (first != null && team.players.includes(first)) {
      for (const position of Object.keys(team.defense) as Position[])
        if (team.defense[position] === first) team.defense[position] = null
      team.defense.P = first
    }
  }
  return setup
}

const POSITION_NUMBERS: Record<string, Position> = {
  '1': 'P',
  '2': 'C',
  '3': '1B',
  '4': '2B',
  '5': '3B',
  '6': 'SS',
  '7': 'LF',
  '8': 'CF',
  '9': 'RF'
}

/** A position as a document names it: `'SS'`, `{ abbreviation }`, `'6'`. */
function positionOf(raw: unknown): Position | null {
  if (isPosition(raw)) return raw
  if (typeof raw === 'string' || typeof raw === 'number')
    return POSITION_NUMBERS[String(raw)] ?? null
  if (!object(raw)) return null
  if (isPosition(raw.abbreviation)) return raw.abbreviation
  const code = raw.code
  if (typeof code === 'string' || typeof code === 'number')
    return POSITION_NUMBERS[String(code)] ?? null
  return null
}

/** The side a substitution changes: the batting side's, unless defensive. */
function sideOfSubstitution(event: Json, batting: Side): Side {
  const code = eventCode(event)
  const defensive =
    code === 'pitching_substitution' ||
    code === 'defensive_substitution' ||
    code === 'defensive_switch'
  return defensive ? (batting === 'away' ? 'home' : 'away') : batting
}

function eventCode(event: Json): string | undefined {
  const details = object(event.details) ? event.details : {}
  const code = details.eventType ?? details.event ?? details.code
  return typeof code === 'string' ? code : undefined
}

// ---------------------------------------------------------------------------
// The situation a play starts and ends in

interface Situation {
  inning: number
  top: boolean
  outs: number
  awayScore: number
  homeScore: number
  bases: Array<number | null>
}

/** Where the stored play left the game: outs, score and who is on base. */
function endOf(play: GumboPlay, start: Situation): Situation {
  // A play that names no half or inning, as a score put right, is in the
  // one it began in.
  const top =
    play.about.halfInning == null
      ? start.top
      : play.about.halfInning !== 'bottom'
  const inning = play.about.inning ?? start.inning
  const sameHalf = top === start.top && inning === start.inning
  let bases = sameHalf ? [...start.bases] : [null, null, null]
  // A pinch runner takes the base of the man he runs for.
  for (const event of eventsOf(play)) {
    if (!object(event) || event.isSubstitution !== true) continue
    const incoming = idOf(event.player)
    const leaving = idOf(event.replacedPlayer)
    if (incoming != null && leaving != null)
      bases = bases.map(id => (id === leaving ? incoming : id))
  }
  const moved = new Set(
    runnersOf(play).flatMap(runner => {
      const id = idOf(runner.details?.runner)
      return id == null ? [] : [id]
    })
  )
  // A runner a placement pushes off his base, with no move of his own in the
  // play, was forced on: a walk's documents name only the batter.
  const place = (id: number, base: number): void => {
    const there = bases[base - 1]
    if (there != null && there !== id && !moved.has(there) && base < 3)
      place(there, base + 1)
    bases[base - 1] = id
  }
  for (const runner of runnersOf(play)) {
    const id = idOf(runner.details?.runner)
    if (id == null) continue
    const movement = (runner as { movement?: Json }).movement ?? {}
    const end = baseNumber(movement.end)
    bases = bases.map(base => (base === id ? null : base))
    if (movement.isOut !== true && end != null && end >= 1 && end <= 3)
      place(id, end)
  }
  const counted = play.count?.outs
  // A score put right at the end says no outs: the half stands as it was.
  const outs = typeof counted === 'number' ? counted : sameHalf ? start.outs : 0
  return {
    inning,
    top,
    outs,
    awayScore: play.result.awayScore ?? start.awayScore,
    homeScore: play.result.homeScore ?? start.homeScore,
    bases: outs >= 3 ? [null, null, null] : bases
  }
}

/** The stored play's starting situation, from where the one before it ended. */
function startOf(
  play: GumboPlay,
  before: Situation,
  firstPlay = false
): Situation {
  const top =
    play.about.halfInning == null
      ? before.top
      : play.about.halfInning !== 'bottom'
  const inning = play.about.inning ?? before.inning
  const sameHalf =
    top === before.top && inning === before.inning && before.outs < 3
  const start: Situation = sameHalf
    ? { ...before, bases: [...before.bases] }
    : {
        inning,
        top,
        outs: 0,
        awayScore: before.awayScore,
        homeScore: before.homeScore,
        bases: [null, null, null]
      }
  // The importer writes who is on base with every event. Where no play of
  // the half says who is on — its first, or a half that begins with runners
  // placed — the first event's runners are where it began.
  const offense = sameHalf && !firstPlay ? null : startingOffense(play)
  if (offense != null) start.bases = offense
  return start
}

/** The runners the play's first event names on base, if it names them. */
function startingOffense(play: GumboPlay): Array<number | null> | null {
  const first = eventsOf(play)[0]
  const offense = first == null ? null : first.offense
  if (!object(offense)) return null
  return [idOf(offense.first), idOf(offense.second), idOf(offense.third)]
}

function situationOf(state: GameState): Situation {
  const line = state.liveData.linescore
  return {
    inning: line.currentInning,
    top: line.isTopInning,
    outs: line.outs,
    awayScore: line.teams.away.runs,
    homeScore: line.teams.home.runs,
    bases: baseIds(state)
  }
}

// ---------------------------------------------------------------------------
// Pitches

/** Gumbo's pitch codes as the engine's six calls, or what else they are. */
const CALLS: Record<string, 'B' | 'C' | 'S' | 'F' | 'T' | 'L'> = {
  B: 'B',
  '*B': 'B',
  I: 'B',
  V: 'B',
  P: 'B',
  C: 'C',
  S: 'S',
  M: 'S',
  W: 'S',
  Q: 'S',
  F: 'F',
  R: 'F',
  T: 'T',
  O: 'T',
  L: 'L'
}
const IN_PLAY = new Set(['X', 'D', 'E'])

const PITCH_TYPE_OF_CODE = new Map<string, PitchType>(
  (Object.keys(PITCH_TYPES) as PitchType[]).map(name => [
    PITCH_TYPES[name].code,
    name
  ])
)

/** The speed and kind of a pitch, where its event says them. */
function pitchData(event: Json): { speed?: number; pitchType?: PitchType } {
  const out: { speed?: number; pitchType?: PitchType } = {}
  const data = object(event.pitchData) ? event.pitchData : {}
  if (typeof data.startSpeed === 'number' && data.startSpeed > 0)
    out.speed = data.startSpeed
  const details = object(event.details) ? event.details : {}
  const type = object(details.type) ? details.type.code : undefined
  const kind = typeof type === 'string' ? PITCH_TYPE_OF_CODE.get(type) : null
  if (kind != null) out.pitchType = kind
  return out
}

/** The ball in play a pitch put up, from the event's hit data. */
function ballInPlayOf(
  event: Json,
  play: GumboPlay,
  state: GameState
): ScoringAction {
  const hit = object(event.hitData) ? event.hitData : {}
  const trajectory = hit.trajectory
  const bunt = typeof trajectory === 'string' && trajectory.startsWith('bunt')
  const action: Json = {
    type: 'ballInPlay',
    contact: bunt ? 'bunt' : 'swing',
    ...pitchData(event)
  }
  const mapped = TRAJECTORY_OF[String(trajectory)]
  if (mapped != null) action.trajectory = mapped
  const fielder = firstFielder(play)
  if (fielder != null) action.fielder = fielderAt(state, fielder)
  return action as ScoringAction
}

const TRAJECTORY_OF: Record<string, string> = {
  ground_ball: 'ground_ball',
  bunt_grounder: 'ground_ball',
  chopper: 'chopper',
  line_drive: 'line_drive',
  bunt_line_drive: 'line_drive',
  fly_ball: 'fly_ball',
  popup: 'popup',
  bunt_popup: 'popup'
}

/** The fielder who first handled the ball, by position, from the credits. */
function firstFielder(play: GumboPlay): Position | null {
  for (const runner of runnersOf(play)) {
    const credits: unknown = (runner as { credits?: unknown }).credits
    if (!Array.isArray(credits)) continue
    for (const credit of credits) {
      if (!object(credit)) continue
      const position = positionOf(credit.position)
      if (position != null) return position
    }
  }
  return null
}

/**
 * A fielder as the engine names him: the player at the position, or the
 * position itself when nobody stands there.
 */
function fielderAt(state: GameState, position: Position): FielderRef {
  return (
    state.liveData.boxscore.teams[fieldingSide(state)].defense[position] ??
    position
  )
}

/**
 * Puts each fielder the play's credits name at his position when the engine
 * has nobody there, so the ball and the outs can name the fielder.
 */
function fieldCredited(game: Converting, play: GumboPlay): void {
  const side = fieldingSide(game.state)
  for (const runner of runnersOf(play)) {
    const credits: unknown = (runner as { credits?: unknown }).credits
    if (!Array.isArray(credits)) continue
    for (const credit of credits) {
      if (!object(credit)) continue
      const position = positionOf(credit.position)
      const id = idOf(credit.player)
      const team = game.state.liveData.boxscore.teams[side]
      if (
        position == null ||
        id == null ||
        team.defense[position] != null ||
        !team.players.includes(id) ||
        Object.values(team.defense).includes(id)
      )
        continue
      game.try({ type: 'lineup', kind: 'position', side, position, player: id })
    }
  }
}

/** The fielders who put a runner out, by position, as the engine has them. */
function fieldersOf(
  state: GameState,
  play: GumboPlay,
  id: number
): FielderRef[] {
  const out: FielderRef[] = []
  for (const runner of runnersOf(play)) {
    if (idOf(runner.details?.runner) !== id) continue
    const credits: unknown = (runner as { credits?: unknown }).credits
    if (!Array.isArray(credits)) continue
    for (const credit of credits) {
      const position = object(credit) ? positionOf(credit.position) : null
      const fielder = position == null ? null : fielderAt(state, position)
      if (fielder != null && !out.includes(fielder)) out.push(fielder)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The result

/** Gumbo's event types as the engine's results. */
const RESULTS: Record<string, ResultType> = {
  single: 'single',
  double: 'double',
  triple: 'triple',
  home_run: 'home_run',
  field_error: 'field_error',
  fielders_choice: 'fielders_choice',
  fielders_choice_out: 'fielders_choice',
  field_out: 'field_out',
  force_out: 'fielders_choice',
  grounded_into_double_play: 'field_out',
  double_play: 'field_out',
  triple_play: 'field_out',
  sac_fly: 'field_out',
  sac_fly_double_play: 'field_out',
  sac_bunt: 'field_out',
  sac_bunt_double_play: 'field_out',
  strikeout: 'strikeout',
  strikeout_double_play: 'strikeout',
  hit_by_pitch: 'hit_by_pitch',
  intent_walk: 'intent_walk',
  catcher_interf: 'catcher_interference'
}

/** Whether the stored play leaves its batter safe on a base. */
function batterReached(play: GumboPlay): boolean {
  const batter = idOf(play.matchup?.batter)
  return runnersOf(play).some(runner => {
    if (idOf(runner.details?.runner) !== batter) return false
    const movement = (runner as { movement?: Json }).movement ?? {}
    return movement.isOut !== true && baseNumber(movement.end) != null
  })
}

const CAUGHT = new Set(['fly_ball', 'popup', 'line_drive', 'bunt_popup'])

function resultOf(play: GumboPlay, hit: Json | null): ScoringAction | null {
  const type = RESULTS[play.result.eventType]
  if (type == null) return null
  // An out that left the batter safe on base put a runner out instead.
  if (type === 'field_out' && batterReached(play))
    return { type: 'result', eventType: 'fielders_choice' }
  if (type !== 'field_out') return { type: 'result', eventType: type }
  const trajectory = hit == null ? undefined : hit.trajectory
  const caught =
    play.result.eventType === 'sac_fly' ||
    (typeof trajectory === 'string' && CAUGHT.has(trajectory))
  return {
    type: 'result',
    eventType: 'field_out',
    outBy: caught ? 'catch' : 'throw'
  }
}

// ---------------------------------------------------------------------------
// Converting one play

interface Taken {
  action: ScoringAction
  time: string | undefined
}

class Refusal extends Error {}

/** The game as a play is converted: the actions taken and their times. */
class Converting {
  state: GameState
  readonly taken: Taken[] = []
  readonly notes: string[] = []
  time: string | undefined

  constructor(state: GameState, time: string | undefined) {
    this.state = state
    this.time = time
  }

  /** Applies an action, or throws when the engine refuses it. */
  take(action: ScoringAction, time?: string): void {
    const applied = applyAction(copyGame(this.state), action, {
      inPlace: true,
      replay: true
    })
    if (applied.problems.length > 0)
      throw new Refusal(
        `refused ${action.type}${
          'kind' in action ? ` ${String(action.kind)}` : ''
        }: ${applied.problems[0].message}`
      )
    this.state = applied.state
    if (time != null) this.time = time
    this.taken.push({ action, time: time ?? this.time })
  }

  /** Applies an action if the engine takes it; true when it did. */
  try(action: ScoringAction, time?: string): boolean {
    try {
      this.take(action, time)
      return true
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      return false
    }
  }
}

function battingSide(state: GameState): Side {
  return state.liveData.linescore.isTopInning ? 'away' : 'home'
}

function fieldingSide(state: GameState): Side {
  return state.liveData.linescore.isTopInning ? 'home' : 'away'
}

/** The batter the engine has due, and the pitcher it has on the mound. */
function dueOf(state: GameState): {
  batter: number | null
  pitcher: number | null
} {
  const team = state.liveData.boxscore.teams[battingSide(state)]
  const fielding = state.liveData.boxscore.teams[fieldingSide(state)]
  return {
    batter:
      state.liveData.plays.currentPlay?.matchup.batter.id ??
      team.battingOrder[team.battingIndex] ??
      null,
    pitcher: fielding.defense.P ?? null
  }
}

/**
 * Brings the lineups in line with the play's batter and pitcher: a batter the
 * order does not hold takes the slot that is due, and a pitcher who is not on
 * the mound replaces the one who is.
 */
function lineupFor(
  game: Converting,
  batter: number | null,
  pitcher: number | null
): void {
  const state = game.state
  const batting = battingSide(state)
  const fielding = fieldingSide(state)
  const team = state.liveData.boxscore.teams[batting]
  if (batter != null && !team.battingOrder.includes(batter)) {
    if (!team.players.includes(batter)) {
      game.notes.push('batter not on the roster')
    } else {
      const leaving = team.battingOrder[team.battingIndex]
      if (
        leaving == null ||
        !game.try({
          type: 'lineup',
          kind: 'substitute',
          side: batting,
          player: batter,
          replaces: leaving,
          nextBatter: batter
        })
      ) {
        const order = [...team.battingOrder]
        if (order.length < 9) order.splice(team.battingIndex, 0, batter)
        else order[team.battingIndex] = batter
        if (
          game.try({
            type: 'lineup',
            kind: 'battingOrder',
            side: batting,
            order,
            nextBatter: batter
          })
        )
          game.notes.push('batting order')
      }
    }
  }
  const defense = game.state.liveData.boxscore.teams[fielding]
  if (pitcher != null && defense.defense.P !== pitcher) {
    if (!defense.players.includes(pitcher)) {
      game.notes.push('pitcher not on the roster')
      return
    }
    const leaving = defense.defense.P
    if (
      leaving == null ||
      leaving === pitcher ||
      defense.battingOrder.includes(pitcher) ||
      !game.try({
        type: 'lineup',
        kind: 'substitute',
        side: fielding,
        player: pitcher,
        replaces: leaving
      })
    )
      game.try({
        type: 'lineup',
        kind: 'position',
        side: fielding,
        position: 'P',
        player: pitcher
      })
  }
}

function sameSituation(a: Situation, b: Situation): boolean {
  return (
    a.inning === b.inning &&
    a.top === b.top &&
    a.outs === b.outs &&
    a.awayScore === b.awayScore &&
    a.homeScore === b.homeScore &&
    a.bases.every((id, i) => id === b.bases[i])
  )
}

/**
 * Puts the game where the stored play starts, with the scorer's override:
 * the half, the outs, the score, the bases, the batter and the pitcher.
 * Nothing is emitted when the engine already stands there.
 */
function situate(
  game: Converting,
  want: Situation,
  batter: number | null,
  pitcher: number | null
): void {
  const have = situationOf(game.state)
  const due = dueOf(game.state)
  const halfChanged = have.top !== want.top || have.inning !== want.inning
  if (!halfChanged) lineupFor(game, batter, pitcher)
  const now = dueOf(game.state)
  if (
    !halfChanged &&
    sameSituation(situationOf(game.state), want) &&
    (batter == null || now.batter === batter) &&
    (pitcher == null || now.pitcher === pitcher)
  )
    return
  const side: Side = want.top ? 'away' : 'home'
  const opponent: Side = want.top ? 'home' : 'away'
  const team = game.state.liveData.boxscore.teams[side]
  const defense = game.state.liveData.boxscore.teams[opponent]
  const wantBatter =
    batter != null && team.battingOrder.includes(batter)
      ? batter
      : halfChanged
        ? team.battingOrder[team.battingIndex]
        : due.batter
  const wantPitcher =
    pitcher != null && defense.players.includes(pitcher)
      ? pitcher
      : (defense.defense.P ?? undefined)
  const batting = new Set(team.players)
  const bases = want.bases.map(id =>
    id != null && batting.has(id) && id !== wantBatter ? id : null
  )
  const override: ScoringAction = {
    type: 'gameFlow',
    kind: 'override',
    inning: want.inning,
    top: want.top,
    awayScore: want.awayScore,
    homeScore: want.homeScore,
    balls: 0,
    strikes: 0,
    outs: Math.min(want.outs, 2),
    ...(wantBatter == null ? {} : { batter: wantBatter }),
    ...(wantPitcher == null ? {} : { pitcher: wantPitcher }),
    bases
  }
  if (game.try(override)) {
    if (halfChanged) lineupFor(game, batter, pitcher)
    game.notes.push(...differences(have, want))
    return
  }
  // A side no play names a pitcher for cannot be put in the field by an
  // override. When the play begins the next half, as after a third out the
  // scorer never recorded, the half is ended instead, and what still differs
  // is put right within the new one.
  const next =
    want.top === !have.top &&
    want.inning === (have.top ? have.inning : have.inning + 1)
  if (
    halfChanged &&
    next &&
    game.state.pending == null &&
    game.try({ type: 'gameFlow', kind: 'endHalf' })
  ) {
    game.notes.push('half ended')
    lineupFor(game, batter, pitcher)
    if (!sameSituation(situationOf(game.state), want)) {
      const now = dueOf(game.state)
      if (
        !game.try({
          ...override,
          ...(now.batter == null ? {} : { batter: now.batter }),
          bases: want.bases.map(id =>
            id != null && batting.has(id) && id !== now.batter ? id : null
          )
        })
      )
        game.notes.push('override refused')
    }
    return
  }
  game.notes.push('override refused')
}

function differences(have: Situation, want: Situation): string[] {
  const out: string[] = []
  if (have.inning !== want.inning || have.top !== want.top) out.push('half')
  if (have.outs !== want.outs) out.push('outs')
  if (have.awayScore !== want.awayScore || have.homeScore !== want.homeScore)
    out.push('score')
  if (!have.bases.every((id, i) => id === want.bases[i])) out.push('bases')
  return out.length === 0 ? ['lineup'] : out
}

/** A substitution event as the lineup action a scorer takes for it. */
function substitution(
  game: Converting,
  event: Json,
  time: string | undefined
): void {
  const state = game.state
  const incoming = idOf(event.player)
  const leaving = idOf(event.replacedPlayer)
  if (incoming == null) return
  const side = sideOfSubstitution(event, battingSide(state))
  const team = state.liveData.boxscore.teams[side]
  if (!team.players.includes(incoming)) {
    game.notes.push('substitute not on the roster')
    return
  }
  const position = positionOf(event.position)
  const code = eventCode(event)
  if (code === 'defensive_switch' || leaving == null) {
    if (position != null)
      game.try(
        { type: 'lineup', kind: 'position', side, position, player: incoming },
        time
      )
    return
  }
  const base = baseIds(state).indexOf(leaving)
  if (code === 'offensive_substitution' && base >= 0) {
    if (
      game.try(
        {
          type: 'lineup',
          kind: 'pinchRunner',
          side,
          player: incoming,
          base: BASE_NAMES[base]
        },
        time
      )
    )
      return
  }
  if (
    !game.try(
      {
        type: 'lineup',
        kind: 'substitute',
        side,
        player: incoming,
        replaces: leaving
      },
      time
    )
  )
    game.notes.push(`substitution refused`)
  else if (
    position != null &&
    team.defense[position] !== incoming &&
    side !== battingSide(game.state)
  )
    game.try(
      { type: 'lineup', kind: 'position', side, position, player: incoming },
      time
    )
}

/** A base-running event as the action a scorer takes for it. */
function baseRunning(
  game: Converting,
  event: Json,
  play: GumboPlay,
  time: string | undefined
): void {
  const code = eventCode(event) ?? ''
  const runners = runnersOf(play).filter(runner => {
    const index = (runner.details as { playIndex?: unknown } | undefined)
      ?.playIndex
    return index === event.index
  })
  const bases = baseIds(game.state)
  const battery = code.startsWith('wild_pitch')
    ? 'wild_pitch'
    : code.startsWith('passed_ball')
      ? 'passed_ball'
      : code === 'balk'
        ? 'balk'
        : null
  if (battery != null) {
    const advances = runners.flatMap(runner => {
      const id = idOf(runner.details?.runner)
      const end = baseNumber((runner as { movement?: Json }).movement?.end)
      return id == null || end == null || !bases.includes(id)
        ? []
        : [{ runner: id, to: destination(end) }]
    })
    game.try(
      {
        type: 'batteryEvent',
        kind: battery,
        ...(advances.length > 0 ? { advances } : {})
      },
      time
    )
    return
  }
  for (const runner of runners) {
    const id = idOf(runner.details?.runner)
    if (id == null || !bases.includes(id)) continue
    const movement = (runner as { movement?: Json }).movement ?? {}
    const end = baseNumber(movement.end) ?? baseNumber(movement.outBase)
    const out = movement.isOut === true
    const kind = code.startsWith('stolen_base')
      ? 'steal'
      : code.startsWith('caught_stealing')
        ? 'caught_stealing'
        : code.startsWith('pickoff_caught_stealing')
          ? 'caught_stealing'
          : code.startsWith('pickoff')
            ? out
              ? 'pickoff'
              : 'pickoff_safe'
            : code === 'defensive_indiff'
              ? 'defensive_indifference'
              : null
    if (kind != null && end != null)
      game.try(
        { type: 'baseRunning', kind, runner: id, to: destination(end) },
        time
      )
  }
}

/**
 * Answers what the engine asks after a ball in play — who put the batter
 * out, where the runners went, who erred, whether the runner home was safe —
 * from the stored play's runners.
 */
function settle(game: Converting, play: GumboPlay): void {
  const finals = new Map<
    number,
    {
      end: number | null
      out: boolean
      outBase: number | null
      reason: string | null
    }
  >()
  for (const runner of runnersOf(play)) {
    const id = idOf(runner.details?.runner)
    if (id == null) continue
    const movement = (runner as { movement?: Json }).movement ?? {}
    const reason = runner.details?.movementReason
    finals.set(id, {
      end: baseNumber(movement.end),
      out: movement.isOut === true,
      outBase: baseNumber(movement.outBase),
      reason: typeof reason === 'string' ? reason : null
    })
  }
  const batter = idOf(play.matchup?.batter)
  const tried = new Set<string>()
  for (let guard = 0; guard < 24; guard++) {
    const decision = nextDecision(game.state)
    const pending = game.state.pending
    if (pending == null || decision === 'final') return
    if (decision === 'errorAttribution') {
      const fielder = fielderAt(game.state, firstFielder(play) ?? 'SS')
      if (
        !game.try({ type: 'fieldingPlay', fielders: [fielder], error: fielder })
      )
        throw new Refusal('unsettled errorAttribution')
      continue
    }
    // The next runner whose place the engine has wrong, the batter first;
    // each answer is tried once.
    const ids = [
      ...(batter == null ? [] : [batter]),
      ...[...pending.movements]
        .filter(move => move.playerId !== batter)
        .sort((a, b) => b.from - a.from)
        .map(move => move.playerId)
    ]
    // Runners the engine left standing that the stored play moved, lead first.
    const standing = baseIds(game.state)
    for (let base = 3; base >= 1; base--) {
      const id = standing[base - 1]
      if (id != null && !ids.includes(id) && finals.has(id)) ids.push(id)
    }
    let answer: ScoringAction | null = null
    for (const id of ids) {
      const want = finals.get(id)
      if (want == null) continue
      const move = pending.movements.find(m => m.playerId === id)
      // A batter the engine already has out, or one not running, is done.
      if (id === batter && move == null && decision !== 'batterOut') continue
      const out = want.out
      const to = Math.min(
        Math.max(
          out ? (want.outBase ?? move?.to ?? 1) : (want.end ?? move?.to ?? 1),
          1
        ),
        4
      )
      if (move != null && out && move.decision === 'out') continue
      // The runner headed home, or one a choice leaves open, waits to be
      // told even where the engine has him already.
      const asked =
        (decision === 'homeDecision' && game.state.homeQueue[0] === id) ||
        (decision === 'resolveBatter' && move?.resolved !== true)
      if (
        move != null &&
        !out &&
        move.decision === 'safe' &&
        move.to === to &&
        !asked
      )
        continue
      const key = `${id}:${to}:${String(out)}`
      if (tried.has(key)) continue
      tried.add(key)
      const fielders = out ? fieldersOf(game.state, play, id) : []
      const back =
        !out && move != null && to < move.to && decision === 'homeDecision'
      answer = {
        type: 'runnerMovement',
        runner: id,
        to: destination(to),
        ...(back ? { reason: 'Back' as const } : {}),
        ...(out ? { out: true } : {}),
        ...(out && id === batter && pending.outcome === 'Out at First'
          ? { reason: 'Out at First' as const }
          : {}),
        ...(fielders.length > 0 ? { fielders } : {})
      }
      break
    }
    if (answer == null) {
      if (decision === 'close') return
      throw new Refusal(`unsettled ${decision}`)
    }
    game.try(answer)
  }
}

/** The play's own actions, from its events, then its result. */
function playActions(game: Converting, play: GumboPlay): void {
  const events = eventsOf(play)
  let hit: Json | null = null
  let inPlay = false
  for (const event of events) {
    const time = timeOf(event)
    if (event.isSubstitution === true) {
      substitution(game, event, time)
      continue
    }
    if (event.isPitch === true) {
      // A pitch thrown by another pitcher than the one on the mound: the
      // change the scorer made without a substitution of its own.
      const thrower = pitcherOf(event)
      if (
        thrower != null &&
        game.state.pending == null &&
        dueOf(game.state).pitcher !== thrower
      ) {
        lineupFor(game, null, thrower)
        game.notes.push('pitcher changed')
      }
      const details = object(event.details) ? event.details : {}
      const code = pitchCode(details) ?? ''
      if (IN_PLAY.has(code)) {
        fieldCredited(game, play)
        game.take(ballInPlayOf(event, play, game.state), time)
        hit = object(event.hitData) ? event.hitData : {}
        inPlay = true
        continue
      }
      if (code === 'H') {
        game.take({ type: 'result', eventType: 'hit_by_pitch' }, time)
        continue
      }
      const call = CALLS[code]
      if (call == null) {
        game.notes.push(`pitch ${code}`)
        continue
      }
      if (game.state.pending != null) {
        game.notes.push('pitch after the decision')
        continue
      }
      game.take({ type: 'pitch', call, ...pitchData(event) }, time)
      continue
    }
    if (event.isBaseRunningPlay === true || isBaseRunning(event)) {
      if (game.state.pending == null) baseRunning(game, event, play, time)
      continue
    }
    advisory(game, event, time)
  }
  const result = resultOf(play, hit)
  // A walk comes from the count, as when scored: the balls it was not given
  // are added until the count awards it. One recorded with no pitch at all is
  // put at three balls first, so only its deciding ball is counted thrown,
  // not four the scorer never recorded.
  if (play.result.eventType === 'walk' && !inPlay) {
    const due = dueOf(game.state)
    const line = game.state.liveData.linescore
    if (
      game.state.pending == null &&
      !game.taken.some(taken => taken.action.type === 'pitch') &&
      line.balls < 3 &&
      due.batter != null &&
      due.pitcher != null &&
      game.try({
        type: 'gameFlow',
        kind: 'override',
        inning: line.currentInning,
        top: line.isTopInning,
        awayScore: line.teams.away.runs,
        homeScore: line.teams.home.runs,
        balls: 3,
        strikes: line.strikes,
        outs: line.outs,
        batter: due.batter,
        pitcher: due.pitcher,
        bases: baseIds(game.state)
      })
    )
      game.notes.push('count put at three balls')
    let added = 0
    while (game.state.pending == null && added < 4) {
      game.take({ type: 'pitch', call: 'B' })
      added++
    }
    if (added > 0) game.notes.push(`balls added: ${added}`)
  }
  if (game.state.pending == null) {
    if (inPlay) {
      if (result == null) throw new Refusal(`result ${play.result.eventType}`)
      game.take(result)
    } else if (
      result != null &&
      !(result.type === 'result' && result.eventType === 'strikeout')
    ) {
      const awarded =
        result.type === 'result' &&
        (result.eventType === 'intent_walk' ||
          result.eventType === 'hit_by_pitch' ||
          result.eventType === 'catcher_interference')
      if (awarded) game.take(result)
      else if (game.state.pending == null) {
        // A ball in play nobody recorded the pitch of: the ball, then what it did.
        fieldCredited(game, play)
        game.take(ballInPlayOf({}, play, game.state))
        game.take(result)
      }
    } else if (
      play.result.eventType === 'strikeout' &&
      game.state.pending == null
    )
      throw new Refusal('strikeout without three strikes')
  }
  settle(game, play)
}

function isBaseRunning(event: Json): boolean {
  const code = eventCode(event) ?? ''
  return /^(stolen_base|caught_stealing|pickoff|wild_pitch|passed_ball|balk|defensive_indiff)/.test(
    code
  )
}

/**
 * An advisory: the scorer's override of the count, the outs or the inning, or
 * a half ended by hand. Every other advisory — the line-up typed in, a
 * decision recorded — is only words, which the document keeps.
 */
function advisory(
  game: Converting,
  event: Json,
  time: string | undefined
): void {
  const details = object(event.details) ? event.details : {}
  if (details.code === 'end_half') {
    if (game.state.pending == null)
      game.try({ type: 'gameFlow', kind: 'endHalf', keepAtBat: true }, time)
    return
  }
  if (details.code !== 'override' || game.state.pending != null) return
  const line = game.state.liveData.linescore
  const number = (raw: unknown, fallback: number): number =>
    typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : fallback
  const due = dueOf(game.state)
  game.try(
    {
      type: 'gameFlow',
      kind: 'override',
      inning: Math.max(number(details.inning, line.currentInning), 1),
      top:
        details.halfInning === 'top'
          ? true
          : details.halfInning === 'bottom'
            ? false
            : line.isTopInning,
      awayScore: line.teams.away.runs,
      homeScore: line.teams.home.runs,
      balls: Math.min(number(details.balls, line.balls), 3),
      strikes: Math.min(number(details.strikes, line.strikes), 2),
      outs: Math.min(number(details.outs, line.outs), 2),
      ...(due.batter == null ? {} : { batter: due.batter }),
      ...(due.pitcher == null ? {} : { pitcher: due.pitcher }),
      bases: baseIds(game.state)
    },
    time
  )
}

/** Closes the play, as the scorer's next action would. */
function close(game: Converting): void {
  if (nextDecision(game.state) === 'close')
    game.take({ type: 'gameFlow', kind: 'closePlay' })
}

/**
 * The play another way, when its own actions could not all be taken: its
 * pitches until the count decides it, the batter put on base when it does
 * not, and the play closed. What it leaves wrong, the correction after it
 * puts right.
 */
function fallback(game: Converting, play: GumboPlay): void {
  for (const event of eventsOf(play)) {
    if (event.isPitch !== true || game.state.pending != null) continue
    const details = object(event.details) ? event.details : {}
    const call = CALLS[pitchCode(details) ?? '']
    if (call == null) continue
    const before = game.state
    if (
      !game.try({ type: 'pitch', call, ...pitchData(event) }, timeOf(event))
    ) {
      game.state = before
      break
    }
  }
  if (game.state.pending == null) {
    if (baseIds(game.state).some(id => id != null)) clearBases(game)
    game.try({ type: 'result', eventType: 'manual_placement' })
  }
  close(game)
}

function clearBases(game: Converting): void {
  const due = dueOf(game.state)
  const line = game.state.liveData.linescore
  game.try({
    type: 'gameFlow',
    kind: 'override',
    inning: line.currentInning,
    top: line.isTopInning,
    awayScore: line.teams.away.runs,
    homeScore: line.teams.home.runs,
    balls: line.balls,
    strikes: line.strikes,
    outs: line.outs,
    ...(due.batter == null ? {} : { batter: due.batter }),
    ...(due.pitcher == null ? {} : { pitcher: due.pitcher }),
    bases: [null, null, null]
  })
}

// ---------------------------------------------------------------------------
// The game

/**
 * Records for every play of the game that has none. The game is walked as
 * `replayPlays` will walk it once the records are stored: a play that has a
 * record has its actions applied, and one that has none is converted from
 * where the game then stands, so plays posted after earlier ones continue
 * from them. A game TeamStation owns is never converted (`writeImportedRecords`):
 * its scorer's records stand on the lineups the scorer saw.
 */
export function importedRecords(
  stored: { plays: readonly GumboPlay[]; currentPlay?: CurrentPlay | null },
  context: ImportedContext
): ImportedRecords {
  const plays = [...stored.plays]
    .filter(
      play => play.about.atBatIndex !== stored.currentPlay?.about.atBatIndex
    )
    .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
  const teams = context.teams
  if (!plays.some(isTurnAtBat))
    return {
      records: new Map(),
      corrections: [],
      unconvertible: 'noPlayByPlay'
    }
  if (plays.some(play => recordOf(play, teams) == null && namesNobody(play)))
    return {
      records: new Map(),
      corrections: [],
      unconvertible: 'unnamedPlayers'
    }
  const first = plays.length === 0 ? null : recordOf(plays[0], teams)
  let state = freshGame(
    context.gamePk,
    teams,
    first?.setupBefore ?? context.setup,
    context.fenceDistanceFt
  )
  const records = new Map<number, TeamStationRecord>()
  const corrections: ImportedCorrection[] = []
  let ended: Situation = situationOf(state)
  let lastConverted: { index: number; record: TeamStationRecord } | null = null
  // Each side's pitcher as the plays last named him: a play that names none
  // was thrown by him, as the scorer left it.
  const lastPitcher: Record<Side, number | null> = { away: null, home: null }
  for (const [index, play] of plays.entries()) {
    const fielding: Side =
      play.about.halfInning == null
        ? fieldingSide(state)
        : play.about.halfInning === 'bottom'
          ? 'away'
          : 'home'
    const onMound = lastPitcher[fielding]
    lastPitcher[fielding] =
      [...eventsOf(play)]
        .reverse()
        .map(pitcherOf)
        .find(id => id != null) ??
      idOf(play.matchup?.pitcher) ??
      onMound
    const record = recordOf(play, teams)
    if (record != null) {
      lastConverted = null
      for (const action of record.actions) {
        const applied = applyAction(copyGame(state), action, {
          inPlace: true,
          replay: true
        })
        if (applied.problems.length > 0) break
        state = applied.state
      }
      ended = situationOf(state)
      continue
    }
    const converted = convertPlay(state, play, ended, index === 0, onMound)
    state = converted.state
    ended = converted.ended
    records.set(play.about.atBatIndex, converted.record)
    lastConverted = { index: play.about.atBatIndex, record: converted.record }
    if (converted.notes.length > 0)
      corrections.push({
        atBatIndex: play.about.atBatIndex,
        notes: converted.notes
      })
  }
  if (context.final === true && lastConverted != null && !state.final) {
    const applied = applyAction(
      copyGame(state),
      { type: 'gameFlow', kind: 'endGame' },
      { inPlace: true, replay: true }
    )
    if (applied.problems.length === 0) {
      lastConverted.record.actions.push({ type: 'gameFlow', kind: 'endGame' })
      const times = lastConverted.record.actionTimes
      if (times != null) times.push(times.at(-1)!)
    }
  }
  return { records, corrections }
}

function convertPlay(
  start: GameState,
  play: GumboPlay,
  before: Situation,
  firstPlay: boolean,
  onMound: number | null = null
): {
  state: GameState
  record: TeamStationRecord
  ended: Situation
  notes: string[]
} {
  const setupBefore = setupOf(start)
  const want = startOf(play, before, firstPlay)
  const ended = endOf(play, want)
  const batter = idOf(play.matchup?.batter)
  const pitcher = idOf(play.matchup?.pitcher) ?? onMound
  // An action with no event of its own is taken when the play was recorded:
  // its end, as an imported board steps, else its start.
  const time = endTimeOf(play.about) ?? timeOf(play.about)
  const attempt = (full: boolean): Converting => {
    const game = new Converting(start, time)
    if (!isTurnAtBat(play) || batter == null) {
      // A lineup change alone, or a score put right: no at-bat of its own,
      // and nobody it names is put in the order for it.
      for (const event of eventsOf(play))
        if (event.isSubstitution === true)
          substitution(game, event, timeOf(event))
      return game
    }
    situate(game, want, batter, pitcher)
    if (firstPlay) game.notes.length = 0
    if (full) {
      playActions(game, play)
      close(game)
    } else fallback(game, play)
    return game
  }
  let game: Converting
  try {
    game = attempt(true)
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    game = attempt(false)
    game.notes.push(error.message)
  }
  // What the engine still has wrong after the play, put right where the
  // play ends, so the next one starts where the stored game did.
  if (game.state.pending == null && !game.state.final) {
    const have = situationOf(game.state)
    // A play that ended its half leaves the engine in the next one: only its
    // score is put right there, a run the third out let in included, so the
    // game ends on the stored final score even when no play follows. One the
    // engine has not ended (a strikeout with no pitches) has its score put
    // right, and its half ended.
    // A play that names no half, as a score put right, sets the score alone.
    const halfLeftOpen =
      ended.outs >= 3 &&
      play.about.halfInning != null &&
      have.inning === ended.inning &&
      have.top === ended.top
    const next =
      ended.outs >= 3 || play.about.halfInning == null
        ? {
            ...have,
            awayScore: ended.awayScore,
            homeScore: ended.homeScore
          }
        : ended
    const override = (to: Situation): boolean => {
      const due = dueOf(game.state)
      return game.try({
        type: 'gameFlow',
        kind: 'override',
        inning: to.inning,
        top: to.top,
        awayScore: to.awayScore,
        homeScore: to.homeScore,
        balls: 0,
        strikes: 0,
        outs: to.outs,
        ...(due.batter == null ? {} : { batter: due.batter }),
        ...(due.pitcher == null ? {} : { pitcher: due.pitcher }),
        bases: to.bases.map(id => (id === due.batter ? null : id))
      })
    }
    // A play whose pitches end its half while its result does not (a strike
    // called after its ball in play, taken by the fallback) cannot be put
    // back in that half: its score is put right in the half the engine is in.
    const scoreOnly = {
      ...have,
      awayScore: ended.awayScore,
      homeScore: ended.homeScore
    }
    if (!sameSituation(have, next)) {
      if (override(next))
        game.notes.push(
          ...differences(have, next).map(note => `after: ${note}`)
        )
      else if (!sameSituation(have, scoreOnly) && override(scoreOnly))
        game.notes.push(
          ...differences(have, scoreOnly).map(note => `after: ${note}`)
        )
    }
    if (halfLeftOpen && game.try({ type: 'gameFlow', kind: 'endHalf' }))
      game.notes.push('after: half ended')
  }
  const times = game.taken.map(taken => taken.time)
  const record: TeamStationRecord = {
    version: 2,
    setupBefore,
    actions: game.taken.map(taken => taken.action),
    ...(times.every((t): t is string => t != null) && times.length > 0
      ? { actionTimes: times }
      : {})
  }
  return { state: game.state, record, ended, notes: game.notes }
}
