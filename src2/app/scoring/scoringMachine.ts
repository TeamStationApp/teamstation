import { asScoringPlay } from './scoringContract'
import { applyOverrideDraft, applyRosterDraft } from './scoringEdits'
import {
  baseIds,
  battingSide,
  canSwitchBatter,
  fieldingSide,
  playerRef,
  startAppearance
} from './scoringSelectors'
import type {
  ScoringEvent,
  ScoringSessionState,
  ScoringSnapshot,
  ScoringState
} from './scoringTypes'

export function copyState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
export function initialScoringState(
  session: ScoringSessionState
): ScoringState {
  const owned = copyState(session)
  const awaitingBatter =
    owned.liveData.plays.currentPlay == null ? startAppearance(owned) : null
  return {
    session: owned,
    phase: awaitingBatter == null ? 'ready' : 'awaitingBatter',
    pendingPlay: null,
    homeQueue: [],
    awaitingBatter,
    generation: 0,
    past: []
  }
}
export function snapshotOf(state: ScoringState): ScoringSnapshot {
  const { past: _past, ...snapshot } = state
  return copyState(snapshot)
}
export function accepted(
  state: ScoringState,
  label: string,
  edit: (next: ScoringState) => void
): ScoringState {
  const next: ScoringState = {
    ...snapshotOf(state),
    past: [...state.past, { label, snapshot: snapshotOf(state) }]
  }
  edit(next)
  next.session.meta.sequence++
  return next
}
export function nextHalf(state: ScoringState): void {
  const line = state.session.liveData.linescore
  if (!line.isTopInning) line.currentInning++
  line.isTopInning = !line.isTopInning
  line.inningState = line.isTopInning ? 'Top' : 'Bottom'
  const number = line.currentInning
  line.currentInningOrdinal = `${number}${number % 100 >= 11 && number % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][number % 10] ?? 'th')}`
  line.balls = 0
  line.strikes = 0
  line.outs = 0
  line.offense = { batter: null, first: null, second: null, third: null }
  state.pendingPlay = null
  state.homeQueue = []
  state.generation++
  state.awaitingBatter = startAppearance(state.session)
  state.phase = state.awaitingBatter == null ? 'ready' : 'awaitingBatter'
}
function closePlay(state: ScoringState): ScoringState {
  if (state.phase !== 'correctionWindow' || state.pendingPlay == null)
    return state
  const next = { ...snapshotOf(state), past: state.past }
  const session = next.session
  const play = session.liveData.plays.currentPlay
  if (play == null) return state
  play.about.isComplete = true
  play.result.awayScore = session.liveData.linescore.teams.away.runs
  play.result.homeScore = session.liveData.linescore.teams.home.runs
  session.liveData.plays.allPlays.push(asScoringPlay(play))
  const lineup = session.liveData.boxscore.teams[battingSide(session)]
  lineup.battingIndex = (lineup.battingIndex + 1) % lineup.battingOrder.length
  next.pendingPlay = null
  next.homeQueue = []
  if (session.liveData.linescore.outs >= 3) nextHalf(next)
  else {
    session.liveData.linescore.balls = 0
    session.liveData.linescore.strikes = 0
    next.awaitingBatter = startAppearance(session)
    next.phase = next.awaitingBatter == null ? 'ready' : 'awaitingBatter'
  }
  session.meta.sequence++
  return next
}
export function scoringReducer(
  state: ScoringState,
  event: ScoringEvent
): ScoringState {
  if (event.type === 'UNDO') {
    const last = state.past.at(-1)
    return last == null
      ? state
      : {
          ...copyState(last.snapshot),
          generation: state.generation + 1,
          past: state.past.slice(0, -1)
        }
  }
  if (event.type === 'ROSTER' || event.type === 'OVERRIDE') {
    if (state.phase !== 'ready' && state.phase !== 'awaitingBatter')
      return state
    const result =
      event.type === 'ROSTER'
        ? applyRosterDraft(state, event.draft, event.nextBatter)
        : applyOverrideDraft(state, event.draft)
    if (result.session == null) return state
    return accepted(
      state,
      event.type === 'ROSTER' ? 'Set team roster' : 'Override game state',
      next => {
        next.session = result.session!
        next.phase = 'ready'
        next.awaitingBatter = null
        next.generation++
      }
    )
  }
  if (event.type === 'CLOSE_PLAY') return closePlay(state)
  if (event.type === 'END_HALF')
    return state.phase !== 'ready'
      ? state
      : accepted(state, 'End half inning', nextHalf)
  if (state.phase !== 'ready') return state
  if (event.type === 'SWITCH_SIDE') {
    if (
      !canSwitchBatter(state.session) ||
      state.session.liveData.plays.currentPlay?.matchup.batSide.code ===
        event.side
    )
      return state
    return accepted(
      state,
      `Batter ${event.side === 'L' ? 'left' : 'right'} handed`,
      next => {
        const play = next.session.liveData.plays.currentPlay
        if (play != null) play.matchup.batSide.code = event.side
      }
    )
  }
  const labels = {
    ball: 'Ball',
    called: 'Called Strike',
    swing: 'Swing and Miss',
    foul: 'Foul Ball'
  }
  return accepted(state, labels[event.kind], next => {
    const session = next.session
    const line = session.liveData.linescore
    const play = session.liveData.plays.currentPlay
    if (play == null) throw new Error('Ready requires an active play')
    const before = { balls: line.balls, strikes: line.strikes, outs: line.outs }
    const pitcher = play.matchup.pitcher.id
    const counts =
      session.liveData.boxscore.teams[fieldingSide(session)].pitchCounts
    counts[pitcher] = (counts[pitcher] ?? 0) + 1
    play.playEvents.push({
      index: play.playEvents.length,
      isPitch: true,
      type: 'pitch',
      details: {
        code: { ball: 'B', called: 'C', swing: 'S', foul: 'F' }[event.kind],
        description: labels[event.kind]
      },
      count: before,
      player: play.matchup.pitcher
    })
    if (event.kind === 'ball') line.balls++
    else if (event.kind !== 'foul' || line.strikes < 2) line.strikes++
    if (line.balls >= 4 || line.strikes >= 3) {
      const walk = line.balls >= 4
      const originalBases = baseIds(session)
      next.pendingPlay = {
        outcome: walk ? 'Walk' : 'Strikeout',
        originalBases,
        originalRuns: line.teams[battingSide(session)].runs,
        originalOuts: line.outs,
        movements: [],
        trajectoryAccepted: true
      }
      play.result.event = walk ? 'Walk' : 'Strikeout'
      play.result.eventType = walk ? 'walk' : 'strikeout'
      play.result.description = play.result.event
      play.source.gamestation.outcome = play.result.event
      if (walk) {
        let carry: number | null = play.matchup.batter.id
        for (let base = 1; base <= 3 && carry != null; base++) {
          const id: number = carry
          carry = originalBases[base - 1]
          const key = (['first', 'second', 'third'] as const)[base - 1]
          line.offense[key] = playerRef(session, id)
          next.pendingPlay.movements.push({
            playerId: id,
            from: base - 1,
            to: base,
            force: true,
            decision: 'safe'
          })
        }
        if (carry != null) {
          next.homeQueue = [carry]
          next.pendingPlay.movements.push({
            playerId: carry,
            from: 3,
            to: 4,
            force: true,
            decision: 'pending'
          })
        }
      } else line.outs++
      next.phase =
        next.homeQueue.length === 0 ? 'correctionWindow' : 'homeDecision'
    }
    play.count = { balls: line.balls, strikes: line.strikes, outs: line.outs }
    asScoringPlay(play)
  })
}
