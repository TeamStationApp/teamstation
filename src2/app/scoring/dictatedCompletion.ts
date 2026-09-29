import type {
  BallInPlayAction,
  Destination,
  Direction,
  ResultAction,
  ScoringAction
} from '../../common/scoring/actions'
import { destinationBase, RUNNER_REASONS } from '../../common/scoring/actions'
import { type Decision, nextDecision } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { type GameState, POSITIONS } from '../../common/scoring/state'
import { directionPoint, foulFielder, foulPoint } from './dictatedGeometry'
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
/** The fielder who takes a throw at a base, where only one does. */
const COVERS: Partial<Record<Destination, 'C' | '3B' | '1B'>> = {
  home: 'C',
  '3B': '3B',
  '1B': '1B'
}
/** Results a ball in play comes to. */
const BATTED: ReadonlySet<string> = new Set([
  'single',
  'double',
  'triple',
  'home_run',
  'field_out',
  'field_error',
  'fielders_choice'
])
const HITS: ReadonlySet<string> = new Set([
  'single',
  'double',
  'triple',
  'home_run'
])
/** Who catches a ball sent a direction: the gaps are the center fielder's. */
const OUTFIELDER: Record<Direction, 'LF' | 'CF' | 'RF'> = {
  left: 'LF',
  left_center: 'CF',
  center: 'CF',
  right_center: 'CF',
  right: 'RF'
}

/**
 * Each fielder as the words name him, and the base an infielder is named by
 * when a ball is hit to him ("pops out to second").
 */
const FIELDER_NOUNS: ReadonlyArray<
  [string, (typeof POSITIONS)[number], string?]
> = [
  ['catcher', 'C'],
  ['pitcher', 'P'],
  ['first baseman', '1B', 'first'],
  ['second baseman', '2B', 'second'],
  ['shortstop|short(?! (?:left|right|center))', 'SS'],
  ['third baseman', '3B', 'third'],
  ['left fielder', 'LF'],
  ['center fielder', 'CF'],
  ['right fielder', 'RF']
]
const CATCHES =
  'makes (?:the|an?)(?: \\w+){0,2} catch|catch(?:es)? (?:it|the ball)|caught it|hauls it in|reels it in|grabs it|snags it|gloves it|squeezes it'
const HIT_TO =
  '(?:pops?|popped|flies|flied|lines|lined|fouls?|fouled|line drive|liner|pop ?up|pop fly|fly ball)'
/**
 * The fielders the words say outright made a catch — "the shortstop makes
 * the catch", "the second baseman grabs it", "caught by the catcher",
 * "fouled out to the catcher", "pops up to short", "lines out to third",
 * "line drive to short, caught" —
 * as against a fielder named some other way, as a thrower, or a base a
 * runner went to ("tags up to third").
 */
function catchersSaid(game: GameState, transcript: string): number[] {
  const defense = game.liveData.linescore.defense
  return FIELDER_NOUNS.flatMap(([noun, position, base]) => {
    const said = new RegExp(
      [
        `\\b(?:${noun})\\b[^.,;]{0,20}?\\b(?:${CATCHES})\\b`,
        `\\bcaught by (?:the )?(?:${noun})\\b`,
        `\\b(?:out|up|${HIT_TO}) (?:out |up )?to (?:the )?(?:${noun})\\b`,
        ...(base == null
          ? []
          : [`\\b${HIT_TO} (?:out |up )?(?:foul )?to (?:the )?${base}\\b`])
      ].join('|'),
      'i'
    ).test(transcript)
    const id = defense[position]?.id
    return said && id != null ? [id] : []
  })
}
/**
 * A foul's side, said of the foul: a side word within a few words after it —
 * "foul pop to first", "fouls out to third", "foul popout to third", "in
 * foul territory near third", "fouled out, caught near third", "foul ball
 * caught by the third baseman" — or "the third base line"; never a runner's
 * or a throw's "to third": the words between stop at "and", "he", a runner,
 * a runner's verb ("tags up to third"), a throw, "safe", or a comma — one
 * that is followed by "caught", or straight by the side ("foul pop, near
 * third"), is crossed.
 */
const FOUL_SIDE =
  /\bfoul(?:s|ed)?\b(?:(?:[\s-]+|,\s*(?=(?:caught|grabbed|snagged|taken)\b))(?!(?:and|but|while|as|then|he|she|they|runners?|man|guy|kid|girl|boy|tags?|tagged|tagging|goes|went|advances?|advanced|moves?|moved|runs?|ran|takes?|took|heads?|headed|scores?|scored|slides?|slid|sliding|throws?|thrown|safe)\b)[\w']+){0,4}?(?:[\s-]+|,\s*)(?:over (?:by|near)|to|at|near|by|down) (?:the )?(first|third)\b|\b(first|third) base (?:line|side)\b/i

function saidSide(
  game: GameState,
  transcript: string
): '1B' | '3B' | undefined {
  // A runner said by name is a runner.
  const offense = game.liveData.linescore.offense
  const words = [offense.first?.id, offense.second?.id, offense.third?.id]
    .flatMap(id => (id == null ? [] : playerPatterns(game, id)))
    .reduce(
      (text, pattern) => text.replace(new RegExp(pattern, 'gi'), 'runner'),
      transcript
    )
  const match = FOUL_SIDE.exec(words)
  const base = match
    ?.slice(1)
    .find(word => word != null)
    ?.toLowerCase()
  return base === 'first' ? '1B' : base === 'third' ? '3B' : undefined
}

/**
 * What a sentence leaves to be assumed, filled in before it is tried:
 * - a hit with no trajectory is a line drive, and a caught foul a pop-up
 *   that was caught;
 * - a ball in play sent after its result, with only runners' moves
 *   between, goes before it;
 * - a caught ball no action names a fielder for, and whose words do not
 *   say who caught it, was caught by the outfielder for the direction it
 *   went, or for a foul by the corner infielder on its side (its direction,
 *   "to first", or away from the batter) — the game records the out only
 *   with a fielder; otherwise the screen asks —
 *   and a caught foul said without a ball in play has one;
 * - a ball sent a direction lands there, and a caught foul in foul
 *   territory on its fielder's side, or away from the batter;
 * - the batter is not also sent out on a caught ball: the catch is his out;
 * - a runner thrown out at home, third or first with no fielders named,
 *   after a caught ball, was thrown out by the one who caught it to the
 *   fielder covering the base. A chain the model sent is kept as sent.
 */
export function playDefaults(
  game: GameState,
  spoken: readonly ScoringAction[],
  transcript = ''
): ScoringAction[] {
  const defense = game.liveData.linescore.defense
  // A batted-ball result followed by its ball in play, with only runners'
  // moves between: the ball in play goes first. A caught foul with no ball
  // in play of its own since the last result gets one, for its fielder.
  const rest = [...spoken]
  const sentence: ScoringAction[] = []
  let inPlaySince = false
  for (let index = 0; index < rest.length; index++) {
    const action = rest[index]
    if (
      action.type === 'result' &&
      BATTED.has(action.eventType) &&
      !inPlaySince
    ) {
      let ahead = index + 1
      while (
        rest[ahead]?.type === 'runnerMovement' ||
        rest[ahead]?.type === 'fieldingPlay'
      )
        ahead++
      // A ball in play with a result of its own after it is the next
      // batter's, not this one's.
      const ownResult = rest
        .slice(ahead + 1)
        .findIndex(next => next.type === 'result' || next.type === 'ballInPlay')
      // Only a result a ball in play comes to: a walk or a hit by pitch
      // after it takes none, and nor does one sent before its own ball in
      // play, as this one was.
      const followingAt = ahead + 1 + ownResult
      const following = rest[followingAt]
      let afterIt = followingAt + 1
      while (
        rest[afterIt]?.type === 'runnerMovement' ||
        rest[afterIt]?.type === 'fieldingPlay'
      )
        afterIt++
      const itsOwn =
        ownResult >= 0 &&
        following.type === 'result' &&
        BATTED.has(following.eventType) &&
        rest[afterIt]?.type !== 'ballInPlay'
      if (rest[ahead]?.type === 'ballInPlay' && !itsOwn) {
        const [inPlay] = rest.splice(ahead, 1)
        sentence.push(inPlay, action)
        continue
      }
    }
    if (action.type === 'ballInPlay') inPlaySince = true
    if (action.type === 'result') {
      if (
        !inPlaySince &&
        action.eventType === 'field_out' &&
        action.foulCaught === true
      )
        sentence.push({ type: 'ballInPlay', contact: 'swing' })
      inPlaySince = false
    }
    sentence.push(action)
  }
  // A catcher the words name whom no ball in play carries: the model left
  // him out, and the screen asks rather than assume another.
  const carried = new Set(
    spoken.flatMap(action =>
      action.type === 'ballInPlay' && action.fielder != null
        ? [action.fielder]
        : []
    )
  )
  const catchSaid = catchersSaid(game, transcript).filter(
    id => !carried.has(id)
  )
  const side = saidSide(game, transcript)
  const batter = game.liveData.plays.currentPlay?.matchup.batter.id
  const result = sentence.find(
    (action): action is ResultAction => action.type === 'result'
  )
  const foul = result?.eventType === 'field_out' && result.foulCaught === true
  const caught =
    result?.eventType === 'field_out' && (result.outBy === 'catch' || foul)
  let caughtBy: number | undefined
  return sentence.flatMap((action, index): ScoringAction[] => {
    if (action.type === 'result') {
      if (action.foulCaught === true && action.outBy == null)
        return [{ ...action, outBy: 'catch' }]
      return [action]
    }
    if (action.type === 'ballInPlay') {
      const own = sentence
        .slice(index + 1)
        .find((next): next is ResultAction => next.type === 'result')
      const next: BallInPlayAction = { ...action }
      const ownFoul = own?.eventType === 'field_out' && own.foulCaught === true
      const ownCatch =
        own?.eventType === 'field_out' && (own.outBy === 'catch' || ownFoul)
      if (next.trajectory == null && next.launchAngle == null) {
        if (ownFoul) next.trajectory = 'popup'
        else if (own != null && HITS.has(own.eventType))
          next.trajectory = 'line_drive'
      }
      if (ownCatch && next.fielder == null) {
        // A foul is caught on its side — by its direction, or the words
        // said of the foul, or away from the batter.
        const foulSide =
          next.direction === 'left' || next.direction === 'left_center'
            ? '3B'
            : next.direction === 'right' || next.direction === 'right_center'
              ? '1B'
              : side
        const fielder = ownFoul
          ? foulSide != null
            ? defense[foulSide]?.id
            : foulFielder(game)
          : next.direction != null
            ? defense[OUTFIELDER[next.direction]]?.id
            : undefined
        // Only when the words do not say someone else caught it: one they
        // name but the model left out is asked for.
        const other = catchSaid.some(id => id !== fielder)
        if (fielder != null && !other) next.fielder = fielder
      }
      if (next.location == null) {
        if (ownFoul) next.location = foulPoint(game, next.fielder)
        else if (next.direction != null)
          next.location = directionPoint(
            next.direction,
            own,
            next.contact === 'bunt' ||
              next.trajectory === 'ground_ball' ||
              next.trajectory === 'chopper'
          )
      }
      if (ownCatch) caughtBy = next.fielder
      return [next]
    }
    if (action.type === 'runnerMovement' && action.out === true) {
      if (caught && action.runner === batter) return []
      const cover = COVERS[action.to]
      const receiver = cover == null ? undefined : defense[cover]?.id
      const chain = action.fielders ?? []
      const thrower =
        chain.length === 0 && action.runner !== batter && caughtBy != null
          ? caughtBy
          : undefined
      if (receiver != null && thrower != null && thrower !== receiver)
        return [{ ...action, fielders: [thrower, receiver] }]
    }
    return [action]
  })
}

/** The base a runner stealing this one comes from. */
const FROM: Record<Destination, Destination> = {
  batter: 'batter',
  '1B': 'batter',
  '2B': '1B',
  '3B': '2B',
  home: '3B'
}
const SPOKEN_BASE = /\b(first|second|third|home|plate|1st|2nd|3rd|1b|2b|3b)\b/i
/** "The first pitch" names no base. */
const PITCH_ORDINAL = /\b(first|second|third|next|1st|2nd|3rd)\s+pitch\b/gi
/** "The lead runner", "the trail runner". */
const RUNNER_BY_PLACE = /\b(lead|leading|trail|trailing)\s+runner\b/i
const NUMBER_WORDS = [
  'zero',
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

/**
 * Whether the words name a base ("second"; "the first pitch" is no base) or
 * a runner on base — by first name, "#2", "number 2", "number two", or as
 * the lead or trail runner.
 */
function wordsNameRunnerOrBase(game: GameState, transcript: string): boolean {
  if (SPOKEN_BASE.test(transcript.replace(PITCH_ORDINAL, ' '))) return true
  if (RUNNER_BY_PLACE.test(transcript)) return true
  const offense = game.liveData.linescore.offense
  const runners = [offense.first?.id, offense.second?.id, offense.third?.id]
  return runners.some(id => id != null && namesPlayer(game, id, transcript))
}

/** Whether the words name a player: by first name, "#2" or "number two". */
function namesPlayer(game: GameState, id: number, words: string): boolean {
  return playerPatterns(game, id).some(pattern =>
    new RegExp(pattern, 'i').test(words)
  )
}

/** The ways the words may name a player, as regular expressions. */
function playerPatterns(game: GameState, id: number): string[] {
  const player = game.gameData.players[id]
  const first = player?.firstName ?? player?.fullName.split(' ')[0]
  const jersey = player?.jersey.trim() ?? ''
  const escape = (text: string): string =>
    text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    ...(first == null || first === '' ? [] : [`\\b${escape(first)}\\b`]),
    ...(/^\d+$/.test(jersey)
      ? [
          `(#|\\bnumber\\s+)${jersey}\\b`,
          ...(NUMBER_WORDS[Number(jersey)] == null
            ? []
            : [`\\bnumber\\s+${NUMBER_WORDS[Number(jersey)]}\\b`])
        ]
      : [])
  ]
}

/**
 * A question a sentence raises before it is tried, as a whole sentence per
 * answer:
 * - a ball caught with nobody to credit: who caught it;
 * - a ball in play with nothing said of how it ended: what happened;
 * - one steal whose words name no base and no runner, with more than one
 *   runner who could have stolen: who stole (not asked again of an answer).
 */
export function sentenceQuestion(
  game: GameState,
  transcript: string,
  sentence: readonly ScoringAction[],
  answered = false
): Question | undefined {
  const defense = game.liveData.linescore.defense
  // Each caught out, with the ball in play since the result before it.
  let previous = -1
  for (let at = 0; at < sentence.length; at++) {
    const result = sentence[at]
    if (result.type !== 'result') continue
    const inPlayAt = sentence.findIndex(
      (action, index) =>
        index > previous && index < at && action.type === 'ballInPlay'
    )
    previous = at
    const inPlay = sentence[inPlayAt]
    if (
      result.eventType !== 'field_out' ||
      result.outBy !== 'catch' ||
      (inPlay?.type === 'ballInPlay' && inPlay.fielder != null)
    )
      continue
    // With two batters in the sentence, say whose ball it was.
    const results = sentence.filter(action => action.type === 'result').length
    let upTo = game
    for (const action of sentence.slice(0, at))
      upTo = applyAction(upTo, action).state
    const whose = upTo.liveData.plays.currentPlay?.matchup.batter.id
    return {
      question:
        results > 1 && whose != null
          ? `Who caught ${nameOf(game, whose)}'s ball?`
          : 'Who caught it?',
      options: POSITIONS.flatMap(position => {
        const ref = defense[position]
        if (ref == null) return []
        const withFielder =
          inPlay?.type === 'ballInPlay'
            ? sentence.map(action =>
                action === inPlay ? { ...inPlay, fielder: ref.id } : action
              )
            : [
                ...sentence.slice(0, at),
                {
                  type: 'ballInPlay' as const,
                  contact: 'swing' as const,
                  fielder: ref.id
                },
                ...sentence.slice(at)
              ]
        return [
          { label: `${position} ${nameOf(game, ref.id)}`, actions: withFielder }
        ]
      })
    }
  }
  const resultAt = sentence.findIndex(action => action.type === 'result')
  const inPlayAt = sentence.findIndex(action => action.type === 'ballInPlay')
  const inPlay = sentence[inPlayAt]
  if (inPlay?.type === 'ballInPlay' && resultAt < 0) {
    const ended = (
      label: string,
      how: ResultAction
    ): { label: string; actions: ScoringAction[] } => ({
      label,
      actions: [
        ...sentence.slice(0, inPlayAt + 1),
        how,
        ...sentence.slice(inPlayAt + 1)
      ]
    })
    return {
      question: 'What happened on the play?',
      options: [
        ended('Caught for an out', {
          type: 'result',
          eventType: 'field_out',
          outBy: 'catch'
        }),
        ended('Thrown out', {
          type: 'result',
          eventType: 'field_out',
          outBy: 'throw'
        }),
        ended("Fielder's choice", {
          type: 'result',
          eventType: 'fielders_choice'
        }),
        ended('Single', { type: 'result', eventType: 'single' }),
        ended('Double', { type: 'result', eventType: 'double' }),
        ended('Triple', { type: 'result', eventType: 'triple' }),
        ended('Home run', { type: 'result', eventType: 'home_run' }),
        ended('Reached on an error', {
          type: 'result',
          eventType: 'field_error'
        })
      ]
    }
  }
  // A steal, or a runner caught stealing, said with no base and no runner.
  const steals = sentence.filter(
    action =>
      action.type === 'baseRunning' &&
      (action.kind === 'steal' ||
        action.kind === 'caught_stealing' ||
        action.kind === 'pickoff')
  )
  const said = steals[0] as Extract<ScoringAction, { type: 'baseRunning' }>
  const caughtStealing = said?.kind === 'caught_stealing'
  const pickoff = said?.kind === 'pickoff'
  if (
    !answered &&
    steals.length === 1 &&
    sentence.every(action => action === steals[0] || action.type === 'pitch') &&
    !wordsNameRunnerOrBase(game, transcript)
  ) {
    const offense = game.liveData.linescore.offense
    const runners = [offense.third?.id, offense.second?.id, offense.first?.id]
    const on = runners.flatMap((id, index) =>
      id == null ? [] : [{ id, to: (['home', '3B', '2B'] as const)[index] }]
    )
    if (on.length < 2) return undefined
    const pickedAt = pickoff ? pickoffBase(game, said) : undefined
    // The model's action for another runner; its fielders only where the
    // base is the one it sent.
    const steal = (runner: { id: number; to: Destination }): ScoringAction => {
      const { fielders: _guessed, ...rest } = said
      // A pickoff's base is the one the runner stood on; a steal's the one
      // he ran for.
      const sameBase = pickoff
        ? pickedAt == null
          ? runner.id === said.runner
          : pickedAt === FROM[runner.to]
        : runner.to === said.to
      return {
        ...(sameBase ? said : rest),
        runner: runner.id,
        to: pickoff ? FROM[runner.to] : runner.to
      }
    }
    // Alone, a runner steals only into an empty base.
    const empty = (to: Destination): boolean =>
      to === 'home' ||
      (to === '3B' ? offense.third == null : offense.second == null)
    // A pickoff can be of any runner; a steal only into an empty base.
    const free = pickoff ? on : on.filter(runner => empty(runner.to))
    // Caught stealing with one runner who could have tried: it was him.
    if (caughtStealing && free.length < 2) return undefined
    // Each answer is the sentence, its steal replaced.
    const withSteals = (chosen: ScoringAction[]): ScoringAction[] =>
      sentence.flatMap(action => (action === steals[0] ? chosen : [action]))
    return {
      question: pickoff
        ? 'Who was picked off?'
        : caughtStealing
          ? 'Who was caught stealing?'
          : 'Who stole?',
      options: [
        ...free.map(runner => ({
          label: pickoff
            ? `${nameOf(game, runner.id)} picked off ${SPOKEN[FROM[runner.to]]}`
            : `${nameOf(game, runner.id)} ${caughtStealing ? 'caught stealing' : 'steals'} ${SPOKEN[runner.to]}`,
          actions: withSteals([steal(runner)])
        })),
        ...(caughtStealing || pickoff
          ? []
          : [
              {
                label: on.length === 2 ? 'Double steal' : 'Triple steal',
                actions: withSteals(on.map(steal))
              }
            ])
      ]
    }
  }
  return undefined
}

/** The base a fielder takes a pickoff throw at. */
const PICKOFF_COVERS: Partial<Record<(typeof POSITIONS)[number], Destination>> =
  { '1B': '1B', '2B': '2B', SS: '2B', '3B': '3B' }

/**
 * Where a pickoff was: at the base of the fielder who took the throw, or
 * else the base it was sent with.
 */
function pickoffBase(
  game: GameState,
  pickoff: Extract<ScoringAction, { type: 'baseRunning' }>
): Destination | undefined {
  const defense = game.liveData.linescore.defense
  const receiver = pickoff.fielders?.at(-1)
  const position = POSITIONS.find(
    place => receiver != null && defense[place]?.id === receiver
  )
  return (position == null ? undefined : PICKOFF_COVERS[position]) ?? pickoff.to
}
/** Each base as the words say it; "home" also as "the plate". */
const SAID_BASE: Partial<Record<number, RegExp>> = {
  2: /\b(?:second|2nd|2b)\b(?! base(?:man|men)\b)/i,
  3: /\b(?:third|3rd|3b)\b(?! base(?:man|men)\b)/i,
  4: /\b(?:home|plate)\b/i
}
const STEAL_WORD = /\b(?:steals?|stole|stolen|stealing|swipes?|swiped)\b/i
/** A runner by his base: "the runner on first", "the man at 2nd". */
const RUNNER_ON =
  /\b(?:base ?runner|runner|man|guy|kid|girl|boy|player)(?: over| standing)? (?:on|at|from) (first|second|third|1st|2nd|3rd)\b/gi
const BASE_OF: Record<string, number> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3
}
/** The base a throw went to: "the throw to third is late". */
const THROW_TO =
  /\bthrow\w*\b(?:(?!\band\b)[^.;,])*?\b(?:to|into|at|toward|towards) (?:the )?(?:first|second|third|home|plate|1st|2nd|3rd)\b/gi
/** The base word at the end of a throw's words. */
const THROWN_BASE =
  /\b(?:to|into|at|toward|towards) (?:the )?(?:first|second|third|home|plate|1st|2nd|3rd)$/i
/** "Scores", "races home", "crosses the plate": a runner reached home. */
const SAID_SCORED =
  /\b(?:scores?|scored|scoring|(?:comes?|came|goes|went|races?|raced|heads?|headed|runs?|ran|dash(?:es|ed)?|slides?|slid|makes it|made it) home|cross(?:es|ed)? the plate)\b/i
/** A run said not to have scored: "does not score", "thrown out trying to score". */
const NOT_SCORED =
  /(?:\bnot\b|\bnever\b|n't\b)(?:\s+\w+){0,2}\s+(?:score|scores|scored|come home|go home|make it home|cross)|\b(?:trying|tries|tried|attempting|attempts) to (?:score|go home|come home|make it home|steal home)\b|\b(?:thrown|tagged|cut down|gunned down)(?: out)?(?:\s+\w+){0,2}\s+(?:at home|at the plate|trying to score)\b|\bout at (?:home|the plate)\b/i

/**
 * The words that say something of this runner, clause by clause (split at
 * ".", ";", "and" and "but"), each one the test finds. A clause is cut at
 * every runner it names — by his base ("the runner on third", "the kid at
 * 3rd") or by name or number, among the runners on base as the sentence
 * began or now — and each piece is about the runner it begins with; the
 * words before the first runner named are this runner's ("he steals"). The
 * pieces about other runners are dropped, and so are the base a throw went
 * to and this runner's own "runner on first".
 */
function runnerClauses(
  games: readonly GameState[],
  transcript: string,
  runner: number,
  from: number,
  test: RegExp
): string[] {
  const others = [
    ...new Set(
      games.flatMap(game => {
        const offense = game.liveData.linescore.offense
        return [offense.first?.id, offense.second?.id, offense.third?.id]
      })
    )
  ].filter((id): id is number => id != null && id !== runner)
  const said = (
    clause: string,
    ids: readonly number[]
  ): Array<{ at: number; end: number }> =>
    ids
      .flatMap(id => games.flatMap(game => playerPatterns(game, id)))
      .flatMap(pattern => [...clause.matchAll(new RegExp(pattern, 'gi'))])
      .map(match => ({ at: match.index, end: match.index + match[0].length }))
  const own = (clause: string): string => {
    const named = [
      ...[...clause.matchAll(RUNNER_ON)].map(match => ({
        at: match.index,
        end: match.index + match[0].length,
        mine: BASE_OF[match[1].toLowerCase()] === from
      })),
      ...said(clause, [runner]).map(at => ({ ...at, mine: true })),
      ...said(clause, others).map(at => ({ ...at, mine: false }))
    ].sort((a, b) => a.at - b.at)
    let kept = clause.slice(0, named[0]?.at ?? clause.length)
    named.forEach((at, index) => {
      if (at.mine)
        kept += ` ${clause.slice(at.end, named[index + 1]?.at ?? clause.length)}`
    })
    return kept
  }
  return transcript
    .replace(PITCH_ORDINAL, ' ')
    .replace(THROW_TO, thrown => thrown.replace(THROWN_BASE, ' '))
    .split(/[.;]|\b(?:and|but)\b/i)
    .map(own)
    .filter(clause => test.test(clause))
}

const BASE_INDEX: Partial<Record<Destination, number>> = {
  '2B': 2,
  '3B': 3,
  home: 4
}

/**
 * A steal, or a runner caught stealing, names the base taken, and with it
 * the runner on the base before it. One sent for a runner who could not
 * have tried it goes to the runner who could, when nothing else in the
 * sentence moves him: the runner on the base before the one named, or — the
 * base ahead of the runner sent being taken, and the words naming no base
 * and no runner — the runner on it, as far up as the next empty base.
 * A steal takes one base, unless its own words — the clauses that say it,
 * not about another runner, without the base a throw went to — say the base
 * taken and not the one before it, and never more than two. A steal of home
 * kept to one base, whose runner his own words say scored (and not that he
 * did not), is followed by his run.
 * A pickoff is of the runner on the base it was at. Fielders sent for
 * another base are not kept.
 */
export function stealsByBase(
  game: GameState,
  said: readonly ScoringAction[],
  transcript = ''
): ScoringAction[] {
  // A runner or base the words name is the scorer's: nothing is moved up.
  const unnamed = !wordsNameRunnerOrBase(game, transcript)
  const moving = new Set(
    said.flatMap(action =>
      (action.type === 'baseRunning' || action.type === 'runnerMovement') &&
      action.runner != null
        ? [action.runner]
        : []
    )
  )
  const TO: readonly Destination[] = ['batter', '1B', '2B', '3B', 'home']
  const fixed: ScoringAction[] = []
  let state = game
  for (const action of said) {
    let next = action
    if (action.type === 'baseRunning' && action.kind === 'pickoff') {
      // A pickoff at a base is of the runner standing on it.
      const offense = state.liveData.linescore.offense
      const standing = {
        '1B': offense.first,
        '2B': offense.second,
        '3B': offense.third
      }
      const base = pickoffBase(state, action)
      const at =
        base == null ? undefined : standing[base as '1B' | '2B' | '3B']?.id
      if (at != null && at !== action.runner)
        next = { ...action, runner: at, to: base }
    }
    if (
      action.type === 'baseRunning' &&
      (action.kind === 'steal' || action.kind === 'caught_stealing') &&
      action.to != null &&
      BASE_INDEX[action.to] != null
    ) {
      const offense = state.liveData.linescore.offense
      const bases = [offense.first?.id, offense.second?.id, offense.third?.id]
      const from = bases.indexOf(action.runner) + 1
      const named = BASE_INDEX[action.to]!
      const holder = bases[named - 2]
      let runner = action.runner
      // A runner steals one base at a time, unless the words say the base
      // he took and not the one before it.
      const words = runnerClauses(
        [game, state],
        transcript,
        action.runner,
        from,
        STEAL_WORD
      ).join(' ')
      // Never more than two bases in one steal.
      const farther =
        named - from <= 2 &&
        SAID_BASE[named]?.test(words) === true &&
        SAID_BASE[from + 1]?.test(words) !== true
      let to = from > 0 && !farther ? Math.min(named, from + 1) : named
      const target = to
      if (
        holder != null &&
        holder !== action.runner &&
        from !== named - 1 &&
        !moving.has(holder)
      ) {
        // The base named is the one taken: its runner came from the base
        // before it.
        runner = holder
        to = named
      } else if (unnamed && from > 0 && from < 4) {
        // The base ahead is taken: the runner on it went, or the one ahead.
        to = from + 1
        while (to < 4 && bases[to - 1] != null && !moving.has(bases[to - 1]!)) {
          runner = bases[to - 1]!
          to++
        }
        if (runner === action.runner) to = target
      }
      if (runner !== action.runner || to !== named) {
        const { fielders: _guessed, ...rest } = action
        next = {
          ...(to === named ? action : rest),
          runner,
          to: TO[to]
        }
      }
    }
    const prior = state
    fixed.push(next)
    state = applyAction(state, next).state
    // A steal of home kept to third, whose runner his own words say scored:
    // the run came after.
    const scored = (runner: number): boolean => {
      const offense = prior.liveData.linescore.offense
      const from =
        [offense.first?.id, offense.second?.id, offense.third?.id].indexOf(
          runner
        ) + 1
      return runnerClauses(
        [game, prior],
        transcript,
        runner,
        from,
        SAID_SCORED
      ).some(clause => !NOT_SCORED.test(clause))
    }
    if (
      action.type === 'baseRunning' &&
      action.kind === 'steal' &&
      action.to === 'home' &&
      next.type === 'baseRunning' &&
      next.to !== 'home' &&
      scored(next.runner) &&
      !said.some(
        other =>
          (other.type === 'runnerMovement' &&
            other.runner === next.runner &&
            other.to === 'home') ||
          (other.type === 'batteryEvent' &&
            other.advances?.some(
              move => move.runner === next.runner && move.to === 'home'
            ) === true)
      )
    ) {
      const run: ScoringAction = {
        type: 'runnerMovement',
        runner: next.runner,
        to: 'home'
      }
      fixed.push(run)
      state = applyAction(state, run).state
    }
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

/**
 * A play that still waits on something a tap would settle — the batter out
 * at first on a ground out nobody finished, the runners out on a fielder's
 * choice — when the sentence goes on with something the game will not take
 * until it is settled: a runner's move, or the next batter. It is settled
 * by the same rules as the end of a sentence, so the game takes the rest;
 * the batter's own out said later in the sentence is taken first instead.
 * What only the scorer can answer is asked, each answer the whole sentence.
 * A runner said to reach the base the play already put him on — "single,
 * the runner goes to third" from second — is where the game has him.
 */
export function settleBetween(
  game: GameState,
  sentence: readonly ScoringAction[]
): { actions: ScoringAction[]; question?: Question } {
  const settled: ScoringAction[] = []
  const rest = [...sentence]
  let state = game
  while (rest.length > 0) {
    const action = rest.shift()!
    if (
      action.type === 'runnerMovement' &&
      action.out !== true &&
      state.pending?.movements.some(
        move =>
          move.playerId === action.runner &&
          move.decision === 'safe' &&
          move.to === destinationBase(action.to)
      ) === true
    )
      continue
    const waits =
      settled.length > 0 &&
      state.pending != null &&
      applyAction(state, action).problems.length > 0
    if (waits) {
      const decision = nextDecision(state)
      const batter = batterOf(state)
      const ownOut = rest.findIndex(
        later =>
          later.type === 'runnerMovement' &&
          later.runner === batter &&
          later.out === true
      )
      const answer =
        decision === 'batterOut' && ownOut >= 0
          ? rest.splice(ownOut, 1)
          : decide(state, decision, settled)
      if (answer != null && !Array.isArray(answer)) {
        const { ask } = answer
        const after = [action, ...rest]
        return {
          actions: [...sentence],
          question: {
            question: ask.question,
            ...(ask.options == null
              ? {}
              : {
                  options: ask.options.map(option => ({
                    label: option.label,
                    actions: [...settled, ...option.actions, ...after]
                  }))
                }),
            ...(ask.pick == null
              ? {}
              : {
                  pick: {
                    ...ask.pick,
                    before: [...settled, ...ask.pick.before],
                    after
                  }
                })
          }
        }
      }
      for (const step of answer ?? []) {
        const applied = applyAction(state, step)
        if (applied.problems.length > 0) break
        state = applied.state
        settled.push(step)
      }
    }
    state = applyAction(state, action).state
    settled.push(action)
  }
  return { actions: settled }
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
    ? [...pick.before, ...pick.none, ...(pick.after ?? [])]
    : [
        ...pick.before,
        ...picks.flatMap(index => pick.choices[index].actions),
        ...(pick.after ?? [])
      ]
}
