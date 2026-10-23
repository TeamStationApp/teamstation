import {
  type Depth,
  DEPTH_ANCHORS,
  DEPTH_WORDS,
  DEPTHS
} from '../../common/scoring/depth'
import type { BaseName } from './dictatedGeometry'

/**
 * The depth a sentence says outright, for a ball in play the model left
 * without one. A phrase counts only beside a batted-ball or field word, so
 * "deep in the count" says nothing of a ball, nor does one that names a
 * pitch: a "blooper pitch" is an eephus. Longer
 * phrases claim their words first — "deep in the hole" is the infield, and
 * its "deep" is not read again — and of the depths left the deepest wins:
 * "a bloop single to shallow center" is shallow.
 */
export function depthSaid(transcript: string): Depth | undefined {
  return deepestOf(depthsSaid(transcript))
}

/**
 * The depth a ball ends with: the deepest the words say, when the model
 * gave none or gave one of theirs — "a bloop single to shallow center" is
 * shallow, though the model read the bloop — and otherwise the model's
 * own, over words that may not be about the ball.
 */
export function depthOf(
  transcript: string,
  model: Depth | undefined
): Depth | undefined {
  const said = depthsSaid(transcript)
  return model == null || said.has(model) ? (deepestOf(said) ?? model) : model
}

/**
 * The deepest of some depths, by their order — fixed, whatever the fence:
 * past a base is deeper than the infield, short of a bloop.
 */
function deepestOf(said: ReadonlySet<Depth>): Depth | undefined {
  let deepest: Depth | undefined
  for (const depth of said)
    if (deepest == null || DEPTHS.indexOf(depth) > DEPTHS.indexOf(deepest))
      deepest = depth
  return deepest
}

/** Every depth phrase, longest first, each with its pattern. */
const PHRASES = DEPTHS.flatMap(depth =>
  DEPTH_WORDS[depth].map(phrase => ({
    depth,
    phrase,
    pattern: new RegExp(`\\b${escape(phrase)}\\b`, 'g')
  }))
).sort((a, b) => b.phrase.length - a.phrase.length)

/** Every depth a sentence says of its ball. */
function depthsSaid(transcript: string): Set<Depth> {
  // A recogniser's curly apostrophe is the phrases' straight one.
  const text = transcript.toLowerCase().replace(/’/g, "'")
  const words = [...text.matchAll(/[a-z'-]+/g)].map(match => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length
  }))
  const claimed: Array<[number, number]> = []
  const said = new Set<Depth>()
  for (const { depth, phrase, pattern } of PHRASES)
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      const end = start + phrase.length
      if (claimed.some(([from, to]) => start < to && end > from)) continue
      claimed.push([start, end])
      const first = words.findIndex(word => word.end > start)
      const last = words.findLastIndex(word => word.start < end)
      // "Holds up short of third", "the throw sails past first": a base a
      // runner or a throw reached says nothing of the ball.
      if (
        (depth === 'shy_of_base' || depth === 'past_base') &&
        !theBalls(text, start)
      )
        continue
      // "Deep in the count" is the batter's.
      if (phrase === 'deep' && /^\s+in\s+the\s+count\b/.test(text.slice(end)))
        continue
      const near = [
        ...words.slice(Math.max(0, first - 2), first),
        ...words.slice(first, last + 1),
        ...words.slice(last + 1, last + 3)
      ]
      // "A blooper pitch" is the pitch, not the ball; "deep enough" to tag
      // up is the runner's.
      if (words[last + 1]?.word === 'pitch') continue
      if (phrase === 'deep' && words[last + 1]?.word === 'enough') continue
      // "Down 0-2, in the hole" is the count.
      if (
        phrase === 'in the hole' &&
        COUNT.test(text.slice(Math.max(0, start - 24), end + 24))
      )
        continue
      if (near.some(({ word }) => DEPTH_ANCHORS.includes(word))) said.add(depth)
    }
  return said
}

/** Words of a count, near "in the hole": the batter behind, not the ball. */
const COUNT = /\b\d\s*[-–]\s*\d\b|\bcount\b|\bbehind\b|\bstrikes?\b/

/**
 * The base a ball's own depth phrase names — "just shy of first", "past
 * third" — never the base of a throw or a runner.
 */
export function baseSaid(transcript: string): BaseName | undefined {
  for (const match of transcript.matchAll(
    /\b(?:shy of|short of|past|beyond)\s+(first|second|third)\b/gi
  ))
    if (theBalls(transcript.toLowerCase(), match.index))
      return match[1].toLowerCase() as BaseName
  return undefined
}

/**
 * Whether a base phrase at `start` is the ball's, by the clause it is in: a
 * batted ball's word before it makes it the ball's ("ground ball goes past
 * first"), and a runner's or a throw's word otherwise does not ("Jones
 * pulls up short of third", "the throw sails past first").
 */
function theBalls(text: string, start: number): boolean {
  const clause =
    text
      .slice(0, start)
      .split(/[.,;!?]|\band\b/)
      .at(-1) ?? ''
  const words = clause.match(/[a-z'-]+/g) ?? []
  if (words.some(word => BALL_WORDS.has(word))) return true
  return !words.some(word => NOT_THE_BALL.has(word))
}

/** A batted ball's own words. */
const BALL_WORDS: ReadonlySet<string> = new Set([
  'ball',
  'grounder',
  'roller',
  'chopper',
  'hopper',
  'one-hopper',
  'liner',
  'drive',
  'hit',
  'bunt',
  'fly',
  'pop',
  'popup',
  'bloop',
  'blooper',
  'dribbler',
  'nubber',
  'squibber',
  'tapper',
  'trickler',
  'single',
  'double',
  'triple',
  'foul',
  'shot',
  'rope'
])

/** A runner's or a throw's words: "holds", "pulls up", "sails". */
const NOT_THE_BALL: ReadonlySet<string> = new Set([
  'runner',
  'runners',
  'holds',
  'held',
  'pulls',
  'pulled',
  'caught',
  'rundown',
  'out',
  'stops',
  'stopped',
  'goes',
  'went',
  'slides',
  'safe',
  'tagged',
  'throw',
  'throws',
  'thrown',
  'sails',
  'sailed',
  'relay'
])

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
