import {
  asGamePlay,
  copyState,
  type GamePlayer,
  type GameSetup,
  type GameSide,
  type GameState,
  type GameTeam,
  type PlayerIdentityMap,
  type PlayerRef,
  type Position,
  POSITIONS,
  type Side
} from './state'

/** Who bats, who fields, and who is where: the lineup and the players. */

export function createIdentityMap(): PlayerIdentityMap {
  return { sourceToSession: {}, sessionToSource: {}, nextId: 1 }
}

/**
 * The session id for a player. The same server identity always gets the same
 * id; a player made up at the field (`source` null) always gets a new one.
 * Type-prefixed keys keep `"123"` and `123` apart.
 */
export function allocatePlayer(
  map: PlayerIdentityMap,
  source: string | number | null
): number {
  const key = `${typeof source}:${String(source)}`
  if (source != null && map.sourceToSession[key] != null)
    return map.sourceToSession[key]
  while (Object.hasOwn(map.sessionToSource, map.nextId)) map.nextId++
  if (!Number.isSafeInteger(map.nextId))
    throw new Error('Local player identifiers exhausted')
  const id = map.nextId++
  map.sessionToSource[id] = source
  if (source != null) map.sourceToSession[key] = id
  return id
}

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
  if (id == null) throw new Error('A lineup needs a batter')
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
  if (pitcher == null) throw new Error('A batter and pitcher are required')
  state.liveData.linescore.offense.batter = batter
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
    source: {
      system: 'gamestation',
      gamestation: { version: 'estimated-v1', outcome: '' }
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

/** Why a setup cannot be played, or undefined when it can. */
export function validateRoster(state: {
  gameData: GameState['gameData']
  liveData: { boxscore: GameState['liveData']['boxscore'] }
}): string | undefined {
  for (const side of ['away', 'home'] as const) {
    const team = state.liveData.boxscore.teams[side]
    const name = state.gameData.teams[side].name
    const member = (id: number): boolean =>
      team.players.includes(id) &&
      state.gameData.players[id]?.teamId === state.gameData.teams[side].id
    if (team.battingOrder.length === 0) return `${name} needs a lineup.`
    if (
      !unique(team.players) ||
      !unique(team.battingOrder) ||
      !team.battingOrder.every(member)
    )
      return `${name} has an invalid or duplicate lineup player.`
    const defense = POSITIONS.map(position => team.defense[position]).filter(
      (id): id is number => id != null
    )
    if (team.defense.P == null) return `${name} needs a pitcher.`
    if (!unique(defense) || !defense.every(member))
      return `${name} has an invalid or duplicate defender.`
  }
}

/**
 * Takes the players and lineups of `setup`, keeping each side's pitch counts
 * and choosing who bats next: the batter due when he is still in the order,
 * `nextBatter` when the batter due was on base, and otherwise the next one in
 * the old order who is still in the new one and not on base.
 */
export function applyRoster(
  state: GameState,
  setup: GameSetup,
  nextBatter?: number
): { state?: GameState; error?: string } {
  const draft = {
    gameData: { teams: state.gameData.teams, players: setup.players },
    liveData: { boxscore: { teams: setup.sides } }
  }
  const error = validateRoster(draft)
  if (error != null) return { error }
  const next = copyState(state)
  next.gameData.players = copyState(setup.players)
  next.meta.identities = copyState(setup.identities)
  const occupied = baseIds(next)
  const activeSide = battingSide(next)
  for (const side of ['away', 'home'] as const) {
    const before = state.liveData.boxscore.teams[side]
    const after: GameSide = copyState(setup.sides[side])
    after.pitchCounts = copyState(before.pitchCounts)
    const oldId = before.battingOrder[before.battingIndex]
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
    after.battingIndex = after.battingOrder.indexOf(id)
    next.liveData.boxscore.teams[side] = after
  }
  updateDefense(next)
  const team = next.liveData.boxscore.teams[activeSide]
  const batter = playerRef(next, team.battingOrder[team.battingIndex])
  const play = next.liveData.plays.currentPlay
  if (play == null) startAppearance(next)
  else {
    if (play.matchup.batter.id !== batter.id)
      play.matchup.batSide.code =
        next.gameData.players[batter.id].bats === 'left' ? 'L' : 'R'
    play.matchup.batter = batter
    const pitcher = next.liveData.linescore.defense.P
    if (pitcher != null) play.matchup.pitcher = pitcher
    next.liveData.linescore.offense.batter = batter
  }
  next.awaitingBatter = null
  return { state: next }
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
    meta: { identities: PlayerIdentityMap }
  },
  side: Side,
  name: string,
  jersey = ''
): number {
  const id = allocatePlayer(state.meta.identities, null)
  state.gameData.players[id] = {
    id,
    userId: null,
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

/** Top of the first, nobody out, nobody on, nothing played. */
export function freshGame(
  gamePk: string,
  teams: Record<Side, GameTeam>,
  setup: GameSetup
): GameState {
  const state: GameState = {
    gamePk,
    gameData: { teams: copyState(teams), players: copyState(setup.players) },
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
    meta: { sequence: 0, identities: copyState(setup.identities) }
  }
  state.awaitingBatter = startAppearance(state)
  return state
}

/**
 * A new game from the two rosters: everyone who plays, topped up to nine a
 * side with made-up players, batting in roster order, with each position
 * given to the first player who lists it and the rest filled in order.
 */
export function newSetup(
  teams: Record<Side, GameTeam>,
  rosters: Record<Side, RosterPlayer[]>
): GameSetup {
  const players: Record<number, GamePlayer> = {}
  const draft = {
    gameData: { teams, players },
    liveData: { boxscore: { teams: { away: emptySide(), home: emptySide() } } },
    meta: { identities: createIdentityMap() }
  }
  for (const side of ['away', 'home'] as const) {
    const team = draft.liveData.boxscore.teams[side]
    for (const row of rosters[side]) {
      const id = allocatePlayer(draft.meta.identities, row.userId)
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
    }
    while (team.players.length < 9)
      addPlayer(
        draft,
        side,
        `Player ${team.players.length + 1}`,
        String(team.players.length + 1)
      )
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
    identities: draft.meta.identities
  }
}
