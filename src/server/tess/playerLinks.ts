import { asUserId } from '../../common/userId'
import type { StoredBlock } from './conversation'

/**
 * Every player Tess names is a link to their profile. Her instructions say
 * so; this makes it hold where she forgets, when the app is shown her reply.
 * The stored conversation is never changed: only what the app reads.
 *
 * Who is who comes from what the API answered her in the conversation: each
 * JSON object with a `userId` and a name (`name`, `displayName` or
 * `shortName`) is a person, and a player when it says so. A roster or
 * people-list entry is one in the `player` section; an entry listed for
 * another part (an admin, staff, family, a spectator, a follower) is not,
 * since only a player has a profile to open. Another object with `isPlayer`
 * is one when it is true. Without either, a player is a stat line or a
 * listed player (an object under `batting`, `pitching`, `players`,
 * `batters` or `lineup`), or a player's own read, which carries how they bat
 * or throw. Only players' names link, and a name two people share, a player
 * and anyone else included, links nobody.
 */

/** A name and the profile it links to. */
export type PlayerNames = ReadonlyMap<string, string>

const NAME_FIELDS = ['name', 'displayName', 'shortName'] as const

/** The keys whose objects are players: stat lines and player lists. */
const PLAYER_KEYS: ReadonlySet<string> = new Set([
  'batting',
  'pitching',
  'players',
  'batters',
  'lineup'
])

/** Whether a person's `record` is a player's, `listed` under a player key. */
function isPlayerRecord(
  record: Record<string, unknown>,
  listed: boolean
): boolean {
  if (typeof record.section === 'string')
    return record.section === 'player' && record.isPlayer !== false
  if (typeof record.isPlayer === 'boolean') return record.isPlayer
  return listed || 'bats' in record || 'throws' in record
}

/** The names the conversation's API answers carry, by name. */
export function playerNamesOf(
  messages: ReadonlyArray<{ content: readonly StoredBlock[] }>
): PlayerNames {
  // Every person's names, null for one two people share; the players'.
  const found = new Map<string, string | null>()
  const playing = new Map<string, string>()
  const visit = (value: unknown, listed: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, listed)
      return
    }
    if (value == null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const userId = userIdOf(record.userId)
    if (userId != null) {
      const player = isPlayerRecord(record, listed)
      for (const field of NAME_FIELDS) {
        const name = record[field]
        if (typeof name !== 'string' || name.trim().length < 2) continue
        const known = found.get(name.trim())
        found.set(
          name.trim(),
          known === undefined || known === userId ? userId : null
        )
        if (player) playing.set(name.trim(), userId)
      }
    }
    for (const [key, child] of Object.entries(record))
      visit(child, PLAYER_KEYS.has(key))
  }
  for (const message of messages)
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.is_error === true) continue
      const texts =
        typeof block.content === 'string'
          ? [block.content]
          : block.content.flatMap(part =>
              part.type === 'text' ? [part.text] : []
            )
      for (const text of texts) visit(answerBody(text), false)
    }
  // Only names of two or more words, as the app writes them ("Jordan P"): a
  // one-word name ("Will", "Max") is also an ordinary word, so linking it
  // would link prose; Tess links those herself from the userId.
  const names = new Map<string, string>()
  for (const [name, userId] of playing)
    if (found.get(name) === userId && /\S\s+\S/.test(name))
      names.set(name, userId)
  return names
}

/** An API answer's JSON, after its `HTTP 200` line; nothing when it is cut. */
function answerBody(text: string): unknown {
  const body = text.startsWith('HTTP ')
    ? text.slice(text.indexOf('\n') + 1)
    : text
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function userIdOf(value: unknown): string | undefined {
  try {
    return asUserId(value)
  } catch {
    return undefined
  }
}

/**
 * What is left as it is: fenced code, indented code after a blank line (not
 * a nested list's items), code spans, links and images with their reference
 * definitions, bare addresses, comments, the HTML elements that hold text
 * (tables, charts, code, links) whole, and any other tag.
 */
const UNTOUCHED = new RegExp(
  [
    String.raw`^ {0,3}(\x60{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n {0,3}\1[^\n]*|(?![\s\S]))|(?![\s\S]))`,
    String.raw`(?<=^\n)(?:(?: {4}|\t)(?![ \t]*(?:[-*+]|\d+[.)])[ \t])[^\n]*(?:\n|(?![\s\S])))+`,
    String.raw`(\x60+)[\s\S]*?\2`,
    String.raw`^ {0,3}\[[^\]\n]+\]:[^\n]*`,
    String.raw`!?\[(?:[^[\]\n]|\[[^\]\n]*\])*\](?:\([^)\n]*\)|\[[^\]\n]*\])?`,
    String.raw`<!--[\s\S]*?-->`,
    String.raw`<(table|svg|pre|code|a)\b[\s\S]*?<\/\3\s*>`,
    String.raw`<\/?[a-zA-Z][^>\n]*>`,
    String.raw`https?:\/\/[^\s)>\]]+`
  ].join('|'),
  'gimu'
)

/**
 * `text` with each whole-word mention of a name in `names` made a link to
 * that player's profile, the longest name first where names overlap. A word
 * is letters and digits: an underscore is Markdown's emphasis, so
 * `_Tony G_` is linked inside it. What is already a link, code or HTML is
 * left as it is.
 */
export function linkPlayers(text: string, names: PlayerNames): string {
  if (names.size === 0) return text
  const words = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const mention = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`,
    'gu'
  )
  const link = (prose: string): string =>
    prose.replace(
      mention,
      name =>
        `[${name.replace(/[[\]\\]/g, '\\$&')}](/players/${names.get(name)})`
    )
  let out = ''
  let from = 0
  for (const kept of text.matchAll(UNTOUCHED)) {
    out += link(text.slice(from, kept.index)) + kept[0]
    from = kept.index + kept[0].length
  }
  return out + link(text.slice(from))
}
