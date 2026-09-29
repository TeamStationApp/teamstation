import type { Destination, ScoringAction } from '../../common/scoring/actions'
import { RUNNER_REASONS } from '../../common/scoring/actions'
import { type Decision, nextDecision } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { type GameState, POSITIONS } from '../../common/scoring/state'
import type { DictationQuestion } from './scoringTypes'

/**
 * A dictated sentence never leaves the scorer an on-screen step.
 *
 * A tapped play can stop to ask the scorer something only the screen can be
 * told — who put the batter out, where the batter went, who made the error,
 * whether the runner sent home was safe. A sentence that leaves the play
 * waiting like that is finished here: by rule where the answer is clear, and
 * by a question for the dictation control where it is not. Nothing is credited
 * that was not said.
 */

const WAITS: readonly Decision[] = [
  'batterOut',
  'resolveBatter',
  'errorAttribution',
  'homeDecision'
]
const BASE_NAMES: Record<number, Destination> = {
  0: 'batter',
  1: '1B',
  2: '2B',
  3: '3B',
  4: 'home'
}
const SPOKEN: Record<Destination, string> = {
  batter: 'the plate',
  '1B': 'first',
  '2B': 'second',
  '3B': 'third',
  home: 'home'
}

type Question = Omit<DictationQuestion, 'transcript'>
type Step = ScoringAction[] | { ask: Question }

function nameOf(state: GameState, id: number): string {
  return state.gameData.players[id]?.fullName ?? `Player ${id}`
}

function batterOf(state: GameState): number {
  return state.liveData.plays.currentPlay!.matchup.batter.id
}

function out(runner: number, to: Destination, reason?: string): ScoringAction {
  const known = (RUNNER_REASONS as readonly string[]).includes(reason ?? '')
  return {
    type: 'runnerMovement',
    runner,
    to,
    out: true,
    ...(known ? { reason: reason as (typeof RUNNER_REASONS)[number] } : {})
  }
}

function safe(runner: number, to: Destination): ScoringAction {
  return { type: 'runnerMovement', runner, to }
}

/**
 * The batter safe at first, and every runner he forces who was not put out
 * moved up a base ahead of him, lead runner first.
 */
function batterSafe(
  state: GameState,
  outs: ReadonlySet<number>
): ScoringAction[] {
  const bases = state.pending!.originalBases
  const moves: ScoringAction[] = []
  for (let index = bases.length - 1; index >= 0; index--) {
    const id = bases[index]
    const forced = bases.slice(0, index).every(behind => behind != null)
    if (id != null && forced && !outs.has(id))
      moves.push(safe(id, BASE_NAMES[index + 2]))
  }
  return [...moves, safe(batterOf(state), '1B')]
}

/** What the play is waiting on, answered: actions, a question, or nothing. */
function decide(
  state: GameState,
  decision: Decision,
  sentence: readonly ScoringAction[]
): Step | null {
  const pending = state.pending
  if (!WAITS.includes(decision) || pending == null) return null
  const batter = batterOf(state)
  switch (decision) {
    case 'batterOut':
      // Nobody said who put him out, so nobody is credited.
      return [
        pending.outcome === 'Batter Out — Other'
          ? out(batter, 'batter', 'Batter Out — Other')
          : out(batter, '1B', pending.outcome)
      ]
    case 'resolveBatter': {
      if (pending.outcome === "Fielder's Choice") {
        const outs = new Set(
          pending.movements
            .filter(move => move.playerId !== batter && move.decision === 'out')
            .map(move => move.playerId)
        )
        // A fielder's choice always has a runner on: the library refuses one
        // without.
        const runners = pending.originalBases.flatMap((id, index) =>
          id == null ? [] : [{ id, next: BASE_NAMES[index + 2] }]
        )
        if (outs.size > 0) return batterSafe(state, outs)
        if (runners.length === 1)
          return [
            out(runners[0].id, runners[0].next),
            ...batterSafe(state, new Set([runners[0].id]))
          ]
        return {
          ask: {
            question: "Which runners were out on the fielder's choice?",
            pick: {
              choices: runners.map(runner => ({
                label: `${nameOf(state, runner.id)} out at ${SPOKEN[runner.next]}`,
                actions: [out(runner.id, runner.next)]
              })),
              before: [],
              none: batterSafe(state, new Set())
            }
          }
        }
      }
      if (pending.outcome === 'Dropped Third Strike')
        return {
          ask: {
            question: `Did ${nameOf(state, batter)} reach first on the dropped third strike?`,
            options: [
              { label: 'Safe at first', actions: [safe(batter, '1B')] },
              { label: 'Out at first', actions: [out(batter, '1B')] }
            ]
          }
        }
      // Anyone else still waiting is safe where the play left him.
      return pending.movements
        .filter(move => move.decision === 'pending' && move.to < 4)
        .map(move => safe(move.playerId, BASE_NAMES[Math.max(1, move.to)]))
    }
    case 'errorAttribution': {
      const named = [...sentence]
        .reverse()
        .find(action => action.type === 'ballInPlay' && action.fielder != null)
      const fielder = named?.type === 'ballInPlay' ? named.fielder : undefined
      if (fielder != null)
        return [{ type: 'fieldingPlay', fielders: [fielder], error: fielder }]
      const defense = state.liveData.linescore.defense
      return {
        ask: {
          question: 'Who made the error?',
          options: POSITIONS.flatMap(position => {
            const ref = defense[position]
            return ref == null
              ? []
              : [
                  {
                    label: `${position} ${nameOf(state, ref.id)}`,
                    actions: [
                      {
                        type: 'fieldingPlay' as const,
                        fielders: [ref.id],
                        error: ref.id
                      }
                    ]
                  }
                ]
          })
        }
      }
    }
    default:
      // A runner the sentence did not put out at home scored.
      return [safe(state.homeQueue[0], 'home')]
  }
}

/**
 * The sentence with whatever it leaves the play waiting on, finished — or the
 * question that finishes it, each answer carrying the whole list of actions it
 * comes to. The sentence must already apply.
 */
const BASE_INDEX: Partial<Record<Destination, number>> = {
  '2B': 2,
  '3B': 3,
  home: 4
}

/**
 * A steal names the base taken, and with it the runner on the base before
 * it. A steal sent for a runner who could not take that base — not on the
 * base before it, with another runner there — is that other runner's, when
 * nothing else in the sentence moves him.
 */
export function stealsByBase(
  game: GameState,
  said: readonly ScoringAction[]
): ScoringAction[] {
  const moving = new Set(
    said.flatMap(action =>
      (action.type === 'baseRunning' || action.type === 'runnerMovement') &&
      action.runner != null
        ? [action.runner]
        : []
    )
  )
  const fixed: ScoringAction[] = []
  let state = game
  for (const action of said) {
    let next = action
    const target =
      action.type === 'baseRunning' &&
      action.kind === 'steal' &&
      action.to != null
        ? BASE_INDEX[action.to]
        : undefined
    if (target != null && action.type === 'baseRunning') {
      const offense = state.liveData.linescore.offense
      const bases = [offense.first?.id, offense.second?.id, offense.third?.id]
      const holder = bases[target - 2]
      const from = bases.indexOf(action.runner) + 1
      if (
        holder != null &&
        holder !== action.runner &&
        from !== target - 1 &&
        !moving.has(holder)
      )
        next = { ...action, runner: holder }
    }
    fixed.push(next)
    state = applyAction(state, next).state
  }
  return fixed
}

/**
 * Runners who move together — a double steal, runners said one by one moving
 * up between pitches — in the order the game takes them: the lead runner
 * first, whatever order they were said in. Everything else keeps its place.
 */
export function leadRunnersFirst(
  game: GameState,
  said: readonly ScoringAction[]
): ScoringAction[] {
  const together = (state: GameState, action: ScoringAction): boolean =>
    action.type === 'baseRunning' ||
    (action.type === 'runnerMovement' && state.pending == null)
  const base = (state: GameState, runner: number): number => {
    const offense = state.liveData.linescore.offense
    return [offense.first, offense.second, offense.third].findIndex(
      ref => ref?.id === runner
    )
  }
  const ordered: ScoringAction[] = []
  let state = game
  for (let index = 0; index < said.length;) {
    let end = index
    while (end < said.length && together(state, said[end])) end++
    const run =
      end === index
        ? [said[index]]
        : said.slice(index, end).sort((a, b) => {
            const lead = (action: ScoringAction): number =>
              'runner' in action && action.runner != null
                ? base(state, action.runner)
                : -1
            return lead(b) - lead(a)
          })
    for (const action of run) {
      ordered.push(action)
      state = applyAction(state, action).state
    }
    index = Math.max(end, index + 1)
  }
  return ordered
}

export function completeSentence(
  game: GameState,
  sentence: readonly ScoringAction[]
): { actions: ScoringAction[] } | { question: Question } {
  let state = game
  for (const action of sentence) state = applyAction(state, action).state
  const actions = [...sentence]
  for (let step = 0; step < 12; step++) {
    const answer = decide(state, nextDecision(state), sentence)
    if (answer == null) return { actions }
    if (!Array.isArray(answer)) {
      const { ask } = answer
      return {
        question: {
          question: ask.question,
          ...(ask.options == null
            ? {}
            : {
                options: ask.options.map(option => ({
                  label: option.label,
                  actions: [...actions, ...option.actions]
                }))
              }),
          ...(ask.pick == null
            ? {}
            : {
                pick: { ...ask.pick, before: [...actions, ...ask.pick.before] }
              })
        }
      }
    }
    for (const action of answer) {
      const applied = applyAction(state, action)
      // The rules would not take it: leave the rest to the screen.
      if (applied.problems.length > 0) return { actions }
      state = applied.state
      actions.push(action)
    }
  }
  return { actions }
}

/** The whole sentence a question's answer comes to. */
export function answerOf(
  question: DictationQuestion,
  answer: { option?: number; picks?: readonly number[] }
): ScoringAction[] | undefined {
  if (question.options != null)
    return answer.option == null
      ? undefined
      : question.options[answer.option]?.actions
  const pick = question.pick
  if (pick == null || answer.picks == null) return undefined
  const picks = [...new Set(answer.picks)]
    .filter(index => index >= 0 && index < pick.choices.length)
    .sort((a, b) => a - b)
  // The picked outs join the sentence, and the rules finish it from there.
  return picks.length === 0
    ? [...pick.before, ...pick.none]
    : [...pick.before, ...picks.flatMap(index => pick.choices[index].actions)]
}
