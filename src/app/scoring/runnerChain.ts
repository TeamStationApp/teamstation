import type { RunnerMovementAction } from '../../common/scoring/actions'
import { runnerDecisionError as gameRunnerError } from '../../common/scoring/rules'
import { BASES } from '../field/fieldModel'
import { act } from './scoringFlow'
import { baseIds } from './scoringSelectors'
import type {
  ScoringPhase,
  ScoringSessionState,
  ScoringSnapshot,
  ScoringState
} from './scoringTypes'

/**
 * Runners who move together: a runner dragged one base toward a base another
 * runner holds pushes him on toward the next, and so on down the chain of
 * occupied bases. Each pushed runner then answers Safe, Out or Back, and the
 * whole chain is applied to the game at once, lead runner first, when the last
 * of them has answered.
 */
export interface ChainRunner {
  playerId: number
  /** 1..3 (or the base a ground advance left). */
  from: number
  /** from + 1; 4 is home. */
  to: number
  decision?: 'safe' | 'out' | 'back'
  /** The movement this answer comes to, applied when the chain commits. */
  action?: RunnerMovementAction
}
export interface RunnerChain {
  /** The runner whose drag pushed the others; absent for a ground double play. */
  dragged?: ChainRunner
  /** Lead runner last: the order the chain was pushed in. */
  pushed: ChainRunner[]
}

/** The steps a drag may open a chain from: between pitches, or a decided play. */
const CHAIN_PHASES: readonly ScoringPhase[] = ['ready', 'correctionWindow']

/** Whether a forward drag in this state pushes the runners in the way. */
export function chainAllowed(
  state: Pick<ScoringSnapshot, 'phase' | 'runnerChain' | 'runnerDraft'>
): boolean {
  return (
    CHAIN_PHASES.includes(state.phase) &&
    state.runnerChain == null &&
    state.runnerDraft == null
  )
}

/**
 * The runners a one-base drag from `from` pushes: each runner on the
 * consecutive occupied bases from `from + 1` upward, nearest first.
 */
export function chainAhead(
  session: ScoringSessionState,
  from: number
): ChainRunner[] {
  const bases = baseIds(session)
  const pushed: ChainRunner[] = []
  if (from < 1) return pushed
  for (let base = from + 1; base <= 3; base++) {
    const id = bases[base - 1]
    if (id == null) break
    pushed.push({ playerId: id, from: base, to: base + 1 })
  }
  return pushed
}

/** Every runner of the chain, the dragged runner first and the lead last. */
export function chainRunners(chain: RunnerChain): ChainRunner[] {
  return [...(chain.dragged == null ? [] : [chain.dragged]), ...chain.pushed]
}

/** The game as the runners of `cleared` would leave it: off their bases. */
function withoutRunners(
  session: ScoringSessionState,
  cleared: readonly number[]
): ScoringSessionState {
  const offense = session.liveData.linescore.offense
  const keep = <T extends { id: number } | null>(ref: T): T | null =>
    ref != null && cleared.includes(ref.id) ? null : ref
  return {
    ...session,
    liveData: {
      ...session.liveData,
      linescore: {
        ...session.liveData.linescore,
        offense: {
          ...offense,
          first: keep(offense.first),
          second: keep(offense.second),
          third: keep(offense.third)
        }
      }
    }
  }
}

/**
 * Why `playerId` may not be safe at `to`, answered as if every runner the
 * chain pushes had moved on. With a chain open, the runners in it who have
 * not gone Back are off their bases; for a drag that would open one, the
 * runners it pushes are. Anything else is the library's own answer.
 */
export function chainDropError(
  state: Pick<
    ScoringSnapshot,
    'phase' | 'runnerChain' | 'runnerDraft' | 'session' | 'pendingPlay'
  >,
  playerId: number,
  to: number
): string | undefined {
  const session = state.session
  const from = baseIds(session).indexOf(playerId) + 1
  const move = { playerId, from, to }
  const chain = state.runnerChain
  if (chain != null) {
    const runners = chainRunners(chain)
    if (!runners.some(runner => runner.playerId === playerId))
      return gameRunnerError(session, move)
    const cleared = runners
      .filter(
        runner => runner.playerId !== playerId && runner.decision !== 'back'
      )
      .map(runner => runner.playerId)
    return gameRunnerError(withoutRunners(session, cleared), move)
  }
  const pushed =
    chainAllowed(state) && from > 0 && to === from + 1
      ? chainAhead(session, from)
      : []
  return gameRunnerError(
    withoutRunners(
      session,
      pushed.map(runner => runner.playerId)
    ),
    move
  )
}

/**
 * Why the pushed runner `playerId` may not go back to the base he left. The
 * runner behind him is the runner of this play headed to that base: with
 * nobody headed there he may go back at once; otherwise only once that
 * runner is out, so no two runners share a base.
 */
export function chainBackError(
  state: Pick<ScoringSnapshot, 'runnerChain'>,
  playerId: number
): string | undefined {
  const chain = state.runnerChain
  const runner = chain?.pushed.find(item => item.playerId === playerId)
  if (chain == null || runner == null) return 'Runner unavailable'
  const behind = chainRunners(chain).find(
    item => item !== runner && item.to === runner.from
  )
  if (behind == null || behind.decision === 'out') return undefined
  return 'He can go back only once the runner behind him is out.'
}

/** The chain's runner `playerId`, when a chain is open and he is in it. */
export function chainRunner(
  state: Pick<ScoringSnapshot, 'runnerChain'>,
  playerId: number
): ChainRunner | undefined {
  const chain = state.runnerChain
  if (chain == null) return undefined
  return chainRunners(chain).find(runner => runner.playerId === playerId)
}

/**
 * Stores the movement a chain runner's answer comes to, instead of applying
 * it: the chain applies them all at once. False when the runner the screen
 * is deciding is not in an open chain, and the caller acts it as usual.
 */
export function deferToChain(
  state: ScoringSnapshot,
  decision: 'safe' | 'out',
  action: RunnerMovementAction
): boolean {
  const playerId = state.runnerAction?.playerId
  const runner = playerId == null ? undefined : chainRunner(state, playerId)
  if (runner == null) return false
  runner.decision = decision
  runner.action = action
  return true
}

/** The outs once the chain's answered Outs are counted. */
function chainOuts(state: ScoringSnapshot, chain: RunnerChain): number {
  return (
    state.session.liveData.linescore.outs +
    chainRunners(chain).filter(runner => runner.decision === 'out').length
  )
}

/**
 * Whether the chain is answered: every runner has answered, or the Outs
 * answered so far make the third out, which ends it with the rest unasked.
 */
export function chainAnswered(
  state: ScoringSnapshot,
  chain: RunnerChain
): boolean {
  return (
    (chain.dragged == null || chain.dragged.decision != null) &&
    (chain.pushed.every(runner => runner.decision != null) ||
      chainOuts(state, chain) >= 3)
  )
}

/**
 * Applies every stored movement of the chain, lead runner first, so each
 * Safe lands on a base already left, and stops at the third out as the
 * library stops a relay. Runners who did not answer stay on their bases.
 */
export function commitChain(state: ScoringState): void {
  const chain = state.runnerChain
  if (chain == null) return
  delete state.runnerChain
  const moves = chainRunners(chain)
    .filter(runner => runner.action != null)
    .sort((a, b) => b.from - a.from)
  for (const runner of moves) {
    if (state.session.liveData.linescore.outs >= 3) break
    act(state, runner.action!)
  }
  // A runner drawn at the base he was pushed to runs on from there.
  for (const motion of state.motions) {
    if (motion.complete) continue
    const runner = moves.find(
      item => item.playerId === motion.playerId && item.decision === 'safe'
    )
    if (runner != null && runner !== chain.dragged)
      motion.waypoints[0] = { ...BASES[runner.to % 4] }
  }
}
