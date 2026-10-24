import { DID_BY_TYPE } from '../describePlay'
import type { GumboEventType } from '../gumboEventTypes'
import type { ScoringAction } from '../scoring/actions'
import { applyAction } from '../scoring/apply'
import { positionOf } from '../scoring/credits'
import { ordinal } from '../scoring/lineup'
import { trajectoryOf } from '../scoring/rules'
import { copyGame, type GameState, type Side } from '../scoring/state'
import type { Transition } from '../scoring/transitions'
import { namesOf } from './replayNames'
import { isClose, type ReplayStep, type ReplayTimeline } from './replayTimeline'

/**
 * What the announcer says for one step of a replay, which is also what the
 * replay's card writes. It is made from the game before and after the step
 * and what the step did, never from anything the scorer typed, so the server
 * and the app write the same sentence. Players are named only as
 * `shortNames` writes them: a first name and the start of a last name.
 */

export interface Narration {
  text: string
  emphasis: 'calm' | 'excited'
}

export const MAX_NARRATION = 240

const WORDS = [
  'oh',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty'
]

/** A number as the announcer says it: `oh` for none in a count. */
export function spoken(n: number, zero = 'nothing'): string {
  if (n === 0) return zero
  return WORDS[n] ?? String(n)
}

const BASE_NAMES = ['home', 'first', 'second', 'third', 'home']

const FIELDERS: Record<string, string> = {
  P: 'the pitcher',
  C: 'the catcher',
  '1B': 'first',
  '2B': 'second',
  SS: 'short',
  '3B': 'third',
  LF: 'left',
  CF: 'center',
  RF: 'right'
}

const ROLES: Record<string, string> = {
  P: 'pitcher',
  C: 'catcher',
  '1B': 'first baseman',
  '2B': 'second baseman',
  SS: 'shortstop',
  '3B': 'third baseman',
  LF: 'left fielder',
  CF: 'center fielder',
  RF: 'right fielder'
}

const RUN_WORDS = ['', 'solo', 'two-run', 'three-run', 'grand slam']

/** Where a ball went, from home plate, by its spray angle. */
export function direction(location: { x: number; z: number }): string {
  const degrees = (Math.atan2(location.x, -location.z) * 180) / Math.PI
  if (degrees < -45) return 'foul down the left-field line'
  if (degrees > 45) return 'foul down the right-field line'
  if (degrees < -27) return 'left field'
  if (degrees < -9) return 'left-center'
  if (degrees <= 9) return 'center field'
  if (degrees <= 27) return 'right-center'
  return 'right field'
}

function teamSaying(state: GameState): string {
  const { away, home } = state.liveData.linescore.teams
  const names = state.gameData.teams
  if (away.runs === home.runs)
    return `That ties it at ${spoken(away.runs, 'nothing')}.`
  const [lead, trail] =
    away.runs > home.runs
      ? [names.away.name, home.runs]
      : [names.home.name, away.runs]
  return `${lead} lead ${spoken(Math.max(away.runs, home.runs))} to ${spoken(trail)}.`
}

function count(state: GameState): string {
  const { balls, strikes } = state.liveData.linescore
  return `${spoken(balls, 'oh')} and ${spoken(strikes, 'oh')}`
}

/**
 * The transitions of the step's own play. A pitch can first close the play
 * before it, when the scorer did not: that close and the batter change that
 * follows it are left out.
 */
function ownTransitions(transitions: readonly Transition[]): Transition[] {
  const pitched = transitions.findIndex(t => t.type === 'pitchThrown')
  return pitched < 0 ? [...transitions] : transitions.slice(pitched)
}

function eventTypeOf(
  actions: readonly ScoringAction[],
  transitions: readonly Transition[],
  before: GameState,
  after: GameState
): string | undefined {
  const closed = ownTransitions(transitions).find(
    (transition): transition is Extract<Transition, { type: 'playClosed' }> =>
      transition.type === 'playClosed'
  )
  if (closed != null) return closed.eventType
  const result = actions.find(action => action.type === 'result')
  if (result?.type === 'result') return result.eventType
  // A play the step decided that waits for the scorer's close, as ball four
  // does: the scoring screen saves the pitch before it closes the walk.
  if (before.pending == null && after.pending != null)
    return after.liveData.plays.currentPlay?.result.eventType
  return undefined
}

interface Said {
  parts: string[]
  excited: boolean
}

function pitchSentence(
  call: string,
  batter: string,
  before: GameState,
  after: GameState,
  type: string | undefined,
  out: boolean
): string {
  const strikes = before.liveData.linescore.strikes
  if (type === 'walk' || type === 'intent_walk')
    return `Ball four, ${batter} walks.`
  if (type === 'hit_by_pitch') return `${batter} is hit by the pitch.`
  if (out && call === 'C')
    return `Strike three called! ${batter} is out looking.`
  if (out && call === 'T')
    return `Foul tip, strike three! ${batter} strikes out.`
  if (out) return `Swing and a miss, strike three! ${batter} strikes out.`
  const now = count(after)
  switch (call) {
    case 'B':
      return `Ball ${spoken(after.liveData.linescore.balls)}, ${now}.`
    case 'C':
      return `Called strike ${spoken(after.liveData.linescore.strikes)}, ${now}.`
    case 'S':
      return `Swing and a miss, ${now}.`
    case 'T':
      return `Foul tip, ${now}.`
    case 'L':
      return `Bunted foul, ${now}.`
    default:
      return strikes === 2 ? `Fouled off, still ${now}.` : `Foul ball, ${now}.`
  }
}

/** `short to second to first`: the fielders who made a play's outs, in turn. */
function chainOf(actions: readonly ScoringAction[], before: GameState): string {
  const chain: number[] = []
  for (const action of actions)
    if (action.type === 'runnerMovement' && action.out === true)
      for (const fielder of action.fielders ?? [])
        if (chain.at(-1) !== fielder) chain.push(fielder)
  return chain
    .map(fielder => FIELDERS[positionOf(before, fielder)] ?? '')
    .filter(name => name !== '')
    .join(' to ')
}

function inPlaySentence(
  action: Extract<ScoringAction, { type: 'ballInPlay' }>,
  actions: readonly ScoringAction[],
  batter: string,
  before: GameState,
  type: string | undefined,
  transitions: readonly Transition[]
): Said {
  const where = action.location == null ? null : direction(action.location)
  const fielder =
    action.fielder == null ? '' : positionOf(before, action.fielder)
  const toFielder = fielder === '' ? '' : ` to ${FIELDERS[fielder] ?? fielder}`
  const angle = action.launchAngle
  const flight =
    angle == null ? (action.trajectory ?? 'ground_ball') : trajectoryOf(angle)
  const scored = transitions.filter(t => t.type === 'runScored').length
  if (type === 'home_run') {
    const kind =
      scored >= 4 ? 'A grand slam!' : `A ${RUN_WORDS[scored] ?? ''} home run.`
    return {
      parts:
        action.homeRunKind === 'in-park'
          ? [
              `${batter} drives it to ${where ?? 'the outfield'} and races around the bases, an inside-the-park home run!`,
              kind === 'A grand slam!' ? kind : ''
            ]
          : [
              `${batter} hits it deep to ${where ?? 'the outfield'}, that ball is gone!`,
              kind
            ],
      excited: true
    }
  }
  const hitTo = where == null ? toFielder : ` to ${where}`
  switch (type) {
    case 'single':
    case 'double':
    case 'triple': {
      const verb =
        flight === 'line_drive'
          ? `lines a ${type}`
          : flight === 'ground_ball' || flight === 'chopper'
            ? `grounds a ${type}`
            : (DID_BY_TYPE[type as GumboEventType] ?? `hits a ${type}`)
      return { parts: [`${batter} ${verb}${hitTo}.`], excited: scored > 0 }
    }
    case 'field_error':
      return {
        parts: [
          `${batter} reaches on an error${fielder === '' ? '' : ` by the ${ROLES[fielder] ?? fielder}`}.`
        ],
        excited: scored > 0
      }
    case 'sac_fly':
      return {
        parts: [`${batter} lifts a sacrifice fly${toFielder}.`],
        excited: true
      }
    case 'grounded_into_double_play':
    case 'double_play': {
      const relay = chainOf(actions, before)
      return {
        parts: [
          type === 'grounded_into_double_play'
            ? `${batter} grounds into a double play${relay === '' ? toFielder : `, ${relay}`}!`
            : `${batter} lines into a double play${toFielder}!`
        ],
        excited: false
      }
    }
    case 'fielders_choice':
    case 'fielders_choice_out':
    case 'force_out':
      return {
        parts: [`${batter} reaches on a fielder's choice${toFielder}.`],
        excited: scored > 0
      }
    default: {
      const out = transitions.some(
        t => t.type === 'outRecorded' && t.from === 0
      )
      if (!out && type == null)
        return {
          parts: [`${batter} puts it in play${hitTo}.`],
          excited: false
        }
      const caught =
        flight === 'popup'
          ? 'pops out'
          : flight === 'fly_ball'
            ? 'flies out'
            : flight === 'line_drive'
              ? 'lines out'
              : 'grounds out'
      return { parts: [`${batter} ${caught}${toFielder}.`], excited: false }
    }
  }
}

/** Steals, pickoffs and the like the scorer took between pitches. */
function runnerSentence(
  action: ScoringAction,
  names: Map<number, string>
): string | null {
  if (action.type === 'baseRunning') {
    const runner = names.get(action.runner) ?? 'The runner'
    const to = action.to == null ? '' : BASE_NAMES[destination(action.to)]
    switch (action.kind) {
      case 'steal':
        return `${runner} steals ${to}!`
      case 'caught_stealing':
        return `${runner} is caught stealing.`
      case 'pickoff':
        return `${runner} is picked off.`
      case 'defensive_indifference':
        return `${runner} takes ${to} on defensive indifference.`
      default:
        return null
    }
  }
  if (action.type === 'batteryEvent') {
    const what =
      action.kind === 'wild_pitch'
        ? 'Wild pitch'
        : action.kind === 'passed_ball'
          ? 'Passed ball'
          : 'Balk'
    const moves = (action.advances ?? []).map(
      advance =>
        `${names.get(advance.runner) ?? 'the runner'} moves up to ${BASE_NAMES[destination(advance.to)]}`
    )
    return moves.length === 0 ? `${what}.` : `${what}, ${moves.join(', ')}.`
  }
  return null
}

function destination(to: string): number {
  return to === 'batter' ? 0 : to === 'home' ? 4 : Number(to[0])
}

function sideOf(state: GameState, id: number): Side {
  return state.gameData.players[id]?.teamId === state.gameData.teams.home.id
    ? 'home'
    : 'away'
}

function lineupSentence(
  action: Extract<ScoringAction, { type: 'lineup' }>,
  before: GameState,
  names: Map<number, string>
): string | null {
  const player = action.player == null ? null : names.get(action.player)
  if (player == null) return null
  const team =
    before.gameData.teams[action.side ?? sideOf(before, action.player!)]
  if (action.kind === 'position')
    return `${player} moves to ${positionName(action.position)}.`
  if (action.kind === 'pinchRunner') {
    const offense = before.liveData.linescore.offense
    const onBase =
      action.base === '1B'
        ? offense.first
        : action.base === '2B'
          ? offense.second
          : action.base === '3B'
            ? offense.third
            : null
    const runner = names.get(action.replaces ?? onBase?.id ?? -1)
    return `${player} comes in to run for ${runner ?? 'the runner'}.`
  }
  if (action.kind !== 'substitute') return null
  if (action.position === 'P')
    return `Now pitching for the ${team.name}, ${player}.`
  const replaced = names.get(action.replaces ?? -1)
  const batting =
    before.liveData.linescore.isTopInning ===
    (team.id === before.gameData.teams.away.id)
  if (batting && replaced != null)
    return `${player} pinch-hits for ${replaced}.`
  return replaced == null
    ? `${player} comes into the game.`
    : `${player} comes in for ${replaced}.`
}

function positionName(position: string | undefined): string {
  const field: Record<string, string> = {
    LF: 'left field',
    CF: 'center field',
    RF: 'right field',
    '1B': 'first base',
    '2B': 'second base',
    '3B': 'third base',
    SS: 'shortstop',
    C: 'catcher',
    P: 'pitcher'
  }
  return position == null ? 'a new position' : (field[position] ?? position)
}

function halfSentence(
  transition: Extract<Transition, { type: 'halfEnded' }>,
  after: GameState
): string {
  const { away, home } = after.liveData.linescore.teams
  const names = after.gameData.teams
  const when =
    transition.half === 'top'
      ? `Middle of the ${ordinal(transition.inning)}`
      : `End of the ${ordinal(transition.inning)}`
  return `That's three outs. ${when}: ${names.away.name} ${spoken(away.runs, 'nothing')}, ${names.home.name} ${spoken(home.runs, 'nothing')}.`
}

function endSentence(after: GameState): string {
  const { away, home } = after.liveData.linescore.teams
  const names = after.gameData.teams
  if (away.runs === home.runs)
    return `That's the ballgame, tied at ${spoken(away.runs)}.`
  const [winner, high, low] =
    away.runs > home.runs
      ? [names.away.name, away.runs, home.runs]
      : [names.home.name, home.runs, away.runs]
  return `That's the ballgame! ${winner} win, ${spoken(high)} to ${spoken(low)}.`
}

/** Fits the sentences to `MAX_NARRATION`, dropping whole ones from the end. */
export function fit(parts: string[]): string {
  let text = ''
  for (const part of parts.filter(part => part !== '')) {
    const next = text === '' ? part : `${text} ${part}`
    if (next.length > MAX_NARRATION) break
    text = next
  }
  return text === '' ? parts.join(' ').slice(0, MAX_NARRATION) : text
}

export function narrateStep(
  before: GameState,
  step: Pick<ReplayStep, 'actions'>,
  after: GameState,
  transitions: readonly Transition[],
  names: Map<number, string> = namesOf(after)
): Narration {
  const said: Said = { parts: [], excited: false }
  const pitched = transitions.findIndex(t => t.type === 'pitchThrown')
  const changed = transitions
    .slice(0, pitched < 0 ? 0 : pitched)
    .filter(
      (t): t is Extract<Transition, { type: 'batterChanged' }> =>
        t.type === 'batterChanged'
    )
    .at(-1)
  const batterId =
    changed != null
      ? (changed.batter ?? undefined)
      : before.liveData.linescore.offense.batter?.id
  const batter =
    (batterId == null ? undefined : names.get(batterId)) ?? 'The batter'
  const type = eventTypeOf(step.actions, transitions, before, after)
  const current = before.liveData.plays.currentPlay
  const pitchedTo = current?.playEvents.some(event => event.isPitch) === true
  const firstPitch = changed != null || !pitchedTo
  for (const action of step.actions) {
    if (action.type === 'lineup') {
      const line = lineupSentence(action, before, names)
      if (line != null) said.parts.push(line)
    }
  }
  const delivery = step.actions.find(
    action => action.type === 'pitch' || action.type === 'ballInPlay'
  )
  if (delivery?.type === 'pitch' && firstPitch)
    said.parts.push(`${batter} steps in.`)
  if (delivery?.type === 'pitch') {
    const out = transitions.some(
      t => t.type === 'outRecorded' && t.runner === batterId && t.from === 0
    )
    said.parts.push(
      pitchSentence(delivery.call, batter, before, after, type, out)
    )
  } else if (delivery?.type === 'ballInPlay') {
    // A ball in play said more of later in the step: where it went.
    const ball = step.actions.findLast(action => action.type === 'ballInPlay')
    const play = inPlaySentence(
      ball?.type === 'ballInPlay' ? ball : delivery,
      step.actions,
      batter,
      before,
      type,
      transitions
    )
    said.parts.push(...play.parts)
    said.excited ||= play.excited
  }
  // Without a delivery, a close the step made is of an earlier play: only
  // the step's own result is told.
  const result = step.actions.find(action => action.type === 'result')
  if (delivery == null && result?.type === 'result') {
    const did = DID_BY_TYPE[result.eventType as GumboEventType]
    if (did != null) said.parts.push(`${batter} ${did}.`)
  }
  for (const action of step.actions) {
    const line = runnerSentence(action, names)
    if (line != null) said.parts.push(line)
  }
  const scorers = transitions
    .filter(
      (t): t is Extract<Transition, { type: 'runScored' }> =>
        t.type === 'runScored'
    )
    .map(t => t.runner)
    .filter(runner => !(type === 'home_run' && runner === batterId))
  if (scorers.length > 0)
    said.parts.push(
      scorersSentence(scorers.map(runner => names.get(runner) ?? null))
    )
  if (transitions.some(t => t.type === 'runScored')) {
    said.excited = true
    said.parts.push(teamSaying(after))
  }
  for (const transition of transitions)
    if (transition.type === 'halfEnded' && !after.final)
      said.parts.push(halfSentence(transition, after))
  if (
    transitions.some(t => t.type === 'gameEnded') ||
    (after.final && !before.final)
  ) {
    said.excited = true
    said.parts.push(endSentence(after))
  }
  if (said.parts.length === 0 && step.actions.some(isClose)) {
    // Only the scorer's close of a play the step before already described.
    return { text: '', emphasis: 'calm' }
  }
  return {
    text: fit(said.parts),
    emphasis: said.excited ? 'excited' : 'calm'
  }
}

/**
 * A timeline's steps, each with the game before and after it and what it
 * did: from its first step, or from step `from` with the game `start`.
 */
export function* stepsWithStates(
  timeline: ReplayTimeline,
  from = 0,
  start: GameState = timeline.start
): Generator<{
  step: ReplayStep
  before: GameState
  after: GameState
  transitions: Transition[]
}> {
  let state = start
  for (const step of timeline.steps.slice(from)) {
    const before = state
    const transitions: Transition[] = []
    for (const action of step.actions) {
      // `copyGame` shares the finished plays, as `replayPlays` does: a copy of
      // the whole game per action makes narrating a long game quadratic.
      const applied = applyAction(copyGame(state), action, {
        inPlace: true,
        replay: true
      })
      if (applied.problems.length > 0) break
      transitions.push(...applied.transitions)
      state = applied.state
    }
    yield { step, before, after: state, transitions }
  }
}

/**
 * The game before each of a narrated timeline's last two steps: a longer copy
 * of the game is narrated on from there, since its last step may have grown
 * and the one before it is called by what follows it.
 */
const tails = new WeakMap<
  ReplayTimeline,
  Array<{ index: number; before: GameState }>
>()

/**
 * Where a longer copy of a game can be narrated on from: the earlier of the
 * last two steps `previous` was narrated to, when every step before it is
 * the same step, holding the same actions, and every player has the same
 * name. Nothing when it must be narrated from the first pitch.
 */
function resumeFrom(
  previous: ReplayTimeline,
  timeline: ReplayTimeline,
  names: Map<number, string>
): { index: number; before: GameState } | undefined {
  const tail = tails.get(previous)?.[0]
  if (tail == null || timeline.steps.length < previous.steps.length) return
  for (let i = 0; i < tail.index; i++) {
    const was = previous.steps[i]
    const now = timeline.steps[i]
    if (was.key !== now.key || was.actions.length !== now.actions.length) return
  }
  const named = namesOf(previous.end)
  if (named.size !== names.size) return
  for (const [id, name] of names) if (named.get(id) !== name) return
  return tail
}

/**
 * The runners who crossed the plate on one play, in one sentence and in the
 * order they scored: "Player 1 scores!", "Player 1 and Player 2 score!", "Player 1,
 * Player 2 and Player 3 all score!". A runner without a name is "a runner";
 * with no runners there is nothing to say.
 */
export function scorersSentence(names: ReadonlyArray<string | null>): string {
  if (names.length === 0) return ''
  const named = names.map(name => name ?? 'a runner')
  const listed =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  const said = listed.charAt(0).toUpperCase() + listed.slice(1)
  if (named.length === 1) return `${said} scores!`
  return named.length === 2 ? `${said} score!` : `${said} all score!`
}

/**
 * Every step's narration, by key. Given the narration of an earlier copy of
 * the same game, the sentences up to its last two steps are kept and only
 * the rest is narrated, so a live view's work per change does not grow with
 * the game.
 */
export function narrateTimeline(
  timeline: ReplayTimeline,
  previous?: { timeline: ReplayTimeline; narrations: Map<string, Narration> }
): Map<string, Narration> {
  const names = namesOf(timeline.end)
  const resume =
    previous == null
      ? undefined
      : resumeFrom(previous.timeline, timeline, names)
  const from = resume?.index ?? 0
  const narrations = new Map<string, Narration>()
  for (const step of timeline.steps.slice(0, from)) {
    const kept = previous?.narrations.get(step.key)
    if (kept != null) narrations.set(step.key, kept)
  }
  const steps = [
    ...stepsWithStates(timeline, from, resume?.before ?? timeline.start)
  ]
  tails.set(
    timeline,
    steps.slice(-2).map(({ before }, i) => ({
      index: from + Math.max(0, steps.length - 2) + i,
      before
    }))
  )
  steps.forEach(({ step, before, after, transitions }, i) => {
    const next = steps[i + 1]
    const said = narrateStep(before, step, after, transitions, names)
    // The out that ends the game is called with excitement and without the
    // half's summary; the end of the game, the step after it, has the final
    // word. A live view that read the out before the end arrived still hears
    // that word when it does.
    if (
      next != null &&
      endsOnly(next.step) &&
      next.after.final &&
      !next.before.final &&
      transitions.some(t => t.type === 'halfEnded')
    ) {
      narrations.set(step.key, {
        text: narrateStep(
          before,
          step,
          after,
          transitions.filter(t => t.type !== 'halfEnded'),
          names
        ).text,
        emphasis: 'excited'
      })
      return
    }
    narrations.set(step.key, said)
  })
  return narrations
}

/** A step that only ends the game, with no play of its own. */
function endsOnly(step: ReplayStep): boolean {
  return step.actions.every(
    action =>
      action.type === 'gameFlow' &&
      (action.kind === 'endGame' || action.kind === 'closePlay')
  )
}
