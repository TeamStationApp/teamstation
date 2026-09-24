import { BASES, type GroundPoint } from '../field/fieldModel'
import { asScoringPlay } from './scoringContract'
import {
  accepted,
  closePlay,
  copyState,
  nextHalf,
  snapshotOf
} from './scoringMachine'
import { throwPresentation, type ThrowSequence } from './scoringPresentation'
import { baseIds, battingSide, playerRef } from './scoringSelectors'
import {
  type Movement,
  POSITIONS,
  type ScoringEvent,
  type ScoringState
} from './scoringTypes'

export const ADVANCE_SAFE_REASONS = [
  'Steal',
  'Throwing Error',
  'Fielding Error',
  'Defensive Indifference',
  'Other'
]
export const ADVANCE_OUT_REASONS = [
  'Caught Stealing',
  'Offensive Interference',
  'Out on Appeal',
  'Other'
]
export const STATIONARY_OUT_REASONS = [
  'Picked Off',
  'Offensive Interference',
  'Out on Appeal',
  'Other'
]
const baseKeys = ['first', 'second', 'third'] as const
export const hitBases: Record<string, number> = {
  Single: 1,
  Error: 1,
  Double: 2,
  Triple: 3,
  'Home Run': 4
}
export function homeQueuePoint(index: number): GroundPoint {
  const distance = 1.2 + index * 0.61
  return { x: -distance / Math.SQRT2, z: -distance / Math.SQRT2 }
}
export function basePath(from: number, to: number): GroundPoint[] {
  const points = [{ ...BASES[from % 4] }]
  for (let base = from + 1; base <= Math.min(4, to); base++)
    points.push({ ...BASES[base % 4] })
  if (to < from)
    for (let base = from - 1; base >= to; base--)
      points.push({ ...BASES[base % 4] })
  return points
}
function enqueue(
  state: ScoringState,
  id: number,
  waypoints: GroundPoint[]
): void {
  state.motions = state.motions.filter(motion => motion.playerId !== id)
  state.motions.push({
    id: `${state.generation}:${state.session.meta.sequence}:${id}:${state.motions.length}`,
    generation: state.generation,
    playerId: id,
    waypoints: copyState(waypoints),
    complete: waypoints.length < 2
  })
}
export function approachFirst(
  state: ScoringState,
  id: number,
  start: GroundPoint,
  end: GroundPoint
): void {
  enqueue(state, id, [start, end])
  state.motions.find(m => m.playerId === id)!.purpose = 'approachFirst'
}
function runMotion(state: ScoringState, movement: Movement): void {
  const path = basePath(movement.from, movement.to)
  if (movement.from === 0)
    path[0] = {
      x:
        state.session.liveData.plays.currentPlay?.matchup.batSide.code === 'L'
          ? 4
          : -4,
      z: 0
    }
  if (movement.to === 4 && movement.decision === 'pending')
    path[path.length - 1] = homeQueuePoint(
      state.homeQueue.indexOf(movement.playerId)
    )
  if (movement.automaticHome === true) {
    if (state.homeQueue.length > 0)
      path[path.length - 1] = homeQueuePoint(state.homeQueue.length)
    else {
      movement.homeReleased = true
      path.push({ x: battingSide(state.session) === 'home' ? 32 : -32, z: 6 })
    }
  }
  enqueue(state, movement.playerId, path)
}
function dugout(state: ScoringState, id: number, origin: GroundPoint): void {
  enqueue(state, id, [
    origin,
    { x: battingSide(state.session) === 'home' ? 32 : -32, z: 6 }
  ])
}
function setBase(state: ScoringState, id: number, to: number): void {
  const offense = state.session.liveData.linescore.offense
  for (const key of baseKeys) if (offense[key]?.id === id) offense[key] = null
  if (to >= 1 && to <= 3)
    offense[baseKeys[to - 1]] = playerRef(state.session, id)
}
export function recordRunner(
  state: ScoringState,
  movement: Movement,
  reason: string,
  credits: Array<{ id: number; credit: 'f_assist' | 'f_putout' }> = []
): void {
  const session = state.session
  const play = session.liveData.plays.currentPlay!
  const out = movement.decision === 'out'
  play.runners.push({
    movement: {
      originBase: movement.from,
      start: movement.from,
      end: movement.to,
      isOut: out,
      forceOut: out && movement.force,
      runScored: !out && movement.to === 4,
      outNumber: out ? session.liveData.linescore.outs : undefined
    },
    details: {
      runner: playerRef(session, movement.playerId)!,
      movementReason: reason
    },
    credits: credits.map(credit => ({
      player: playerRef(session, credit.id)!,
      credit: credit.credit,
      position:
        POSITIONS.find(
          position =>
            session.liveData.linescore.defense[position]?.id === credit.id
        ) ?? ''
    }))
  })
  const record = play.runners.at(-1)!
  play.source.gamestation.runnerActions ??= []
  play.source.gamestation.runnerActions.push({
    runner: record.details.runner,
    origin: movement.from,
    destination: movement.to,
    reason,
    pitchReference:
      state.moreDraft == null ? undefined : (state.recentPitch ?? undefined),
    isOut: out,
    forceOut: out && movement.force,
    runScored: !out && movement.to === 4,
    credits: record.credits,
    throwerLocation: state.runnerAction?.throwerPoint,
    defenderLocation: state.runnerAction?.defenderPoint,
    defensiveRoute: state.runnerAction?.defensiveRoute?.map(hop => ({
      player: playerRef(session, hop.id)!,
      location: hop.point
    }))
  })
  play.count = {
    balls: session.liveData.linescore.balls,
    strikes: session.liveData.linescore.strikes,
    outs: session.liveData.linescore.outs
  }
}
function actionEvent(state: ScoringState, id: number, reason: string): void {
  const play = state.session.liveData.plays.currentPlay!
  const line = state.session.liveData.linescore
  play.playEvents.push({
    index: play.playEvents.length,
    isPitch: false,
    type: 'action',
    details: { description: reason, code: 'runner_action' },
    count: { balls: line.balls, strikes: line.strikes, outs: line.outs },
    player: playerRef(state.session, id)!
  })
}
function rebuildQueue(state: ScoringState): void {
  state.homeQueue = (state.pendingPlay?.movements ?? [])
    .filter(move => move.to === 4 && move.decision === 'pending')
    .sort((a, b) => b.from - a.from)
    .map(move => move.playerId)
}
export function prepareHit(state: ScoringState): void {
  const pending = state.pendingPlay!
  const bases = hitBases[pending.outcome]
  if (bases == null) return
  const batter = state.session.liveData.plays.currentPlay!.matchup.batter.id
  const runners = pending.originalBases
    .map((id, index) => ({ id, from: index + 1 }))
    .filter((row): row is { id: number; from: number } => row.id != null)
    .reverse()
  pending.movements = [...runners, { id: batter, from: 0 }].map(row => {
    const to = Math.min(4, row.from + bases)
    const forced =
      row.from === 0 ||
      pending.originalBases.slice(0, row.from).every(id => id != null)
    const automaticHome =
      pending.outcome === 'Home Run' &&
      (pending.homeRunKind === 'out-of-park' || row.from === 0)
    return {
      playerId: row.id,
      from: row.from,
      to,
      automaticHome,
      force: forced && to === row.from + 1,
      decision: to === 4 && !automaticHome ? 'pending' : 'safe',
      resolved: false
    }
  })
  rebuildQueue(state)
  for (const key of baseKeys)
    state.session.liveData.linescore.offense[key] = null
  for (const movement of pending.movements) {
    if (movement.to < 4) {
      setBase(state, movement.playerId, movement.to)
      recordRunner(state, movement, pending.outcome)
    }
    runMotion(state, movement)
  }
  if (pending.outcome !== 'Error')
    state.session.liveData.linescore.teams[battingSide(state.session)].hits++
}
export function applyAwardMovements(state: ScoringState, reason: string): void {
  const pending = state.pendingPlay!
  rebuildQueue(state)
  for (const key of baseKeys)
    state.session.liveData.linescore.offense[key] = null
  for (const movement of pending.movements) {
    if (movement.to < 4) {
      setBase(state, movement.playerId, movement.to)
      recordRunner(state, movement, reason)
    }
    runMotion(state, movement)
  }
}
export function prepareTerminalPitch(state: ScoringState): void {
  const pending = state.pendingPlay!
  if (pending.outcome === 'Walk') {
    for (const movement of pending.movements) {
      if (movement.to < 4) recordRunner(state, movement, 'Walk')
      runMotion(state, movement)
    }
  } else {
    const batter = state.session.liveData.plays.currentPlay!.matchup.batter.id
    pending.movements.push({
      playerId: batter,
      from: 0,
      to: 0,
      force: false,
      decision: 'out',
      resolved: true
    })
    recordRunner(state, pending.movements[0], 'Strikeout')
    dugout(state, batter, { ...BASES[0] })
  }
  settleRunners(state)
}
function finishBetween(state: ScoringState): void {
  if (state.session.liveData.linescore.outs >= 3) {
    const play = state.session.liveData.plays.currentPlay!
    play.about.isComplete = true
    play.result.description = state.runnerAction?.reason ?? 'Runner out'
    play.result.event = 'Runner out'
    play.result.eventType = 'runner_out'
    play.result.awayScore = state.session.liveData.linescore.teams.away.runs
    play.result.homeScore = state.session.liveData.linescore.teams.home.runs
    state.session.liveData.plays.allPlays.push(asScoringPlay(play))
    nextHalf(state)
  } else {
    state.phase = 'ready'
    state.runnerAction = null
    state.motions = []
  }
}
function commitChoiceIfResolved(state: ScoringState): void {
  const pending = state.pendingPlay
  if (
    pending == null ||
    pending.choiceApplied === true ||
    !["Fielder's Choice", 'Error', 'Dropped Third Strike'].includes(
      pending.outcome
    ) ||
    state.session.liveData.linescore.outs >= 3 ||
    pending.movements.some(move => move.to < 4 && move.decision === 'pending')
  )
    return
  pending.choiceApplied = true
  for (const key of baseKeys)
    state.session.liveData.linescore.offense[key] = null
  for (const move of pending.movements) {
    if (move.decision === 'out') continue
    if (move.to === 4) move.decision = 'pending'
    else setBase(state, move.playerId, move.to)
  }
  rebuildQueue(state)
  for (const move of pending.movements)
    if (move.decision !== 'out' && move.from !== move.to) {
      if (move.to < 4) recordRunner(state, move, pending.outcome)
      runMotion(state, move)
    }
}
function resolveAutomaticHomes(state: ScoringState): void {
  const pending = state.pendingPlay
  if (pending == null || state.presentation != null) return
  for (const move of pending.movements) {
    if (
      move.automaticHome !== true ||
      move.resolved === true ||
      state.motions.some(m => m.playerId === move.playerId && !m.complete)
    )
      continue
    const origin =
      state.motions.find(m => m.playerId === move.playerId)?.waypoints.at(-1) ??
      homeQueuePoint(state.homeQueue.length)
    if (state.session.liveData.linescore.outs >= 3) {
      move.resolved = true
      dugout(state, move.playerId, origin)
      continue
    }
    if (state.homeQueue.length > 0) {
      const destination = homeQueuePoint(state.homeQueue.length)
      if (
        Math.hypot(origin.x - destination.x, origin.z - destination.z) > 0.001
      )
        enqueue(state, move.playerId, [origin, destination])
      continue
    }
    if (move.homeReleased !== true) {
      move.homeReleased = true
      enqueue(state, move.playerId, [
        origin,
        BASES[0],
        { x: battingSide(state.session) === 'home' ? 32 : -32, z: 6 }
      ])
      continue
    }
    move.resolved = true
    state.session.liveData.linescore.teams[battingSide(state.session)].runs++
    if (pending.outcome !== 'Balk')
      state.session.liveData.plays.currentPlay!.result.rbi++
    recordRunner(
      state,
      move,
      pending.automaticAward === true && pending.outcome !== 'Balk'
        ? state.session.liveData.plays.currentPlay!.result.event
        : pending.outcome
    )
  }
}
export function settleRunners(state: ScoringState): void {
  if (
    [
      'chooseThrower',
      'chooseDefender',
      'runnerDecision',
      'runnerReason',
      'errorCredit'
    ].includes(state.phase)
  )
    return
  const pending = state.pendingPlay
  if (pending != null && !pending.trajectoryAccepted) {
    state.phase = 'trajectory'
    return
  }
  if (
    pending != null &&
    state.session.liveData.linescore.outs < 3 &&
    pending.movements.some(move => move.to < 4 && move.decision === 'pending')
  ) {
    state.phase = 'resolveBatter'
    return
  }
  commitChoiceIfResolved(state)
  resolveAutomaticHomes(state)
  if (pending?.errorPending === true) {
    if (
      state.presentation != null ||
      state.motions.some(motion => !motion.complete)
    ) {
      state.phase = 'runnerMovement'
      return
    }
    state.runnerAction = {
      purpose: 'errorAttribution',
      playerId: state.session.liveData.plays.currentPlay!.matchup.batter.id,
      from: 0,
      to: 1,
      origin: 'current',
      returnPhase: 'runnerMovement'
    }
    beginDefense(state)
    return
  }
  const lead = state.homeQueue[0]
  if (
    lead != null &&
    state.session.liveData.linescore.outs < 3 &&
    !state.motions.some(motion => motion.playerId === lead && !motion.complete)
  ) {
    state.runnerAction = null
    state.phase = 'homeDecision'
    return
  }
  if (state.motions.some(motion => !motion.complete)) {
    state.phase = 'runnerMovement'
    return
  }
  if (pending?.automaticAward === true && state.presentation != null) {
    state.phase = 'runnerMovement'
    return
  }
  if (pending?.sameAppearance === true) {
    state.pendingPlay = null
    state.runnerAction = null
    state.correctionWindow = null
    if (state.session.liveData.linescore.outs >= 3) finishBetween(state)
    else state.phase = 'ready'
    return
  }
  if (state.runnerAction?.origin === 'between') {
    finishBetween(state)
    return
  }
  state.runnerAction = null
  if (state.homeQueue.length > 0 && state.session.liveData.linescore.outs < 3)
    state.phase = 'homeDecision'
  else if (pending != null) {
    state.phase = 'correctionWindow'
    state.correctionWindow ??= {
      remainingMs: 10000,
      revision: state.session.meta.sequence
    }
    if (
      state.presentation == null &&
      (pending.automaticAward === true ||
        baseIds(state.session).every(id => id == null) ||
        state.session.liveData.linescore.outs >= 3)
    )
      Object.assign(state, closePlay(state))
  } else state.phase = 'ready'
}
export function prepareBatterResult(state: ScoringState): void {
  const pending = state.pendingPlay!
  const batter = state.session.liveData.plays.currentPlay!.matchup.batter.id
  if (pending.outcome === 'Error') {
    pending.errorPending = true
    pending.choiceApplied = true
    settleRunners(state)
  } else if (
    pending.outcome === "Fielder's Choice" ||
    pending.outcome === 'Dropped Third Strike'
  ) {
    pending.movements = pending.originalBases
      .map((id, index) => ({ id, from: index + 1 }))
      .filter((row): row is { id: number; from: number } => row.id != null)
      .map(row => ({
        playerId: row.id,
        from: row.from,
        to: row.from,
        force: false,
        decision: 'safe',
        resolved: true
      }))
    pending.movements.push({
      playerId: batter,
      from: 0,
      to: 0,
      force: true,
      decision: 'pending'
    })
    state.phase = 'resolveBatter'
  } else if (
    ['Throw Out', 'Ball Caught', 'Batter Interference'].includes(
      pending.outcome
    )
  ) {
    state.runnerAction = {
      purpose: 'batterRetirement',
      playerId: batter,
      from: 0,
      to: pending.outcome === 'Throw Out' ? 1 : 0,
      origin: 'current',
      returnPhase: 'correctionWindow',
      decision: 'out',
      reason: pending.outcome,
      thrower: pending.fielder
    }
    if (pending.outcome === 'Throw Out') beginDefense(state)
    else finishOut(state, pending.fielder!)
  } else settleRunners(state)
}
export function homeBackProposal(state: ScoringState): Movement[] | null {
  const pending = state.pendingPlay
  const id = state.homeQueue[0]
  if (pending == null || id == null) return null
  const moves = copyState(pending.movements)
  const lead = moves.find(move => move.playerId === id)!
  if (lead.force || lead.from === 0) return null
  lead.to = 3
  lead.decision = 'safe'
  lead.resolved = true
  let previous = 3
  for (const move of moves
    .filter(
      move =>
        move.playerId !== id && move.decision !== 'out' && move.from < lead.from
    )
    .sort((a, b) => b.from - a.from)) {
    if (move.to < previous) {
      previous = move.to
      continue
    }
    if (move.from === 0 || move.resolved === true) return null
    const to = previous - 1
    const minimum = pending.originalBases
      .slice(0, move.from)
      .every(id => id != null)
      ? move.from + 1
      : move.from
    if (to < minimum || to < move.to - 1) return null
    move.to = to
    move.decision = to === 4 ? 'pending' : 'safe'
    previous = to
  }
  const occupied = moves
    .filter(move => move.decision !== 'out' && move.to > 0 && move.to < 4)
    .map(move => move.to)
  return new Set(occupied).size === occupied.length ? moves : null
}
export function finishOut(state: ScoringState, defender: number): void {
  const action = state.runnerAction!
  const pending = state.pendingPlay
  const line = state.session.liveData.linescore
  if (line.outs >= 3) return
  const old = pending?.movements.find(move => move.playerId === action.playerId)
  const choiceForce =
    pending != null &&
    ["Fielder's Choice", 'Error'].includes(pending.outcome) &&
    action.from > 0 &&
    action.to === action.from + 1 &&
    pending.originalBases.slice(0, action.from).every(id => id != null) &&
    pending.movements.some(move => move.from === 0 && move.decision !== 'out')
  const force =
    choiceForce ||
    (old?.force === true && old.decision === 'pending') ||
    (action.from === 0 && action.to <= 1)
  line.outs++
  const movement: Movement = {
    playerId: action.playerId,
    from: action.from,
    to: action.to,
    force,
    decision: 'out',
    resolved: true
  }
  if (old != null) Object.assign(old, movement)
  else pending?.movements.push(movement)
  setBase(state, action.playerId, 0)
  recordRunner(state, movement, action.reason ?? 'Out', [
    ...Array.from(
      new Set(
        (
          action.defensiveRoute ??
          (action.thrower == null ? [] : [{ id: action.thrower }])
        )
          .slice(0, action.defensiveRoute == null ? undefined : -1)
          .map(hop => hop.id)
      )
    )
      .filter(id => action.defensiveRoute != null || id !== defender)
      .map(id => ({ id, credit: 'f_assist' as const })),
    { id: defender, credit: 'f_putout' }
  ])
  actionEvent(state, action.playerId, action.reason ?? 'Out')
  const queueIndex = state.homeQueue.indexOf(action.playerId)
  dugout(
    state,
    action.playerId,
    action.runnerPoint ??
      (queueIndex >= 0
        ? homeQueuePoint(queueIndex)
        : action.from === 0 && pending?.batterPoint != null
          ? pending.batterPoint
          : BASES[action.from % 4])
  )
  state.homeQueue = state.homeQueue.filter(id => id !== action.playerId)
  if (queueIndex >= 0 && line.outs < 3)
    state.homeQueue.forEach((id, index) => {
      enqueue(state, id, [homeQueuePoint(index + 1), homeQueuePoint(index)])
    })
  if (line.outs >= 3) {
    if (pending != null && force) {
      line.teams[battingSide(state.session)].runs = pending.originalRuns
      state.session.liveData.plays.currentPlay!.result.rbi = 0
      const play = state.session.liveData.plays.currentPlay!
      for (const record of play.runners.slice(
        pending.originalRunnerRecordCount ?? 0
      ))
        record.movement.runScored = false
      for (const record of (play.source.gamestation.runnerActions ?? []).slice(
        pending.originalRunnerRecordCount ?? 0
      ))
        record.runScored = false
    }
    for (const id of state.homeQueue)
      dugout(state, id, homeQueuePoint(state.homeQueue.indexOf(id)))
    state.homeQueue = []
  }
  state.phase = 'runnerMovement'
  settleRunners(state)
}
function validDefender(
  state: ScoringState,
  id: number | undefined
): id is number {
  return (
    id != null &&
    Object.values(state.session.liveData.linescore.defense).some(
      player => player?.id === id
    )
  )
}
export function beginDefense(state: ScoringState): void {
  const action = state.runnerAction!
  const pending = state.pendingPlay
  const holder = pending?.ballHolder ?? pending?.fielder
  const point = pending?.ballLocation ?? pending?.location
  if (action.origin === 'current' && holder != null && point != null) {
    action.thrower = holder
    action.throwerPoint = { ...point }
    action.defensiveRoute = [{ id: holder, point: { ...point } }]
    state.phase = 'chooseDefender'
  } else state.phase = 'chooseThrower'
}
export function completeDefense(
  state: ScoringState,
  sequence: ThrowSequence
): void {
  const action = state.runnerAction!
  const point = { x: sequence.to.x, z: sequence.to.z }
  if (sequence.stage === 'transfer') {
    action.defensiveRoute ??= [
      { id: sequence.thrower, point: { ...sequence.holderOrigin } }
    ]
    action.defensiveRoute.push({ id: sequence.receiver, point })
    if (state.pendingPlay != null) {
      state.pendingPlay.ballHolder = sequence.receiver
      state.pendingPlay.ballLocation = { ...point }
      if (action.purpose === 'batterRetirement') {
        state.pendingPlay.batterPoint = { ...sequence.runnerFrom }
        approachFirst(state, action.playerId, sequence.runnerFrom, {
          x: BASES[1].x * 0.96,
          z: BASES[1].z * 0.96
        })
      }
    }
    state.phase = 'chooseDefender'
    return
  }
  action.defender = sequence.receiver
  action.defenderPoint = point
  action.runnerPoint = point
  const last = action.defensiveRoute?.at(-1)
  if (last != null) last.point = { ...point }
  if (state.pendingPlay != null) {
    state.pendingPlay.ballHolder = sequence.receiver
    state.pendingPlay.ballLocation = { ...point }
    if (action.purpose === 'batterRetirement')
      state.pendingPlay.batterPoint = { ...point }
  }
  finishOut(state, sequence.receiver)
}
export function runnerReasons(state: ScoringState): string[] {
  if (state.moreDraft != null) return [state.moreDraft.action]
  const action = state.runnerAction
  if (action?.decision === 'safe') return ADVANCE_SAFE_REASONS
  return action?.from === action?.to
    ? STATIONARY_OUT_REASONS
    : ADVANCE_OUT_REASONS
}
export function runnerDecisionError(state: ScoringState): string | undefined {
  const action = state.runnerAction
  if (action == null) return
  if (action.to === 0) return 'The batter must reach a base to be safe.'
  const bases = baseIds(state.session)
  if (action.returnPhase !== 'resolveBatter') {
    if (
      bases[action.to - 1] != null &&
      bases[action.to - 1] !== action.playerId
    )
      return 'That base is occupied. Move the lead runner first.'
    if (
      bases.some(
        (id, index) =>
          id != null &&
          id !== action.playerId &&
          index + 1 > action.from &&
          index + 1 < action.to
      )
    )
      return 'Move the lead runner first; runners cannot pass each other.'
  } else {
    const trailing = state.pendingPlay!.movements.filter(
      move =>
        move.playerId !== action.playerId &&
        move.decision !== 'out' &&
        move.from < action.from
    )
    if (trailing.some(move => move.to >= action.to && action.to < 4))
      return 'Choose a base ahead of the trailing runners.'
  }
}
function commitSafe(state: ScoringState): void {
  const action = state.runnerAction!
  const pending = state.pendingPlay
  const movement: Movement = {
    playerId: action.playerId,
    from: action.from,
    to: action.to,
    force: false,
    decision: 'safe',
    resolved: true
  }
  const choice =
    pending != null &&
    (pending.outcome === "Fielder's Choice" ||
      pending.outcome === 'Error' ||
      pending.outcome === 'Dropped Third Strike') &&
    action.returnPhase === 'resolveBatter'
  if (choice) {
    const old = pending.movements.find(
      move => move.playerId === action.playerId
    )!
    movement.force =
      action.to === action.from + 1 &&
      (action.from === 0 ||
        pending.originalBases.slice(0, action.from).every(id => id != null)) &&
      pending.movements.some(move => move.from === 0 && move.decision !== 'out')
    Object.assign(old, movement)
    let required = 0
    for (const other of [...pending.movements]
      .filter(move => move.decision !== 'out')
      .sort((a, b) => a.from - b.from)) {
      if (other.to < required) other.decision = 'pending'
      required = Math.min(4, Math.max(required, other.to) + 1)
    }
    if (
      pending.movements.some(move => move.to < 4 && move.decision === 'pending')
    ) {
      state.runnerAction = null
      state.phase = 'resolveBatter'
      return
    }
  } else {
    setBase(state, action.playerId, action.to)
    if (action.to === 4 && action.from !== 4)
      state.session.liveData.linescore.teams[battingSide(state.session)].runs++
    const old = pending?.movements.find(
      move => move.playerId === action.playerId
    )
    if (old != null) Object.assign(old, movement)
    else pending?.movements.push(movement)
    recordRunner(state, movement, action.reason ?? 'Advance')
    actionEvent(state, action.playerId, action.reason ?? 'Advance')
    runMotion(state, movement)
  }
  state.phase = 'runnerMovement'
  settleRunners(state)
}
export function runnerReducer(
  state: ScoringState,
  event: ScoringEvent
): ScoringState | undefined {
  if (event.type === 'ERROR_CANCEL')
    return state.phase === 'errorCredit'
      ? { ...state, phase: 'chooseDefender' }
      : state
  if (event.type === 'ERROR_CREDIT') {
    const route = state.runnerAction?.defensiveRoute ?? []
    if (
      state.phase !== 'errorCredit' ||
      state.pendingPlay?.errorPending !== true ||
      event.generation !== state.generation ||
      !route.some(hop => hop.id === event.id)
    )
      return state
    return accepted(
      state,
      `Error by ${state.session.gameData.players[event.id].fullName}`,
      next => {
        next.session.liveData.plays.currentPlay!.source.gamestation.errorCredit =
          {
            player: playerRef(next.session, event.id)!,
            defensiveRoute: route.map(hop => ({
              player: playerRef(next.session, hop.id)!,
              location: { ...hop.point }
            }))
          }
        next.session.liveData.linescore.teams[
          battingSide(next.session) === 'away' ? 'home' : 'away'
        ].errors++
        next.pendingPlay!.errorPending = false
        next.runnerAction = null
        next.phase = 'runnerMovement'
        settleRunners(next)
      }
    )
  }
  if (event.type === 'MOTION_DONE') {
    const command = state.motions.find(
      motion => motion.id === event.id && motion.generation === event.generation
    )
    if (
      event.generation !== state.generation ||
      command == null ||
      command.complete
    )
      return state
    const next = { ...snapshotOf(state), past: state.past }
    next.motions.find(motion => motion.id === event.id)!.complete = true
    if (command.purpose === 'approachFirst' && next.pendingPlay != null)
      next.pendingPlay.batterPoint = {
        ...command.waypoints[command.waypoints.length - 1]
      }
    settleRunners(next)
    return next
  }
  if (event.type === 'CANCEL_RUNNER') {
    if (
      state.runnerAction == null ||
      !['runnerDecision', 'runnerReason'].includes(state.phase)
    )
      return state
    return {
      ...state,
      phase: state.runnerAction.returnPhase,
      runnerAction: null
    }
  }
  if (event.type === 'RUNNER_PROPOSE') {
    if (
      ![
        'ready',
        'correctionWindow',
        'resolveBatter',
        'runnerDecision'
      ].includes(state.phase) ||
      state.motions.some(motion => !motion.complete) ||
      !Number.isInteger(event.to) ||
      event.to < 0 ||
      event.to > 4
    )
      return state
    const bases = baseIds(state.session)
    const from = bases.indexOf(event.id) + 1
    const batter = state.session.liveData.plays.currentPlay?.matchup.batter.id
    if (
      from === 0 &&
      !(
        (state.phase === 'resolveBatter' ||
          state.runnerAction?.returnPhase === 'resolveBatter') &&
        event.id === batter
      )
    )
      return state
    if (event.to < from) return state
    const action = {
      playerId: event.id,
      from,
      to: event.to,
      origin:
        state.pendingPlay == null ? ('between' as const) : ('current' as const),
      returnPhase: state.runnerAction?.returnPhase ?? state.phase
    }
    return { ...state, phase: 'runnerDecision', runnerAction: action }
  }
  if (event.type === 'RUNNER_DECIDE') {
    const action = state.runnerAction
    if (
      state.phase !== 'runnerDecision' ||
      action == null ||
      (event.decision === 'safe' && action.to === 0)
    )
      return state
    if (event.decision === 'safe' && runnerDecisionError(state) != null)
      return state
    return accepted(
      state,
      `${event.decision === 'safe' ? 'Safe' : 'Out'} ${state.session.gameData.players[action.playerId].fullName}`,
      next => {
        next.runnerAction!.decision = event.decision
        if (
          action.origin === 'between' &&
          !(event.decision === 'safe' && action.from === action.to)
        )
          next.phase = 'runnerReason'
        else if (event.decision === 'out') beginDefense(next)
        else {
          next.runnerAction!.reason =
            action.from === action.to ? 'Safe from Pickoff' : 'Advance'
          commitSafe(next)
        }
      }
    )
  }
  if (event.type === 'RUNNER_REASON') {
    if (
      state.phase !== 'runnerReason' ||
      !runnerReasons(state).includes(event.reason)
    )
      return state
    return accepted(state, event.reason, next => {
      next.runnerAction!.reason = event.reason
      if (next.runnerAction!.decision === 'out') beginDefense(next)
      else commitSafe(next)
    })
  }
  if (event.type === 'THROWER') {
    if (
      state.phase !== 'chooseThrower' ||
      event.generation !== state.generation ||
      !validDefender(state, event.id) ||
      !Number.isFinite(event.point.x) ||
      !Number.isFinite(event.point.z)
    )
      return state
    return accepted(
      state,
      `Thrower ${state.session.gameData.players[event.id].fullName}`,
      next => {
        next.runnerAction!.thrower = event.id
        next.runnerAction!.throwerPoint = { ...event.point }
        next.runnerAction!.defensiveRoute = [
          { id: event.id, point: { ...event.point } }
        ]
        next.phase = 'chooseDefender'
      }
    )
  }
  if (event.type === 'DEFENDER') {
    const action = state.runnerAction
    const holder = action?.defensiveRoute?.at(-1)?.id ?? action?.thrower
    const id = event.id ?? holder
    if (
      state.phase !== 'chooseDefender' ||
      state.presentation != null ||
      event.generation !== state.generation ||
      !validDefender(state, id) ||
      !validDefender(state, holder) ||
      (event.id != null && event.id === holder) ||
      (event.point != null &&
        (!Number.isFinite(event.point.x) || !Number.isFinite(event.point.z))) ||
      (event.runnerPoint != null &&
        (!Number.isFinite(event.runnerPoint.x) ||
          !Number.isFinite(event.runnerPoint.z)))
    )
      return state
    if (event.id == null && action?.purpose === 'errorAttribution')
      return accepted(state, 'Choose error fielder', next => {
        next.phase = 'errorCredit'
      })
    return accepted(
      state,
      event.id == null
        ? `Out by ${state.session.gameData.players[id].fullName}`
        : `Throw to ${state.session.gameData.players[id].fullName}`,
      next => {
        next.runnerAction!.runnerPoint =
          event.runnerPoint ?? next.runnerAction!.runnerPoint
        const sequence = throwPresentation(
          next,
          id,
          event.point,
          event.id == null
        )
        if (next.presentationEnabled === true) next.presentation = sequence
        else completeDefense(next, sequence)
      }
    )
  }
  if (event.type === 'HOME') {
    if (
      state.phase !== 'homeDecision' ||
      state.homeQueue.length === 0 ||
      state.session.liveData.linescore.outs >= 3
    )
      return state
    const id = state.homeQueue[0]
    const movement = state.pendingPlay!.movements.find(
      move => move.playerId === id
    )!
    if (event.decision === 'back') {
      const proposal = homeBackProposal(state)
      if (proposal == null) return state
      return accepted(
        state,
        `Back ${state.session.gameData.players[id].fullName}`,
        next => {
          const before = next.pendingPlay!.movements
          next.pendingPlay!.movements = proposal
          for (const key of baseKeys)
            next.session.liveData.linescore.offense[key] = null
          rebuildQueue(next)
          for (const move of proposal)
            if (move.decision !== 'out' && move.to < 4) {
              setBase(next, move.playerId, move.to)
              const old = before.find(item => item.playerId === move.playerId)!
              if (old.to !== move.to) {
                recordRunner(next, move, 'Back')
                enqueue(next, move.playerId, [
                  old.to === 4
                    ? homeQueuePoint(state.homeQueue.indexOf(move.playerId))
                    : BASES[old.to],
                  BASES[move.to]
                ])
              }
            }
          next.phase = 'runnerMovement'
          settleRunners(next)
        }
      )
    }
    return accepted(
      state,
      `${event.decision === 'safe' ? 'Safe' : 'Out'} at home ${state.session.gameData.players[id].fullName}`,
      next => {
        if (event.decision === 'out') {
          next.runnerAction = {
            playerId: id,
            from: movement.from,
            to: 4,
            origin: 'current',
            returnPhase: 'homeDecision',
            decision: 'out',
            reason: 'Out at home'
          }
          beginDefense(next)
          return
        }
        const move = next.pendingPlay!.movements.find(
          move => move.playerId === id
        )!
        move.decision = 'safe'
        move.resolved = true
        next.session.liveData.linescore.teams[battingSide(next.session)].runs++
        if (next.pendingPlay!.outcome !== 'Error')
          next.session.liveData.plays.currentPlay!.result.rbi++
        recordRunner(next, move, 'Safe at home')
        enqueue(next, id, [
          homeQueuePoint(0),
          BASES[0],
          { x: battingSide(next.session) === 'home' ? 32 : -32, z: 6 }
        ])
        next.homeQueue.shift()
        next.homeQueue.forEach((runner, index) => {
          enqueue(next, runner, [
            homeQueuePoint(index + 1),
            homeQueuePoint(index)
          ])
        })
        next.phase = 'runnerMovement'
        settleRunners(next)
      }
    )
  }
}
