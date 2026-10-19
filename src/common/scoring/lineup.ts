import { DEFAULT_FENCE_DISTANCE_FT } from '../fenceDistance'
import { asGumboId } from '../userId'
import {
  asGamePlay,
  BASE_KEYS,
  copyState,
  fieldInfoOf,
  type GamePlay,
  type GamePlayer,
  type GameSetup,
  type GameSide,
  type GameState,
  type GameTeam,
  lineupsOf,
  type PlayerRef,
  type Position,
  POSITIONS,
  type Side,
  type SideLineup,
  withoutUndefined
} from './state'

/** Who bats, who fields, and who is where: the lineup and the players. */

export function battingSide(state: GameState): Side {
  return state.liveData.linescore.isTopInning ? 'away' : 'home'
}
export function fieldingSide(state: GameState): Side {
  return battingSide(state) === 'away' ? 'home' : 'away'
}
export function playerRef(state: GameState, id: number): PlayerRef {
  const player = state.gameData.players[id]
  if (player == null) throw new Error('Unknown player')
  return { id, fullName: player.fullName }
}
/** The same, for a place nobody may hold. */
export function refOf(state: GameState, id: number | null): PlayerRef | null {
  return id == null ? null : playerRef(state, id)
}
export function baseIds(state: GameState): Array<number | null> {
  const offense = state.liveData.linescore.offense
  return [
    offense.first?.id ?? null,
    offense.second?.id ?? null,
    offense.third?.id ?? null
  ]
}
export function updateDefense(state: GameState): void {
  const assignments = state.liveData.boxscore.teams[fieldingSide(state)].defense
  for (const position of POSITIONS)
    state.liveData.linescore.defense[position] = refOf(
      state,
      assignments[position]
    )
}
export function ordinal(number: number): string {
  return `${number}${number % 100 >= 11 && number % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][number % 10] ?? 'th')}`
}

/**
 * Brings the next batter to the plate and opens his play. When he is already
 * on base the lineup has to change first, and that is what is returned.
 */
export function startAppearance(state: GameState): GameState['awaitingBatter'] {
  const side = battingSide(state)
  const lineup = state.liveData.boxscore.teams[side]
  const id = lineup.battingOrder[lineup.battingIndex]
  updateDefense(state)
  if (id == null) {
    state.liveData.linescore.offense.batter = null
    state.liveData.plays.currentPlay = null
    return null
  }
  if (baseIds(state).includes(id)) {
    state.liveData.linescore.offense.batter = null
    state.liveData.plays.currentPlay = null
    return {
      teamId: state.gameData.teams[side].id,
      dueIndex: lineup.battingIndex,
      duePlayerId: id
    }
  }
  const batter = playerRef(state, id)
  const pitcher = state.liveData.linescore.defense.P
  state.liveData.linescore.offense.batter = batter
  if (pitcher == null) {
    state.liveData.plays.currentPlay = null
    return null
  }
  state.liveData.plays.currentPlay = asGamePlay({
    about: {
      atBatIndex: state.liveData.plays.allPlays.length,
      inning: state.liveData.linescore.currentInning,
      halfInning: side === 'away' ? 'top' : 'bottom',
      isComplete: false
    },
    result: {
      event: '',
      eventType: '',
      description: '',
      awayScore: state.liveData.linescore.teams.away.runs,
      homeScore: state.liveData.linescore.teams.home.runs,
      rbi: 0
    },
    count: {
      balls: state.liveData.linescore.balls,
      strikes: state.liveData.linescore.strikes,
      outs: state.liveData.linescore.outs
    },
    matchup: {
      batter,
      pitcher,
      batSide: { code: state.gameData.players[id].bats === 'left' ? 'L' : 'R' }
    },
    runners: [],
    playEvents: [],
    lineups: { opened: lineupsOf(state), began: lineupsOf(state) },
    source: {
      system: 'teamstation',
      teamstation: { version: 'estimated-v1', outcome: '' }
    }
  })
  return null
}

/** The batter may still change sides only before the first pitch. */
export function canSwitchBatter(state: GameState): boolean {
  const play = state.liveData.plays.currentPlay
  return play != null && !play.playEvents.some(event => event.isPitch)
}

const unique = (ids: number[]): boolean => new Set(ids).size === ids.length

/** A merged historical lineup may retain two turns or positions for one account. */
function noNewDuplicates(ids: number[], previous: number[] = []): boolean {
  const allowance = new Map<number, number>()
  for (const id of previous) allowance.set(id, (allowance.get(id) ?? 0) + 1)
  const counts = new Map<number, number>()
  for (const id of ids) {
    const count = (counts.get(id) ?? 0) + 1
    if (count > Math.max(1, allowance.get(id) ?? 0)) return false
    counts.set(id, count)
  }
  return true
}

/** Why a setup cannot be played, or undefined when it can. */
export function validateRoster(
  state: {
    gameData: GameState['gameData']
    liveData: { boxscore: GameState['liveData']['boxscore'] }
  },
  allowIncomplete = false,
  /** Existing merged turns may be retained, but no new duplicate is legal. */
  previous?: GameSetup['sides']
): string | undefined {
  for (const side of ['away', 'home'] as const) {
    const team = state.liveData.boxscore.teams[side]
    const name = state.gameData.teams[side].name
    const member = (id: number): boolean =>
      team.players.includes(id) &&
      state.gameData.players[id]?.teamId === state.gameData.teams[side].id
    if (!allowIncomplete && team.battingOrder.length === 0)
      return `${name} needs a lineup.`
    if (
      !unique(team.players) ||
      !noNewDuplicates(team.battingOrder, previous?.[side].battingOrder) ||
      !team.battingOrder.every(member)
    )
      return `${name} has an invalid or duplicate lineup player.`
    const defense = POSITIONS.map(position => team.defense[position]).filter(
      (id): id is number => id != null
    )
    if (!allowIncomplete && team.defense.P == null)
      return `${name} needs a pitcher.`
    const priorDefense =
      previous == null
        ? []
        : POSITIONS.map(position => previous[side].defense[position]).filter(
            (id): id is number => id != null
          )
    if (!noNewDuplicates(defense, priorDefense) || !defense.every(member))
      return `${name} has an invalid or duplicate defender.`
  }
}

/**
 * Takes the players and lineups of `setup`, keeping each side's pitch counts
 * and choosing who bats next. Before the game (`beforeTheGame`) nobody is
 * due yet, so each side's new order bats from its top. Once it has begun:
 * the batter due when he is still in the order,
 * else the man who took his place (a pinch hitter), `nextBatter` when the
 * batter due was on base, and otherwise the next one in the old order who is
 * still in the new one and not on base. Who took whose place is read by
 * `placesTaken`, and a change it cannot read is refused with its reason. A
 * man who takes the place of a runner of the side at bat takes his base, as
 * a pinch runner; the runner leaves the bases. `takers` is who took whose
 * place on each side, for the announcements.
 */
export function applyRoster(
  state: GameState,
  setup: GameSetup,
  nextBatter?: number,
  /** Who took whose place in the order: a substitute bats when his man was due. */
  replaced: Record<number, number> = {}
):
  | {
      state: GameState
      error?: undefined
      takers: Record<Side, ReadonlyMap<number, number>>
    }
  | { state?: undefined; error: string; takers?: undefined } {
  const draft = {
    gameData: { teams: state.gameData.teams, players: setup.players },
    liveData: { boxscore: { teams: setup.sides } }
  }
  const error = validateRoster(draft, true, state.liveData.boxscore.teams)
  if (error != null) return { error }
  const next = copyState(state)
  next.gameData.players = copyState(setup.players)
  next.meta.tagOrder = [...setup.tagOrder]
  const activeSide = battingSide(next)
  if (
    setup.sides[activeSide].battingOrder.length === 0 &&
    state.liveData.plays.currentPlay?.playEvents.some(
      event => event.isSubstitution !== true
    ) === true
  )
    return { error: 'Finish the at-bat before clearing the lineup.' }
  const opening = beforeTheGame(state)
  const activeOrder = state.liveData.boxscore.teams[activeSide].battingOrder
  const keepAwaiting =
    state.awaitingBatter != null &&
    nextBatter == null &&
    activeOrder.length === setup.sides[activeSide].battingOrder.length &&
    activeOrder.every(
      (id, index) => id === setup.sides[activeSide].battingOrder[index]
    )
  const bases = baseIds(next)
  const places: Partial<Record<Side, Places>> = {}
  for (const side of ['away', 'home'] as const) {
    const before = state.liveData.boxscore.teams[side]
    const read = placesTaken(
      before.battingOrder,
      setup.sides[side].battingOrder,
      {
        onBase: side === activeSide ? bases : [],
        due: before.battingOrder[before.battingIndex],
        replaced,
        name: id => setup.players[id]?.fullName ?? ''
      }
    )
    if ('error' in read) return { error: read.error }
    places[side] = read
  }
  const takers = {
    away: places.away!.takers,
    home: places.home!.takers
  }
  const occupied = bases.map(id =>
    id == null ? id : (takers[activeSide].get(id) ?? id)
  )
  for (const side of ['away', 'home'] as const) {
    const before = state.liveData.boxscore.teams[side]
    const after: GameSide = copyState(setup.sides[side])
    after.battingOrder = places[side]!.order
    after.pitchCounts = copyState(before.pitchCounts)
    if (after.battingOrder.length === 0) {
      after.battingIndex = 0
      next.liveData.boxscore.teams[side] = after
      continue
    }
    if (side === activeSide && keepAwaiting) {
      after.battingIndex = before.battingIndex
      next.liveData.boxscore.teams[side] = after
      continue
    }
    if (opening) {
      after.battingIndex = 0
      next.liveData.boxscore.teams[side] = after
      continue
    }
    const due = before.battingOrder[before.battingIndex]
    const oldId = after.battingOrder.includes(due)
      ? due
      : (takers[side].get(due) ?? due)
    let id: number | undefined = after.battingOrder.includes(oldId)
      ? oldId
      : undefined
    if (side === activeSide && state.awaitingBatter != null) id = nextBatter
    else if (id == null) {
      const cyclic = [
        ...before.battingOrder.slice(before.battingIndex + 1),
        ...before.battingOrder.slice(0, before.battingIndex + 1)
      ]
      id = [...cyclic, ...after.battingOrder].find(
        candidate =>
          after.battingOrder.includes(candidate) &&
          (side !== activeSide || !occupied.includes(candidate))
      )
    }
    if (
      id == null ||
      !after.battingOrder.includes(id) ||
      (side === activeSide && occupied.includes(id))
    )
      return {
        error: 'Choose a next batter in the lineup who is not already on base.'
      }
    // Merged accounts can occupy multiple historical turns. Keep the due
    // occurrence instead of jumping from its second turn back to its first.
    const occurrence = before.battingOrder
      .slice(0, before.battingIndex)
      .filter(player => player === id).length
    const matching = after.battingOrder
      .map((player, index) => (player === id ? index : -1))
      .filter(index => index >= 0)
    after.battingIndex = matching[occurrence] ?? matching[0]
    next.liveData.boxscore.teams[side] = after
  }
  const offense = next.liveData.linescore.offense
  BASE_KEYS.forEach((key, index) => {
    const id = occupied[index]
    if (id != null && id !== offense[key]?.id)
      offense[key] = playerRef(next, id)
  })
  updateDefense(next)
  if (keepAwaiting) return { state: next, takers }
  const team = next.liveData.boxscore.teams[activeSide]
  if (team.battingOrder.length === 0) {
    next.liveData.linescore.offense.batter = null
    next.liveData.plays.currentPlay = null
    next.awaitingBatter = null
    return { state: next, takers }
  }
  const batter = playerRef(next, team.battingOrder[team.battingIndex])
  const play = next.liveData.plays.currentPlay
  if (play == null) startAppearance(next)
  else {
    // Correct an edited hand before pitching; keep a pitched appearance's
    // recorded side, and preserve unchanged switch hitters' manual choices.
    if (
      play.matchup.batter.id !== batter.id ||
      (next.gameData.players[batter.id].bats !==
        state.gameData.players[batter.id]?.bats &&
        canSwitchBatter(next))
    )
      play.matchup.batSide.code =
        next.gameData.players[batter.id].bats === 'left' ? 'L' : 'R'
    play.matchup.batter = batter
    const pitcher = next.liveData.linescore.defense.P
    if (pitcher != null) play.matchup.pitcher = pitcher
    next.liveData.linescore.offense.batter = batter
  }
  next.awaitingBatter = null
  return { state: next, takers }
}

const BASE_NAMES = ['1B', '2B', '3B'] as const

/** A side's new order, read against its old one by `placesTaken`. */
export interface Places {
  /** Each man who left the order, by the man who took his place. */
  takers: Map<number, number>
  /** The new order, with a pinch runner put in his runner's place. */
  order: number[]
}

/**
 * Who took whose place when a side's order changed from `before` to
 * `after`, read by the men kept in both rather than by the place numbers,
 * which shift when a man is taken out.
 * - Each man taken out left a gap between two kept men (or an end of the
 *   order), and the men new to the order standing in the same gap of the
 *   new one take the places left there: in order when as many came in as
 *   left; when fewer came in, the batter due's place first, then the others'
 *   and the runners' last, so that a runner is the one left for the man
 *   added at the end. Where kept men moved, a gap left unmatched is matched,
 *   as many for as many, by the kept man before it, or else the one after.
 * - `replaced` names places taken outright (a substitute).
 * - A runner of the side at bat left with nobody in his place is run for by
 *   the one man new to the order who took nobody's place, and `order` puts
 *   that man in the runner's place.
 * - The change cannot be read, and `error` says why, when more men came into
 *   a gap than left it; when a runner is left with nobody, with more than one
 *   such man, or alongside another such runner; or when men who took nobody's
 *   place came in while a different number left with nobody in theirs.
 * Otherwise, men only added or only taken out, and kept men moved, stand as
 * saved.
 */
export function placesTaken(
  before: readonly number[],
  after: readonly number[],
  {
    onBase = [],
    due,
    replaced = {},
    name = String
  }: {
    /** The side's runners, by base. */
    onBase?: ReadonlyArray<number | null>
    /** The batter due. */
    due?: number
    replaced?: Record<number, number>
    name?: (id: number) => string
  } = {}
): Places | { error: string } {
  const kept = new Set(before.filter(id => after.includes(id)))
  const removed = before.filter(id => !kept.has(id))
  const newcomers = after.filter(
    id => !before.includes(id) && !onBase.includes(id)
  )
  const takers = new Map<number, number>()
  for (const [leaving, incoming] of Object.entries(replaced))
    if (removed.includes(Number(leaving)) && newcomers.includes(incoming))
      takers.set(Number(leaving), incoming)
  const taken = (id: number): boolean => [...takers.values()].includes(id)
  const running = (id: number): boolean => onBase.includes(id)
  const unrun = (runner: number): { error: string } => ({
    error: `Choose who runs for ${name(runner)} on ${BASE_NAMES[onBase.indexOf(runner)]}.`
  })

  // The gaps, each named by the kept men on either side of it; where kept
  // men moved, by the one before it, or else the one after it.
  const around = (order: readonly number[], index: number): string[] => [
    `${order.slice(0, index).findLast(id => kept.has(id))}`,
    `${order.slice(index + 1).find(id => kept.has(id))}`
  ]
  const keys: Array<(ends: string[]) => string> = [
    ([before, after]) => `${before}:${after}`,
    ([before]) => before,
    ([, after]) => after
  ]
  for (const [pass, key] of keys.entries()) {
    const gaps = new Map<string, { left: number[]; came: number[] }>()
    const gap = (name: string): { left: number[]; came: number[] } => {
      const found = gaps.get(name) ?? { left: [], came: [] }
      gaps.set(name, found)
      return found
    }
    before.forEach((id, index) => {
      if (removed.includes(id) && !takers.has(id))
        gap(key(around(before, index))).left.push(id)
    })
    after.forEach((id, index) => {
      if (newcomers.includes(id) && !taken(id))
        gap(key(around(after, index))).came.push(id)
    })
    for (const { left, came } of gaps.values()) {
      if (came.length === 0 || left.length === 0) continue
      if (pass > 0 && came.length !== left.length) continue
      if (came.length > left.length) {
        const runner = onBase.find(id => id != null && left.includes(id))
        if (runner != null) return unrun(runner)
        const places = left.map(id => `${name(id)}'s`).join(' and ')
        return {
          error: `Put only one man in ${places} place${left.length > 1 ? 's' : ''}.`
        }
      }
      const open =
        came.length === left.length
          ? left
          : [
              ...left.filter(id => id === due && !running(id)),
              ...left.filter(id => id !== due && !running(id)),
              ...left.filter(running)
            ]
      came.forEach((id, index) => {
        if (index < open.length) takers.set(open[index], id)
      })
    }
  }

  const order = [...after]
  const runners = onBase.filter(
    (id): id is number => id != null && removed.includes(id) && !takers.has(id)
  )
  if (runners.length > 0) {
    const free = newcomers.filter(id => !taken(id))
    if (runners.length > 1 || free.length !== 1) return unrun(runners[0])
    const [runner] = runners
    const [man] = free
    takers.set(runner, man)
    order.splice(order.indexOf(man), 1)
    // Before the man who now stands where the one after the runner stood.
    const following = before
      .slice(before.indexOf(runner) + 1)
      .map(id => (kept.has(id) ? id : takers.get(id)))
      .find(id => id != null && order.includes(id))
    order.splice(
      following == null ? order.length : order.indexOf(following),
      0,
      man
    )
  }
  const added = newcomers.filter(id => !taken(id))
  const dropped = removed.filter(id => !takers.has(id))
  if (added.length > 0 && dropped.length > 0 && added.length !== dropped.length)
    return {
      error: `Put ${name(added[0])} in the place of the man he replaces.`
    }
  return { takers, order }
}

/** What each position is called in a sentence: the place, and who plays it. */
const POSITION_WORDS: Record<Position, { place: string; fielder: string }> = {
  P: { place: 'pitcher', fielder: 'pitcher' },
  C: { place: 'catcher', fielder: 'catcher' },
  '1B': { place: 'first base', fielder: 'first baseman' },
  '2B': { place: 'second base', fielder: 'second baseman' },
  SS: { place: 'shortstop', fielder: 'shortstop' },
  '3B': { place: 'third base', fielder: 'third baseman' },
  LF: { place: 'left field', fielder: 'left fielder' },
  CF: { place: 'center field', fielder: 'center fielder' },
  RF: { place: 'right field', fielder: 'right fielder' }
}

/** A pinch hitter's or runner's announcement, as the feed words it. */
export function pinchSaid(
  running: boolean,
  name: string,
  replaced: string | undefined
): string {
  const role = running ? 'Pinch-runner' : 'Pinch-hitter'
  return replaced == null
    ? `Offensive Substitution: ${role} ${name} comes in.`
    : `Offensive Substitution: ${role} ${name} replaces ${replaced}.`
}

/**
 * A pinch runner who leaves the batting order as it is, which the feed has no
 * words for.
 */
export function courtesyRunnerSaid(name: string, replaced: string): string {
  return `Pinch-runner ${name} runs for ${replaced}; the batting order is unchanged`
}

/**
 * A player coming in to field, as the feed words it: "replaces pinch-runner
 * X" when the man leaving came in to hit or run and never fielded.
 */
export function defensiveSubstitutionSaid(
  name: string,
  replaced: string | undefined,
  position: Position,
  pinch?: 'PH' | 'PR'
): string {
  const where = POSITION_WORDS[position].place
  const role =
    pinch == null ? '' : pinch === 'PH' ? 'pinch-hitter ' : 'pinch-runner '
  return replaced == null
    ? `Defensive Substitution: ${name} comes in, playing ${where}.`
    : `Defensive Substitution: ${name} replaces ${role}${replaced}, playing ${where}.`
}

/** A change of batting order: each man it moves and where he now bats. */
export function battingOrderSaid(
  moved: ReadonlyArray<{ name: string; bats: number }>
): string {
  return `Batting order change: ${moved
    .map(({ name, bats }) => `${name} bats ${ordinal(bats)}`)
    .join(', ')}.`
}

export type LineupEventType =
  | 'pitching_substitution'
  | 'offensive_substitution'
  | 'defensive_substitution'
  | 'defensive_switch'
  | 'ts_batting_order'

/** One lineup change, as the play records it and MLB would announce it. */
export interface LineupChange {
  eventType: LineupEventType
  player: PlayerRef
  /** `P` to `RF`, or `PH` and `PR` for a pinch hitter or runner. */
  position?: string
  /** Where a player who changed position played before. */
  fromPosition?: Position
  /** His place in the order as MLB writes it: the slot, then how many came in. */
  battingOrder?: string
  replacedPlayer?: PlayerRef
  /** A change of batting order: each man it moves and where he now bats. */
  moved?: Array<{ player: PlayerRef; bats: number }>
  /** The announcement, as the live feed words it. */
  description: string
}

/**
 * The game has begun once a play is complete or the first play has an event
 * that is not a lineup change. Before that the lineups are still the ones
 * the game starts with, and MLB announces no substitution.
 */
export function begun(state: GameState): boolean {
  return (
    state.liveData.plays.allPlays.length > 0 ||
    state.liveData.plays.currentPlay?.playEvents.some(
      event => event.isSubstitution !== true
    ) === true
  )
}

/**
 * Nothing has happened yet: the game has not begun, and it stands at the top
 * of the first with nobody on base and no batter awaited. A game picked up
 * part way through by a correction by hand has a situation, and is under way.
 */
function beforeTheGame(state: GameState): boolean {
  const line = state.liveData.linescore
  return (
    !begun(state) &&
    state.awaitingBatter == null &&
    line.currentInning === 1 &&
    line.isTopInning &&
    baseIds(state).every(id => id == null)
  )
}

/**
 * Who batted in a play: the batter it opened with, then each pinch hitter
 * sent in for the batter in turn, the last being the play's batter. A pinch
 * hitter sent in for anybody else is not among them.
 */
export function battersOf(play: GamePlay): number[] {
  const batters = [play.matchup.batter.id]
  for (const event of [...play.playEvents].reverse())
    if (
      event.details.code === 'offensive_substitution' &&
      event.position === 'PH' &&
      event.player.id === batters[0] &&
      event.replacedPlayer != null
    )
      batters.unshift(event.replacedPlayer.id)
  return batters
}

/**
 * Each player's place in a side's order as the plays have announced it, from
 * the lineup changes already written: `601` for the first player to come in
 * at sixth.
 */
function announcedOrder(state: GameState, side: Side): Map<number, number> {
  const team = state.gameData.teams[side].id
  const codes = new Map<number, number>()
  const plays = [
    ...state.liveData.plays.allPlays,
    state.liveData.plays.currentPlay
  ]
  for (const play of plays)
    for (const event of play?.playEvents ?? [])
      if (
        event.isSubstitution === true &&
        event.battingOrder != null &&
        state.gameData.players[event.player.id]?.teamId === team
      )
        codes.set(event.player.id, Number(event.battingOrder))
  return codes
}

/**
 * The lineup changes between two states of a game, as the events a play
 * records: a player who comes in to pitch, or moves to the mound, is a
 * pitching substitution; one the side at bat puts in its order, or the side
 * in the field puts in its order at no position, is an offensive
 * substitution, a pinch runner when the man he replaced is on base and a
 * pinch hitter otherwise, with `replacedPlayer` the man whose place he took;
 * one who comes in to field is a defensive substitution; one already in the
 * game who takes another position is a defensive switch; and an order that
 * changes otherwise is `ts_batting_order`. Before the game has begun nothing
 * is announced. A player added to the roster but not the game, or the batter
 * changing sides, changes no lineup. The play records each change where the
 * scorer made it; the stored play announces a man put in the order where he
 * first appears (`document.ts`). Whose place each man took is `takers`, as
 * `applyRoster` read it.
 */
export function lineupChanges(
  before: GameState,
  after: GameState,
  takers: Record<Side, ReadonlyMap<number, number>>
): LineupChange[] {
  if (!begun(before)) return []
  const changes = (['away', 'home'] as const).flatMap(side =>
    sideChanges(before, after, side, takers[side])
  )
  // A new pitcher is announced first, as the feed does.
  return [
    ...changes.filter(change => change.eventType === 'pitching_substitution'),
    ...changes.filter(change => change.eventType !== 'pitching_substitution')
  ]
}

function sideChanges(
  before: GameState,
  after: GameState,
  side: Side,
  takers: ReadonlyMap<number, number>
): LineupChange[] {
  const was = before.liveData.boxscore.teams[side]
  const now = after.liveData.boxscore.teams[side]
  // The side at bat sends the players it puts in its order in to hit or to
  // run; the positions they will field only matter once it takes the field.
  const batting = side === battingSide(before)
  const onBase = baseIds(before)
  const positionOf = (team: GameSide, id: number): Position | undefined =>
    POSITIONS.find(position => team.defense[position] === id)
  const inGame = (team: GameSide, id: number): boolean =>
    team.battingOrder.includes(id) || positionOf(team, id) != null
  const ref = (id: number | null | undefined): PlayerRef | undefined =>
    id == null ? undefined : playerRef(after, id)
  const name = (id: number | null | undefined): string =>
    ref(id)?.fullName ?? ''
  // The player whose place in the order this one took.
  const orderReplaced = (id: number): number | undefined =>
    [...takers].find(([, taker]) => taker === id)?.[0]
  const codes = announcedOrder(before, side)
  const orderCode = (id: number, entering: boolean): string | undefined => {
    const slot = now.battingOrder.indexOf(id) + 1
    if (slot === 0) return undefined
    const known = codes.get(id)
    if (known != null && Math.floor(known / 100) === slot) return String(known)
    if (!entering) return String(slot * 100)
    const came = [...codes.values()]
      .filter(code => Math.floor(code / 100) === slot)
      .reduce((most, code) => Math.max(most, code % 100), 0)
    const code = slot * 100 + came + 1
    codes.set(id, code)
    return String(code)
  }
  // Changes made earlier in this play: the player a switch took the place of
  // may have left that position in an earlier change.
  const earlier = before.liveData.plays.currentPlay?.playEvents ?? []
  const vacated = (position: Position): number | undefined =>
    earlier.findLast(event => event.details.fromPosition === position)?.player
      .id
  const movedFrom = (id: number): Position | undefined => {
    const position = earlier.findLast(
      event => event.replacedPlayer?.id === id
    )?.position
    return POSITIONS.find(known => known === position)
  }
  const pitching = (
    id: number,
    fromPosition: Position | undefined,
    battingOrder: string | undefined
  ): LineupChange => {
    const replaced = was.defense.P ?? undefined
    return withoutUndefined({
      eventType: 'pitching_substitution' as const,
      player: ref(id)!,
      position: 'P',
      fromPosition,
      battingOrder,
      replacedPlayer: ref(replaced),
      description:
        replaced == null
          ? `Pitching Change: ${name(id)} comes in to pitch.`
          : `Pitching Change: ${name(id)} replaces ${name(replaced)}.`
    })
  }

  const changes: LineupChange[] = []
  const ids = [
    ...POSITIONS.map(position => now.defense[position]),
    ...now.battingOrder
  ].filter((id, i, all): id is number => id != null && all.indexOf(id) === i)
  for (const id of ids) {
    const position = positionOf(now, id)
    if (!inGame(was, id)) {
      const replaced = orderReplaced(id)
      const battingOrder = orderCode(id, true)
      const hitting = batting && battingOrder != null
      if (position === 'P' && !hitting) {
        changes.push(pitching(id, undefined, battingOrder))
        continue
      }
      if (position != null && !hitting) {
        const holder = was.defense[position] ?? replaced
        changes.push(
          withoutUndefined({
            eventType: 'defensive_substitution' as const,
            player: ref(id)!,
            position,
            battingOrder,
            replacedPlayer: ref(holder),
            description: defensiveSubstitutionSaid(
              name(id),
              holder == null ? undefined : name(holder),
              position
            )
          })
        )
        continue
      }
      // He runs when he took the base of the man he replaced.
      const running =
        replaced != null &&
        onBase.includes(replaced) &&
        baseIds(after).includes(id)
      changes.push(
        withoutUndefined({
          eventType: 'offensive_substitution' as const,
          player: ref(id)!,
          position: running ? 'PR' : 'PH',
          battingOrder,
          replacedPlayer: ref(replaced),
          description: pinchSaid(
            running,
            name(id),
            replaced == null ? undefined : name(replaced)
          )
        })
      )
      continue
    }
    const from = positionOf(was, id)
    if (position == null || position === from) continue
    const fromPosition = from ?? movedFrom(id)
    if (position === 'P') {
      changes.push(pitching(id, fromPosition, orderCode(id, false)))
      continue
    }
    const holder = was.defense[position]
    const replaced =
      holder != null && holder !== id ? holder : vacated(position)
    const words = POSITION_WORDS[position]
    changes.push(
      withoutUndefined({
        eventType: 'defensive_switch' as const,
        player: ref(id)!,
        position,
        fromPosition,
        battingOrder: orderCode(id, false),
        replacedPlayer: ref(replaced),
        description:
          fromPosition == null
            ? `${name(id)} remains in the game as the ${words.fielder}.`
            : `Defensive switch from ${POSITION_WORDS[fromPosition].place} to ${words.place} for ${name(id)}.`
      })
    )
  }

  // The order changed other than by who came in and who left.
  const stayed = (order: number[], other: number[]): number[] =>
    order.filter(id => other.includes(id))
  const kept = stayed(was.battingOrder, now.battingOrder)
  const moved = stayed(now.battingOrder, was.battingOrder).filter(
    (id, index) => kept[index] !== id
  )
  if (moved.length > 0) {
    const bats = moved.map(id => ({
      player: ref(id)!,
      bats: now.battingOrder.indexOf(id) + 1
    }))
    changes.push({
      eventType: 'ts_batting_order',
      player: bats[0].player,
      moved: bats,
      description: battingOrderSaid(
        bats.map(({ player, bats }) => ({ name: player.fullName, bats }))
      )
    })
  }
  return changes
}

/**
 * What a side announces as it takes the field: how its fielders differ from
 * when it last left the field, as MLB writes it before the first pitch. The
 * man now on the mound, when he was not, is a pitching substitution; a
 * player who has not appeared since he came in is a defensive substitution,
 * replacing the man `leaving` names for him and the position's holder then;
 * and one who has — who played then, or batted or ran since — at a new
 * position is a defensive switch, replacing the man who held it or else the
 * man he was announced for (`appeared`). A change undone in between is no
 * change. `codes` holds the places in the order already announced.
 */
export function fieldingChanges(
  state: GameState,
  was: SideLineup,
  now: SideLineup,
  appeared: ReadonlyMap<number, number | undefined>,
  codes: ReadonlyMap<number, number>,
  leaving: (
    id: number,
    holder: number | undefined
  ) => { replaced: number | undefined; pinch?: 'PH' | 'PR' }
): LineupChange[] {
  const ref = (id: number | null | undefined): PlayerRef | undefined =>
    id == null ? undefined : playerRef(state, id)
  const name = (id: number | null | undefined): string =>
    ref(id)?.fullName ?? ''
  const orderCode = (id: number): string | undefined => {
    const slot = now.battingOrder.indexOf(id) + 1
    if (slot === 0) return undefined
    const known = codes.get(id)
    return known != null && Math.floor(known / 100) === slot
      ? String(known)
      : String(slot * 100)
  }
  const changes: LineupChange[] = []
  for (const position of POSITIONS) {
    const id = now.defense[position]
    const holder = was.defense[position] ?? undefined
    if (id == null || id === holder) continue
    const from = POSITIONS.find(known => was.defense[known] === id)
    const where = POSITION_WORDS[position]
    if (position === 'P') {
      changes.push(
        withoutUndefined({
          eventType: 'pitching_substitution' as const,
          player: ref(id)!,
          position,
          fromPosition: from,
          battingOrder: orderCode(id),
          replacedPlayer: ref(holder),
          description:
            holder == null
              ? `Pitching Change: ${name(id)} comes in to pitch.`
              : `Pitching Change: ${name(id)} replaces ${name(holder)}.`
        })
      )
      continue
    }
    if (from == null && !appeared.has(id)) {
      const { replaced, pinch } = leaving(id, holder)
      changes.push(
        withoutUndefined({
          eventType: 'defensive_substitution' as const,
          player: ref(id)!,
          position,
          battingOrder: orderCode(id),
          replacedPlayer: ref(replaced),
          description: defensiveSubstitutionSaid(
            name(id),
            replaced == null ? undefined : name(replaced),
            position,
            pinch
          )
        })
      )
      continue
    }
    changes.push(
      withoutUndefined({
        eventType: 'defensive_switch' as const,
        player: ref(id)!,
        position,
        fromPosition: from,
        battingOrder: orderCode(id),
        replacedPlayer: ref(holder ?? appeared.get(id)),
        description:
          from == null
            ? `${name(id)} remains in the game as the ${where.fielder}.`
            : `Defensive switch from ${POSITION_WORDS[from].place} to ${where.place} for ${name(id)}.`
      })
    )
  }
  return changes
}

export interface Override {
  inning: number
  top: boolean
  awayScore: number
  homeScore: number
  balls: number
  strikes: number
  outs: number
  batter: number | null
  pitcher: number | null
  bases: Array<number | null>
}
export function overrideOf(state: GameState): Override {
  const line = state.liveData.linescore
  return {
    inning: line.currentInning,
    top: line.isTopInning,
    awayScore: line.teams.away.runs,
    homeScore: line.teams.home.runs,
    balls: line.balls,
    strikes: line.strikes,
    outs: line.outs,
    batter: line.offense.batter?.id ?? null,
    pitcher: line.defense.P?.id ?? null,
    bases: baseIds(state)
  }
}

/** Sets the inning, the score, the count, the batter, the pitcher and the bases. */
export function applyOverride(
  state: GameState,
  draft: Override
): { state?: GameState; error?: string } {
  const bounded = (
    n: number,
    min: number,
    max = Number.MAX_SAFE_INTEGER
  ): boolean => Number.isSafeInteger(n) && n >= min && n <= max
  if (
    !bounded(draft.inning, 1) ||
    !bounded(draft.awayScore, 0) ||
    !bounded(draft.homeScore, 0) ||
    !bounded(draft.balls, 0, 3) ||
    !bounded(draft.strikes, 0, 2) ||
    !bounded(draft.outs, 0, 2)
  )
    return {
      error:
        'Use whole numbers: inning 1 or higher, scores 0 or higher, balls 0–3, strikes 0–2, outs 0–2.'
    }
  const next = copyState(state)
  const side: Side = draft.top ? 'away' : 'home'
  const opponent: Side = draft.top ? 'home' : 'away'
  const team = next.liveData.boxscore.teams[side]
  const defense = next.liveData.boxscore.teams[opponent]
  if (draft.batter == null || !team.battingOrder.includes(draft.batter))
    return { error: 'Choose a batter from the batting team lineup.' }
  const runners = draft.bases.filter((id): id is number => id != null)
  if (
    draft.bases.length !== 3 ||
    !unique(runners) ||
    runners.includes(draft.batter) ||
    !runners.every(id => team.players.includes(id))
  )
    return {
      error:
        'Bases need distinct batting-team players, and cannot include the batter.'
    }
  if (draft.pitcher == null || !defense.players.includes(draft.pitcher))
    return { error: 'Choose a pitcher from the fielding team.' }
  const line = next.liveData.linescore
  const changedHalf =
    line.isTopInning !== draft.top || line.currentInning !== draft.inning
  line.currentInning = draft.inning
  line.currentInningOrdinal = ordinal(draft.inning)
  line.isTopInning = draft.top
  line.inningState = draft.top ? 'Top' : 'Bottom'
  line.teams.away.runs = draft.awayScore
  line.teams.home.runs = draft.homeScore
  line.balls = draft.balls
  line.strikes = draft.strikes
  line.outs = draft.outs
  for (const position of POSITIONS)
    if (defense.defense[position] === draft.pitcher)
      defense.defense[position] = null
  defense.defense.P = draft.pitcher
  team.battingIndex = team.battingOrder.indexOf(draft.batter)
  line.offense = {
    batter: refOf(next, draft.batter),
    first: refOf(next, draft.bases[0]),
    second: refOf(next, draft.bases[1]),
    third: refOf(next, draft.bases[2])
  }
  updateDefense(next)
  const play = next.liveData.plays.currentPlay
  if (play == null || changedHalf) startAppearance(next)
  else {
    if (play.matchup.batter.id !== draft.batter)
      play.matchup.batSide.code =
        next.gameData.players[draft.batter].bats === 'left' ? 'L' : 'R'
    play.matchup.batter = playerRef(next, draft.batter)
    play.matchup.pitcher = playerRef(next, draft.pitcher)
    play.count = { balls: line.balls, strikes: line.strikes, outs: line.outs }
  }
  next.awaitingBatter = null
  return { state: next }
}

export interface RosterPlayer {
  userId: number | null
  shortName: string
  jersey?: string | null
  bats?: 'left' | 'right' | 'switch' | null
  throws?: 'left' | 'right' | null
  positions?: string[]
}

export function addPlayer(
  state: {
    gameData: GameState['gameData']
    liveData: { boxscore: GameState['liveData']['boxscore'] }
    meta: { tagOrder: number[] }
  },
  side: Side,
  playerId: number,
  name: string,
  jersey = ''
): number {
  const id = asGumboId(playerId)
  if (state.gameData.players[id] != null)
    throw new Error('Player already exists in game')
  if (!state.meta.tagOrder.includes(id)) state.meta.tagOrder.push(id)
  state.gameData.players[id] = {
    id,
    userId: id,
    teamId: state.gameData.teams[side].id,
    fullName: name.trim(),
    jersey,
    bats: 'right',
    throws: null,
    positions: [],
    local: true
  }
  state.liveData.boxscore.teams[side].players.push(id)
  return id
}

function emptySide(): GameSide {
  return {
    players: [],
    battingOrder: [],
    battingIndex: 0,
    defense: Object.fromEntries(
      POSITIONS.map(position => [position, null])
    ) as Record<Position, number | null>,
    pitchCounts: {}
  }
}

/**
 * Top of the first, nobody out, nobody on, nothing played, on a field whose
 * fence stands `fenceDistanceFt` from home plate.
 */
export function freshGame(
  gamePk: string,
  teams: Record<Side, GameTeam>,
  setup: GameSetup,
  fenceDistanceFt: number = DEFAULT_FENCE_DISTANCE_FT
): GameState {
  const state: GameState = {
    gamePk,
    gameData: {
      teams: copyState(teams),
      players: copyState(setup.players),
      venue: { fieldInfo: fieldInfoOf(fenceDistanceFt) }
    },
    liveData: {
      linescore: {
        currentInning: 1,
        currentInningOrdinal: '1st',
        inningState: 'Top',
        isTopInning: true,
        balls: 0,
        strikes: 0,
        outs: 0,
        teams: {
          away: { runs: 0, hits: 0, errors: 0 },
          home: { runs: 0, hits: 0, errors: 0 }
        },
        offense: { batter: null, first: null, second: null, third: null },
        defense: Object.fromEntries(
          POSITIONS.map(position => [position, null])
        ) as Record<Position, PlayerRef | null>
      },
      boxscore: { teams: copyState(setup.sides) },
      plays: { allPlays: [], currentPlay: null }
    },
    pending: null,
    homeQueue: [],
    recentPitch: null,
    awaitingBatter: null,
    final: false,
    meta: { sequence: 0, tagOrder: [...setup.tagOrder] }
  }
  state.awaitingBatter = startAppearance(state)
  return state
}

/**
 * A new game from the two rosters: everyone who plays, batting in roster order, with each position
 * given to the first player who lists it and the rest filled in order.
 */
export function newSetup(
  teams: Record<Side, GameTeam>,
  rosters: Record<Side, RosterPlayer[]>,
  _fillRoster = false
): GameSetup {
  const players: Record<number, GamePlayer> = {}
  const draft = {
    gameData: { teams, players },
    liveData: { boxscore: { teams: { away: emptySide(), home: emptySide() } } },
    meta: { tagOrder: [] as number[] }
  }
  for (const side of ['away', 'home'] as const) {
    const team = draft.liveData.boxscore.teams[side]
    for (const row of rosters[side]) {
      const id = asGumboId(row.userId)
      if (draft.gameData.players[id] != null)
        throw new Error('Player appears more than once in the game roster')
      draft.gameData.players[id] = {
        id,
        userId: row.userId,
        teamId: teams[side].id,
        fullName: row.shortName,
        jersey: row.jersey ?? '',
        bats: row.bats ?? 'right',
        throws: row.throws ?? null,
        positions: [...(row.positions ?? [])],
        local: false
      }
      team.players.push(id)
      draft.meta.tagOrder.push(id)
    }
    team.battingOrder = [...team.players]
    const assigned = new Set<number>()
    for (const position of POSITIONS) {
      const id = team.players.find(
        id =>
          !assigned.has(id) &&
          draft.gameData.players[id].positions.includes(position)
      )
      if (id != null) {
        team.defense[position] = id
        assigned.add(id)
      }
    }
    for (const position of POSITIONS)
      if (team.defense[position] == null) {
        const id = team.players.find(id => !assigned.has(id))
        if (id != null) {
          team.defense[position] = id
          assigned.add(id)
        }
      }
  }
  return {
    players: draft.gameData.players,
    sides: draft.liveData.boxscore.teams,
    tagOrder: draft.meta.tagOrder
  }
}
