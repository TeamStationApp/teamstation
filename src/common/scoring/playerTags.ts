import { type Position, POSITIONS } from './state'

/**
 * How a dictation model names a player: by a tag of two letters and a digit,
 * `KT4`, and never by his tag slot. The game it reads writes the tag after
 * the player's name and jersey, `(tag KT4)`. A bare number in a sentence about a
 * ball game is a base, a count, a jersey or a position, and a model handed
 * players by number took one for another: a steal of third went to the
 * runner whose id was 3. A tag reads as none of them.
 *
 * The tag is a fixed function of the id, and reversible, so the server reads
 * a tag back with nothing from the client but the game it already sends. The
 * digit is the id's last digit; the letters are one of `PAIRS`, which leaves
 * out I and O (they read as 1 and 0), doubled letters, every position, base
 * and baseball abbreviation a scorer might say, and two-letter words. Ids
 * below `PAIRS.length` each get letters of their own, so the players of one
 * game never share a pair, and neighbouring ids get far-apart pairs.
 */

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Letter pairs a tag never uses. */
export const EXCLUDED_PAIRS: readonly string[] = [
  // Positions, bases and the box score.
  ...['SS', 'CF', 'LF', 'RF', 'PH', 'PR', 'DH', 'HR', 'RB', 'BB', 'IP', 'ER'],
  ...['KO', 'OF', 'IF', 'UT', 'PO', 'SB', 'CS', 'WP', 'PB', 'HB', 'FC', 'DP'],
  ...['TP', 'SF', 'SH', 'AB', 'BA', 'OB', 'PA', 'GO', 'FO', 'LD', 'GB', 'FB'],
  ...['BK', 'HP', 'LC', 'RC', 'PU', 'FE', 'TE', 'SA', 'CG', 'SV', 'GS', 'LH'],
  ...['RH', 'TB', 'XB', 'PC', 'RA'],
  // Words.
  ...['AH', 'AM', 'AN', 'AS', 'AT', 'AW', 'AX', 'AY', 'BE', 'BY', 'EH', 'EM'],
  ...['EN', 'EX', 'HA', 'HE', 'HM', 'LA', 'MA', 'ME', 'MY', 'NU', 'PE', 'RE'],
  ...['UH', 'UM', 'UP', 'US', 'WE', 'YA', 'YE']
]

const allowed: string[] = []
for (const first of LETTERS)
  for (const second of LETTERS)
    if (first !== second && !EXCLUDED_PAIRS.includes(first + second))
      allowed.push(first + second)
// A count prime to 10, so an id's pair and its last digit say the id.
let count = allowed.length
while (count % 2 === 0 || count % 5 === 0) count--

/** The letter pairs a tag is made of. */
export const PAIRS: readonly string[] = allowed.slice(0, count)

/** Every id below this has a tag: ten for each pair. */
export const TAGGED_IDS = PAIRS.length * 10

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
// About 0.618 of the way round, so id 1, 2 and 3 land far apart.
let stride = Math.round(PAIRS.length * 0.618)
while (gcd(stride, PAIRS.length) !== 1) stride++

const ids = new Map<string, number>()

/** A player's tag, for his tag slot. Throws past `TAGGED_IDS`. */
export function tagOf(id: number): string {
  if (!Number.isSafeInteger(id) || id < 0 || id >= TAGGED_IDS)
    throw new RangeError(`No tag for player ${id}`)
  return `${PAIRS[(id * stride) % PAIRS.length]}${id % 10}`
}

for (let id = 0; id < TAGGED_IDS; id++) ids.set(tagOf(id), id)

/** The tag slot a tag names, or undefined for anything that is not a tag. */
export function idOfTag(tag: string): number | undefined {
  return ids.get(tag.trim().toUpperCase())
}

/** A tag as the game a model reads writes it. */
const WRITTEN = /\(tag ([A-Z]{2}[0-9])\)/g

/**
 * The tag slot of the tag a model wrote for a player: the tag alone, or
 * the one tag among other words written as the game writes it ("Marte #5
 * (tag KD0)", copied from the game). Anything else names nobody.
 */
export function idOfWrittenTag(text: string): number | undefined {
  const alone = idOfTag(text)
  if (alone != null) return alone
  const written = [...text.matchAll(WRITTEN)]
  return written.length === 1 ? idOfTag(written[0][1]) : undefined
}

/** How a tag is written in the game a model reads: `(tag KT4)`. */
export function writeTag(tag: string): string {
  return `(tag ${tag})`
}

/** A player's tag as the game a model reads writes it. */
export function writtenTag(id: number): string {
  return writeTag(tagOf(id))
}

/** The ids of the players a game written for a model gives a tag. */
export function taggedIds(text: string): Set<number> {
  const found = new Set<number>()
  for (const match of text.matchAll(WRITTEN)) {
    const id = idOfTag(match[1])
    if (id != null) found.add(id)
  }
  return found
}

/**
 * The fielder at each position, by tag slot, as a game written for a model
 * lists them: "Fielders: P Max S. #1 (tag QV2), C …". A position played by
 * nobody has none.
 */
export function fieldingIds(text: string): Map<Position, number> {
  const fielding = new Map<Position, number>()
  const line = /^Fielders: (.*)$/m.exec(text)?.[1] ?? ''
  const positions = POSITIONS.join('|')
  // A comma inside a name ("Lee, Jr.") belongs to the name. An entry ends
  // at the comma before the next position.
  const split = new RegExp(`, (?=(?:${positions}) )`)
  const entry = new RegExp(`^(${positions}) .*\\(tag ([A-Z]{2}[0-9])\\)`)
  for (const part of line.split(split)) {
    const match = entry.exec(part.trim())
    if (match == null) continue
    const id = idOfTag(match[2])
    if (id != null) fielding.set(match[1] as Position, id)
  }
  return fielding
}

/** A position as a scorer says it, and so as a model may write it. */
const SPOKEN_POSITIONS: Readonly<Record<string, Position>> = {
  pitcher: 'P',
  catcher: 'C',
  'first baseman': '1B',
  'first base': '1B',
  'second baseman': '2B',
  'second base': '2B',
  shortstop: 'SS',
  'short stop': 'SS',
  'third baseman': '3B',
  'third base': '3B',
  'left fielder': 'LF',
  leftfielder: 'LF',
  'left field': 'LF',
  leftfield: 'LF',
  left: 'LF',
  'center fielder': 'CF',
  centerfielder: 'CF',
  'center field': 'CF',
  centerfield: 'CF',
  center: 'CF',
  'right fielder': 'RF',
  rightfielder: 'RF',
  'right field': 'RF',
  rightfield: 'RF',
  right: 'RF',
  firstbaseman: '1B',
  firstbase: '1B',
  first: '1B',
  '1st baseman': '1B',
  '1st base': '1B',
  '1st': '1B',
  secondbaseman: '2B',
  secondbase: '2B',
  second: '2B',
  '2nd baseman': '2B',
  '2nd base': '2B',
  '2nd': '2B',
  thirdbaseman: '3B',
  thirdbase: '3B',
  third: '3B',
  '3rd baseman': '3B',
  '3rd base': '3B',
  '3rd': '3B'
}

/**
 * The position a model wrote for a fielder in place of his tag: as the game
 * writes it, "LF", or before his name, "LF Mike T.", or as a scorer says it,
 * "the left fielder". A trailing period, a one-word form ("leftfielder")
 * and "left", "center" or "right" alone still name those fielders. An
 * ordinal written there ("3rd", "third") is the fielder at that base.
 * Anything else is no position.
 */
export function positionSaid(text: string): Position | undefined {
  const trimmed = text.trim().replace(/\.+$/g, '').trim()
  const before = POSITION_BEFORE.exec(trimmed)?.[0].trim()
  if (before != null) return before as Position
  const said = trimmed
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\.+$/g, '')
    .replace(/[\s-]+/g, ' ')
    .trim()
  const code = said.toUpperCase()
  return (POSITIONS as readonly string[]).includes(code)
    ? (code as Position)
    : SPOKEN_POSITIONS[said]
}

/** A position written before a fielder's name: "SS Mike T. #27 (tag QV2)". */
const POSITION_BEFORE = new RegExp(`^(?:${POSITIONS.join('|')})\\s+(?=\\S)`)

/**
 * The name a written game gives each tag, by tag: "Mike T." for "Batter: Mike
 * T. #27 (tag QV2)" and for "SS Mike T. #27 (tag QV2)". What the line says
 * before it ("Batter:", a position) and the jersey after it are not his name.
 */
export function taggedNames(text: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const match of text.matchAll(/([^:,\n]*?)\s*\(tag ([A-Z]{2}[0-9])\)/g)) {
    const name = match[1]
      .trim()
      .replace(POSITION_BEFORE, '')
      .replace(/\s*#\S*$/, '')
    if (name !== '' && idOfTag(match[2]) != null && !names.has(match[2]))
      names.set(match[2], name)
  }
  return names
}

/**
 * A tag as a model writes it in a sentence for the scorer: as the game writes
 * it, `(tag KT4)`, in brackets, `(KT4)` or `[KT4]`, or bare, `KT4` or `Kt4`.
 * An old app's id, `(id 7)`, is matched too.
 */
const TAG_IN_TEXT =
  /\s*\(id \d+\)|\(tag ([A-Za-z]{2}[0-9])\)|[[(]([A-Z]{2}[0-9])[\])]|\b([A-Za-z]{2}[0-9])\b/g

const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Text a model wrote for the scorer, as he reads it: each tag made the name
 * of the player `names` gives it (`taggedNames`), and taken out when it names
 * nobody in the game, as an old app's id is. A tag written beside its own
 * name, before it or after it, is taken out: "Mike T. (tag QV2)", "Mike T.
 * #27 QV2" and "QV2 (Mike T.)" are each "Mike T.", once.
 */
export function withNames(
  text: string,
  names: ReadonlyMap<string, string>
): string {
  let out = ''
  let from = 0
  for (const match of text.matchAll(TAG_IN_TEXT)) {
    const at = match.index
    let end = at + match[0].length
    const tag = (match[1] ?? match[2] ?? match[3])?.toUpperCase()
    out += text.slice(from, at)
    from = end
    const name = tag == null ? undefined : names.get(tag)
    // A bare word that only looks like a tag is the scorer's to read: one
    // that is no tag, or not in capitals and of nobody in the game.
    if (
      match[3] != null &&
      (idOfTag(match[3]) == null ||
        (name == null && match[3] !== match[3].toUpperCase()))
    ) {
      out += match[0]
      continue
    }
    if (name == null) {
      out = out.trimEnd()
      continue
    }
    const said = new RegExp(
      `${escaped(name)}(?:\\s*\\(?#\\w+\\)?)?\\s*\\(?$`,
      'i'
    )
    if (said.test(out.trimEnd())) {
      out = out.trimEnd()
      continue
    }
    // "QV2 (Mike T.)" and "QV2 Mike T.": the name that follows stands.
    const following = new RegExp(
      `^\\s*(?:\\(\\s*${escaped(name)}\\s*\\)|${escaped(name)})`,
      'i'
    ).exec(text.slice(end))
    if (following != null) {
      end += following[0].length
      from = end
    }
    out += name
  }
  return (out + text.slice(from)).trim()
}
