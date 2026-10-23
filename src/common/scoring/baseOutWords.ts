/**
 * The words that say a fielder took a base for an out — "tags second", "third
 * base for the out", "force at home" — a wild throw after it, and the words
 * that make a base verb a runner's instead. The completion layer reads the
 * outs from them, and the interpreter offers the model its base-out section
 * by them, so the two agree on what a base out is.
 */

/** A base other than first a fielder can put a runner out at. */
export type OutBase = '2B' | '3B' | 'home'

export const OUT_BASE = '(second|2nd|third|3rd|home|the plate)'
export const OUT_BASES: Record<string, OutBase> = {
  second: '2B',
  '2nd': '2B',
  third: '3B',
  '3rd': '3B',
  home: 'home',
  'the plate': 'home'
}
/** A fielder taking a base: "tags second", "steps on third". */
export const TAKES_BASE = new RegExp(
  `\\b(beats?\\s+(?:him|the\\s+runner)\\s+to|beat\\s+(?:him|the\\s+runner)\\s+to|tags?|tagged|touch(?:es|ed)?|steps?\\s+on|stepped\\s+on|takes?|took|gets?|got)\\s+(?:the\\s+)?${OUT_BASE}(?:\\s+(?:base|bag))?\\b`,
  'gi'
)
/** "Third base for the out", "second for the force". */
export const BASE_FOR_OUT = new RegExp(
  `\\b${OUT_BASE}(?:\\s+base)?\\s+for\\s+(?:the\\s+|a\\s+)?(?:out|force|one)\\b`,
  'gi'
)
/** "Force at second", "forced out at third". */
export const FORCE_AT = new RegExp(
  `\\b(?:force(?:d|out)?)(?:\\s+out)?\\s+at\\s+(?:the\\s+)?${OUT_BASE}\\b`,
  'gi'
)
/** What follows a take or a get that makes it an out, not a runner's base. */
export const FOR_THE_OUT =
  /^\s*(?:base\s+|bag\s+)?for\s+(?:the\s+|a\s+)?(?:out|force|one)\b/i
/** A wild throw to first after the out: "overthrows first". */
export const OVERTHROW =
  /\b(?:overthr(?:ows?|ew|own)|throws?\s+it\s+away|threw\s+it\s+away|(?:wild|bad|errant)\s+throw|throws?\s+it\s+past|sails?\s+(?:it\s+)?past)\b(?:[^.;]{0,30}?\b(?:first|1st)\b)?/i

/**
 * Words just after a base that carry a runner on past it: "touches third and
 * scores", "steps on third, rounds it, and heads home". They make a base verb
 * before them the runner's, not a fielder's taking the base for the out.
 */
export const RUNNER_GOES_ON =
  /^\s*(?:base\s+|bag\s+)?(?:safely\b|,?\s*(?:and\s+|then\s+|and\s+then\s+)?(?:scores?|comes?\s+home|heads?|goes|keeps?\s+going|holds|stays|rounds?|continues|races|runs?\s+home)\b)/i

/** Words just before a base that make it where the ball went: "to second". */
const BALL_WENT = /\b(?:to|toward|towards|at|into|on|down)\s+(?:the\s+)?$/i
/** A throw just before a base: "throws to second for the out" is a base out. */
const THROW_BEFORE =
  /\b(?:throws?|threw|flips?|flipped|tosses?|tossed|fires?|fired)\s+(?:it\s+|the\s+ball\s+)?(?:over\s+)?(?:to\s+)?(?:the\s+)?$/i

/**
 * Whether the base the words name at `at` is where the ball went — "grounder
 * to second base for the out" is a 4-3 — rather than one a throw took for the
 * out, as in "throws to second for the out".
 */
export function ballWentThere(transcript: string, at: number): boolean {
  const before = transcript.slice(0, at)
  return BALL_WENT.test(before) && !THROW_BEFORE.test(before)
}

/**
 * Whether the words say a base out: a fielder taking a base (a take or a get
 * only "for the out", and none a runner's going on carries past the base), a
 * base for the out that is not where the ball went, a force at a base, or a
 * wild throw.
 */
export function baseOutWordsSaid(transcript: string): boolean {
  for (const match of transcript.matchAll(TAKES_BASE)) {
    const after = transcript.slice(match.index + match[0].length)
    if (
      /^(?:takes?|took|gets?|got)$/i.test(match[1]) &&
      !FOR_THE_OUT.test(after)
    )
      continue
    if (!RUNNER_GOES_ON.test(after)) return true
  }
  return (
    [...transcript.matchAll(BASE_FOR_OUT)].some(
      match => !ballWentThere(transcript, match.index)
    ) ||
    transcript.search(FORCE_AT) >= 0 ||
    OVERTHROW.test(transcript)
  )
}
