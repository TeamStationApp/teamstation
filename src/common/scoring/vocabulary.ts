import type { BatteryKind, PitchCall, ResultType } from './actions'

/**
 * What dictation is told about baseball, for its two models.
 *
 * The dictation model — the recogniser — gets `DICTATION_TERMS` as key terms,
 * so it hears a word. The LLM gets `DICTATION_VOCABULARY` in its system
 * prompt, so it understands one. They are different lists on purpose: a key
 * term is worth a slot only when the recogniser gets the word wrong without
 * it, while the vocabulary has no slot limit and exists to say what a word
 * means for the game.
 */

/**
 * Scoring words the recogniser mishears. Names are not here; `keyterms` puts
 * the players first. Everyday words — single, walk, strikeout, safe — are left
 * out because the recogniser already hears them, and a term it already hears
 * costs a slot and biases it toward hearing the word when it was not said.
 *
 * The at-bat terms were measured: without them the recogniser heard "beaned"
 * as "beamed", "froze him" as "throws him", "whiffed" as "lift" and "dotted"
 * as "that at" (2026-09-28), and "intentional walk" as "potential walk".
 * The rows above them are kept until a real game shows whether each earns
 * its slot.
 */
export const DICTATION_TERMS: readonly string[] = [
  // Double-play chains: the one place these scorers use position numbers.
  'six four three',
  'four six three',
  'five four three',
  // Outs.
  "fielder's choice",
  'double play',
  'infield fly',
  'dropped third strike',
  'caught looking',
  'sac fly',
  'sac bunt',
  'tagged up',
  'doubled off',
  // Hits.
  'gapper',
  'bloop',
  'Texas leaguer',
  'frozen rope',
  'can of corn',
  'chopper',
  'nubber',
  'dinger',
  'ground-rule double',
  'in-the-park home run',
  'grand slam',
  // Base running.
  'caught stealing',
  'picked off',
  'rundown',
  'defensive indifference',
  'wild pitch',
  'balk',
  // Scoring.
  'RBI',
  // The at-bat, each one measured as misheard without its key term.
  'beaned',
  'froze him',
  'whiffed',
  'dotted',
  'intentional walk',
  // How far a ball went, and the kind of pitch.
  'blooper',
  'dribbler',
  'warning track',
  'off the wall',
  'shallow',
  'fastball',
  'curveball',
  'slider',
  'changeup'
]

/** What a phrase comes to, in the library's own vocabulary. */
export type VocabularyAction =
  | { type: 'pitch'; call: PitchCall }
  | { type: 'result'; eventType: ResultType }
  | { type: 'batteryEvent'; kind: BatteryKind }

export interface VocabularyEntry {
  phrases: readonly string[]
  means: string
  action: VocabularyAction
  /** How the action is to be used, when the bare action would mislead. */
  note?: string
}

/**
 * The language of an at-bat, mapped onto actions the library takes. Typed
 * against `PitchCall`, `ResultType` and `BatteryKind`, so the vocabulary cannot
 * promise the LLM an action the library would refuse.
 */
export const VOCABULARY_ENTRIES: readonly VocabularyEntry[] = [
  {
    phrases: [
      'outside',
      'away',
      'wide',
      'off the plate',
      'just missed',
      'missed the corner',
      'inside',
      'in on the hands',
      'high',
      'up',
      'above the letters',
      'low',
      'down',
      'below the knees',
      'in the dirt',
      'spiked',
      'bounced it',
      'short-hopped',
      'pitchout',
      'chin music',
      'brushback',
      'backed him off the plate',
      'high and tight'
    ],
    means: 'a ball — when the batter did not swing and was not hit',
    action: { type: 'pitch', call: 'B' }
  },
  {
    phrases: ['checked his swing', 'held up'],
    means: 'no swing — a ball unless the call says otherwise',
    action: { type: 'pitch', call: 'B' }
  },
  {
    phrases: ['ball four', 'four wide ones', 'free pass', 'walked him'],
    means: 'the fourth ball',
    action: { type: 'pitch', call: 'B' },
    note: 'the ball that makes four; the library records the walk'
  },
  {
    phrases: ['intentional walk', 'put him on', 'IBB'],
    means: 'an intentional walk',
    action: { type: 'result', eventType: 'intent_walk' }
  },
  {
    phrases: [
      'painted',
      'painted the black',
      'on the black',
      'caught the corner',
      'nicked the corner',
      'dotted',
      'hit the spot',
      'down the middle',
      'down Broadway',
      'grooved it',
      'at the knees',
      'at the letters',
      'backdoor',
      'front door',
      'froze him',
      'took it for a strike',
      "didn't offer",
      'framed it',
      'stole a strike'
    ],
    means: 'a called strike',
    action: { type: 'pitch', call: 'C' }
  },
  {
    phrases: [
      'rung up',
      'punched out',
      'backwards K',
      'caught looking',
      'struck out looking'
    ],
    means: 'strike three, called',
    action: { type: 'pitch', call: 'C' },
    note: 'the called strike that makes three; the library records the strikeout'
  },
  {
    phrases: [
      'swing and a miss',
      'swung through it',
      'whiff',
      'whiffed',
      'fanned',
      'came up empty',
      'chased',
      'went fishing',
      'blew it by him',
      'went around'
    ],
    means: 'a swinging strike',
    action: { type: 'pitch', call: 'S' }
  },
  {
    phrases: [
      'K',
      'struck out swinging',
      'went down swinging',
      'blew him away'
    ],
    means: 'strike three, swinging',
    action: { type: 'pitch', call: 'S' },
    note: 'the swinging strike that makes three'
  },
  {
    phrases: [
      'fouled it off',
      'fouled it back',
      'spoiled it',
      'stayed alive',
      'got a piece of it',
      'back to the screen'
    ],
    means: 'a foul ball',
    action: { type: 'pitch', call: 'F' }
  },
  {
    phrases: ['foul tip', 'tipped it', 'tipped foul', 'fouled off'],
    means:
      'a foul ball — what a scorer means by a foul tip unless it went into the mitt',
    action: { type: 'pitch', call: 'F' }
  },
  {
    phrases: ['foul tip into the mitt', 'tipped into the glove'],
    means: "a foul tip into the catcher's mitt — strike three with two strikes",
    action: { type: 'pitch', call: 'T' }
  },
  {
    phrases: ['foul tip caught', 'foul pop caught', 'fouled out'],
    means:
      'a caught foul pop, an out — not strike three; a foul tip is caught this way unless it went into the mitt',
    action: { type: 'result', eventType: 'field_out' },
    note: 'with outBy catch and foulCaught true'
  },
  {
    phrases: ['bunted foul', 'foul bunt'],
    means: 'a foul bunt — strike three with two strikes',
    action: { type: 'pitch', call: 'L' }
  },
  {
    phrases: [
      'hit by pitch',
      'HBP',
      'beaned',
      'plunked',
      'drilled',
      'nailed him',
      'clipped',
      'grazed',
      'wore one',
      'took one for the team'
    ],
    means: 'hit by the pitch',
    action: { type: 'result', eventType: 'hit_by_pitch' }
  },
  {
    phrases: ['wild pitch', 'got away from the pitcher', 'to the backstop'],
    means: 'a wild pitch',
    action: { type: 'batteryEvent', kind: 'wild_pitch' },
    note: 'when the count is 0-0, send the pitch first — pitch B unless he called a strike — then this, with where each runner went'
  },
  {
    phrases: ['passed ball', 'got by the catcher'],
    means: 'a passed ball',
    action: { type: 'batteryEvent', kind: 'passed_ball' }
  },
  {
    phrases: ['balk'],
    means: 'a balk',
    action: { type: 'batteryEvent', kind: 'balk' }
  },
  {
    phrases: [
      'third disengagement',
      'disengaged a third time',
      'stepped off a third time'
    ],
    means: 'a balk — the third disengagement, not third base',
    action: { type: 'batteryEvent', kind: 'balk' },
    note: 'moves every runner up one base by itself; not defensive indifference, and no advances'
  },
  {
    phrases: [
      "catcher's interference",
      'glove hit the bat',
      "the bat hits the catcher's mitt"
    ],
    means: "catcher's interference",
    action: { type: 'result', eventType: 'catcher_interference' },
    note: 'puts the batter on first and moves a forced runner; do not also call placeRunner, and do not ask'
  },
  {
    phrases: [
      'dropped third strike',
      "the catcher didn't hold it",
      'uncaught third strike'
    ],
    means: 'strike three the catcher did not catch',
    action: { type: 'result', eventType: 'strikeout' }
  }
]

function actionText(action: VocabularyAction): string {
  switch (action.type) {
    case 'pitch':
      return `pitch ${action.call}`
    case 'result':
      return `result ${action.eventType}`
    case 'batteryEvent':
      return `batteryEvent ${action.kind}`
  }
}

/**
 * The four places an LLM goes wrong with these words. Each is written against
 * what `applyAction` does, not against what baseball calls things.
 */
const RULES = [
  'Words that name the same event are ONE action. "Whiffed, K", "struck him out swinging, strike three" and "ball four, walked him" each describe one pitch. A summary word — K, strikeout, strike three, walk — restates the pitch before it and never adds another. A second pitch would record the strikeout and then put a strike on the next batter.',
  'An ordinary strikeout is a pitch, never result strikeout. In this system result strikeout means a dropped third strike only, and it is refused unless there are two strikes and first base is empty or there are two outs. A called strike three is pitch C, a swinging one is pitch S, a foul tip with two strikes is pitch T. Likewise there is no walk result: a walk is the fourth pitch B.',
  'A strikeout or a walk the count cannot reach is a question. Pitches are usually tapped, so the count in the context is normally current; "struck out" on a one-strike count means pitches went unrecorded. Call askScorer rather than inventing the missing pitches. "Four pitches, a strike" is not that question and not a walk: he named one pitch, the called strike, so it is one pitch C. Do not fill in balls to make four, and do not ask.',
  '"High and tight", "chin music" and "brushback" are balls unless the batter is hit. They describe a pitch near the batter, not one that hit him.'
]

/**
 * What the recogniser has been heard to write for a scoring word, and the
 * word. The LLM is sent the word, rather than told the mishearing in its
 * vocabulary: a change to the system prompt moved its readings of sentences
 * that have nothing to do with the word.
 */
const MISHEARD: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpotential(\s+)walk(?![-\w])/gi, 'intentional$1walk']
]

/** What the scorer said, with each word the recogniser misheard put right. */
export function heardAs(transcript: string): string {
  return MISHEARD.reduce(
    (text, [heard, meant]) => text.replace(heard, meant),
    transcript
  )
}

/** The vocabulary block, as the LLM reads it in its system prompt. */
export const DICTATION_VOCABULARY: string = [
  'BASEBALL VOCABULARY — what a scorer says, and the action it comes to.',
  ...VOCABULARY_ENTRIES.map(
    entry =>
      `- ${entry.phrases.join(', ')}: ${entry.means} → ${actionText(entry.action)}${
        entry.note == null ? '' : ` (${entry.note})`
      }`
  ),
  '',
  'RULES',
  ...RULES.map(rule => `- ${rule}`)
].join('\n')
