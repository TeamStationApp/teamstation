import { copyState } from './scoringMachine'
import {
  baseIds,
  battingSide,
  fieldingSide,
  playerRef,
  startAppearance,
  updateDefense
} from './scoringSelectors'
import {
  POSITIONS,
  type ScoringSessionState,
  type ScoringState,
  type Side
} from './scoringTypes'

export interface EditResult {
  session?: ScoringSessionState
  error?: string
}
const unique = (ids: number[]): boolean => new Set(ids).size === ids.length
export function validateRoster(
  session: ScoringSessionState
): string | undefined {
  for (const side of ['away', 'home'] as const) {
    const team = session.liveData.boxscore.teams[side]
    const name = session.gameData.teams[side].name
    const member = (id: number): boolean =>
      team.players.includes(id) &&
      session.gameData.players[id]?.teamId === session.gameData.teams[side].id
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
export function applyRosterDraft(
  state: ScoringState,
  draft: ScoringSessionState,
  nextBatter?: number
): EditResult {
  const error = validateRoster(draft)
  if (error != null) return { error }
  const session = copyState(state.session)
  session.gameData.players = copyState(draft.gameData.players)
  session.meta.identities = copyState(draft.meta.identities)
  const occupied = baseIds(session)
  const activeSide = battingSide(session)
  for (const side of ['away', 'home'] as const) {
    const before = state.session.liveData.boxscore.teams[side]
    const after = copyState(draft.liveData.boxscore.teams[side])
    after.pitchCounts = copyState(before.pitchCounts)
    const oldId = before.battingOrder[before.battingIndex]
    let id = after.battingOrder.includes(oldId) ? oldId : undefined
    if (side === activeSide && state.phase === 'awaitingBatter') id = nextBatter
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
    session.liveData.boxscore.teams[side] = after
  }
  updateDefense(session)
  const team = session.liveData.boxscore.teams[activeSide]
  const batter = playerRef(session, team.battingOrder[team.battingIndex])!
  const play = session.liveData.plays.currentPlay
  if (play == null) startAppearance(session)
  else {
    if (play.matchup.batter.id !== batter.id)
      play.matchup.batSide.code =
        session.gameData.players[batter.id].bats === 'left' ? 'L' : 'R'
    play.matchup.batter = batter
    play.matchup.pitcher = session.liveData.linescore.defense.P!
    session.liveData.linescore.offense.batter = batter
  }
  return { session }
}
export interface OverrideDraft {
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
export function overrideDraft(session: ScoringSessionState): OverrideDraft {
  const line = session.liveData.linescore
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
    bases: baseIds(session)
  }
}
export function applyOverrideDraft(
  state: ScoringState,
  draft: OverrideDraft
): EditResult {
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
  const session = copyState(state.session)
  const side: Side = draft.top ? 'away' : 'home'
  const opponent: Side = draft.top ? 'home' : 'away'
  const team = session.liveData.boxscore.teams[side]
  const defense = session.liveData.boxscore.teams[opponent]
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
  const line = session.liveData.linescore
  const changedHalf =
    line.isTopInning !== draft.top || line.currentInning !== draft.inning
  line.currentInning = draft.inning
  const n = draft.inning
  line.currentInningOrdinal = `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`
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
    batter: playerRef(session, draft.batter),
    first: playerRef(session, draft.bases[0]),
    second: playerRef(session, draft.bases[1]),
    third: playerRef(session, draft.bases[2])
  }
  updateDefense(session)
  const play = session.liveData.plays.currentPlay
  if (play == null || changedHalf) startAppearance(session)
  else {
    if (play.matchup.batter.id !== draft.batter)
      play.matchup.batSide.code =
        session.gameData.players[draft.batter].bats === 'left' ? 'L' : 'R'
    play.matchup.batter = line.offense.batter!
    play.matchup.pitcher = line.defense.P!
    play.count = { balls: line.balls, strikes: line.strikes, outs: line.outs }
  }
  // Accessors agree with the selected half after the atomic replacement.
  if (battingSide(session) !== side || fieldingSide(session) !== opponent)
    throw new Error('Invalid half')
  return { session }
}
