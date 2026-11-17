/**
 * How Search ranks a candidate against what was typed, before any model has
 * a say: the lexicographic answer the search socket sends at once, and the
 * order Jev's ties fall back to.
 *
 * Every word is folded as `ts_name_fold` folds it in SQL, so the database's
 * prefilter and this ranking agree on what matches: `José` is found by
 * `jose`.
 */

/**
 * The letters `unaccent` rewrites that have no combining-mark form, so NFD
 * leaves them whole: Latin-1 and Latin Extended-A, lower case (a capital is
 * lowered first). `ø` is `o`, `ß` is `ss`, as `ts_name_fold` makes them.
 */
const UNACCENT_LETTERS: Readonly<Record<string, string>> = {
  æ: 'ae',
  ð: 'd',
  ø: 'o',
  þ: 'th',
  ß: 'ss',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ĳ: 'ij',
  ĸ: 'q',
  ŀ: 'l',
  ł: 'l',
  ŉ: "'n",
  ŋ: 'n',
  œ: 'oe',
  ŧ: 't',
  ſ: 's'
}

const UNACCENT_PATTERN = new RegExp(
  `[${Object.keys(UNACCENT_LETTERS).join('')}]`,
  'gu'
)

/**
 * The marks `unaccent` rewrites as an apostrophe: the curly quotes a phone's
 * smart punctuation types, the modifier-letter apostrophes and ʻokina, the
 * prime and the fullwidth apostrophe. `O’Brien` and `O'Brien` fold alike.
 * The rest of the punctuation it rewrites only ever splits words.
 */
const UNACCENT_APOSTROPHES =
  /[\u2018\u2019\u201b\u2032\uff07\u02b9\u02bb\u02bc\u02bd\u02c8]/gu

/** Lower case, with no accents: what `ts_name_fold` makes of a name. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(UNACCENT_PATTERN, letter => UNACCENT_LETTERS[letter] ?? letter)
    .replace(UNACCENT_APOSTROPHES, "'")
}

/**
 * The folded words of a text: split on whitespace and on punctuation, but
 * never on an apostrophe, so `O'Neil` and `O’Neil` stay one word.
 */
export function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}']+/u)
    .filter(word => word !== '')
}

/** How one typed word met the field word it took. */
export type MatchKind = 'perfect' | 'prefix' | 'substring'

const KIND_POINTS: Record<MatchKind, number> = {
  perfect: 3,
  prefix: 2,
  substring: 1
}

/** The words a candidate can be found by. */
export interface MatchFields {
  /** The name's words. */
  name: readonly string[]
  /** For an organization, its city's, region's and country's words. */
  place?: readonly string[]
}

/** How well a candidate matches the typed words. */
export interface MatchScore {
  /** How many typed words matched a field word. */
  matched: number
  /** The sum of the match kinds: perfect 3, prefix 2, substring 1. */
  points: number
  /**
   * The name characters the typed words matched, over all of the name's
   * characters: 0 to 1.
   */
  coverage: number
  /** Each typed word's match, in typed order; null for one that matched none. */
  words: Array<MatchKind | null>
}

function kindOf(typed: string, word: string): MatchKind | null {
  if (typed === word) return 'perfect'
  if (word.startsWith(typed)) return 'prefix'
  if (word.includes(typed)) return 'substring'
  return null
}

/**
 * Score one candidate. Each typed word, in order, takes the best field word
 * no earlier typed word took: a perfect match over a prefix over a
 * substring, a name word over a place word at the same kind, then the first.
 */
export function matchScore(
  typed: readonly string[],
  fields: MatchFields
): MatchScore {
  const all = [
    ...fields.name.map(word => ({ word, name: true })),
    ...(fields.place ?? []).map(word => ({ word, name: false }))
  ]
  const used = new Set<number>()
  const words: Array<MatchKind | null> = []
  let matched = 0
  let points = 0
  let covered = 0
  for (const each of typed) {
    let best = -1
    let bestKind: MatchKind | null = null
    for (let i = 0; i < all.length; ++i) {
      if (used.has(i)) continue
      const kind = kindOf(each, all[i].word)
      if (kind == null) continue
      if (bestKind == null || KIND_POINTS[kind] > KIND_POINTS[bestKind]) {
        best = i
        bestKind = kind
      }
    }
    words.push(bestKind)
    if (bestKind == null) continue
    used.add(best)
    matched += 1
    points += KIND_POINTS[bestKind]
    if (all[best].name) covered += each.length
  }
  const length = fields.name.reduce((sum, word) => sum + word.length, 0)
  return {
    matched,
    points,
    coverage: length === 0 ? 0 : covered / length,
    words
  }
}

/** Anything Search can rank by name. */
export interface Matchable {
  id: string
  /** The name the reader is shown. */
  name: string
  /** For an organization, its city, region and country, unfolded. */
  place?: ReadonlyArray<string | null | undefined>
}

/** A candidate with its score. */
export interface ScoredMatch<T extends Matchable> {
  candidate: T
  score: MatchScore
}

/** The fields a candidate is matched on: its name's words and its place's. */
export function fieldsOf(candidate: Matchable): MatchFields {
  return {
    name: wordsOf(candidate.name),
    place: (candidate.place ?? []).flatMap(text =>
      text == null ? [] : wordsOf(text)
    )
  }
}

/** Score a candidate, or null when no typed word matched it. */
export function scoreMatch<T extends Matchable>(
  candidate: T,
  typed: readonly string[]
): ScoredMatch<T> | null {
  const score = matchScore(typed, fieldsOf(candidate))
  return score.matched === 0 ? null : { candidate, score }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The lexicographic order, best first: more typed words matched, then more
 * points, then more of the name covered, then a shorter name, then by name,
 * then by id.
 */
export function compareMatches<T extends Matchable>(
  a: ScoredMatch<T>,
  b: ScoredMatch<T>
): number {
  const order = [
    b.score.matched - a.score.matched,
    b.score.points - a.score.points,
    b.score.coverage - a.score.coverage,
    a.candidate.name.length - b.candidate.name.length,
    compareText(fold(a.candidate.name), fold(b.candidate.name)),
    compareText(a.candidate.name, b.candidate.name),
    compareText(a.candidate.id, b.candidate.id)
  ]
  return order.find(step => step !== 0) ?? 0
}

/**
 * The first `n` candidates in the lexicographic order, scored. A candidate
 * no typed word matched is never among them.
 */
export function lexicographicTop<T extends Matchable>(
  candidates: readonly T[],
  typed: readonly string[],
  n: number
): Array<ScoredMatch<T>> {
  const scored: Array<ScoredMatch<T>> = []
  for (const candidate of candidates) {
    const match = scoreMatch(candidate, typed)
    if (match != null) scored.push(match)
  }
  return scored.sort(compareMatches).slice(0, Math.max(0, n))
}
