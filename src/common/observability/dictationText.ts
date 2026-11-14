import { createHash } from 'node:crypto'

/** A printed dictation line, and each part of a longer one, stays under this. */
export const DICTATION_LINE_MAX = 16_000

/** A header field keeps at most this many code points of its value. */
const FIELD_MAX = 128

const TAGS = [
  'dictation-state',
  'dictation-exchange',
  'dictation-prompt',
  'dictation-calls',
  'dictation-reply',
  'dictation-outcome'
] as const

type Tag = (typeof TAGS)[number]

const JSON_TAGS: readonly Tag[] = [
  'dictation-exchange',
  'dictation-prompt',
  'dictation-calls',
  'dictation-reply'
]

export interface DictationDocument {
  I: string
  L: 'info' | 'error'
  C: 'dictation'
  M: string
  tag: Tag
  utterance?: string
  model?: string
  part?: number
  parts?: number
  U?: string
}

/** What a whole line says about itself, before it is printed or split. */
interface Fields {
  tag: Tag
  utterance?: string
  model?: string
  user?: string
  error: boolean
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isUsr(value: string): boolean {
  return /^usr_[A-Za-z0-9_-]{1,96}$/.test(value)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function document(
  line: string,
  id: string,
  fields: Fields,
  part?: { index: number; count: number }
): DictationDocument {
  return {
    I: id,
    L: fields.error ? 'error' : 'info',
    C: 'dictation',
    M: line,
    tag: fields.tag,
    ...(fields.utterance == null ? {} : { utterance: fields.utterance }),
    ...(fields.model == null ? {} : { model: fields.model }),
    ...(part == null ? {} : { part: part.index, parts: part.count }),
    ...(fields.user == null ? {} : { U: fields.user })
  }
}

/** The fields of a whole dictation line of any length, or null. */
function classify(line: string): Fields | null {
  if (line.startsWith('dictation-state ')) {
    const id = line.slice('dictation-state '.length).split(' ')[0]
    if (id == null || id === '') return null
    const model = /(?:^|\s)model=(\S+)/.exec(line)?.[1]
    return { tag: 'dictation-state', utterance: id, model, error: false }
  }
  if (line.startsWith('{')) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return null
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value))
      return null
    const row = value as Record<string, unknown>
    const tag = JSON_TAGS.find(candidate => candidate === row.tag)
    if (tag == null) return null
    return {
      tag,
      utterance:
        typeof row.id === 'string' && row.id !== '' ? row.id : undefined,
      model:
        typeof row.model === 'string' && row.model !== ''
          ? row.model
          : undefined,
      error: row.error != null
    }
  }
  const finish = /^dictation (\S+) model (\S+) user (\S+) ([\s\S]*)$/.exec(line)
  if (finish != null) {
    if (!isUsr(finish[3])) return null
    return {
      tag: 'dictation-outcome',
      utterance: finish[1],
      model: finish[2],
      user: finish[3],
      error:
        finish[4].startsWith('error:') ||
        finish[4].startsWith('recogniser failed')
    }
  }
  const outcome =
    /^dictation (\S+) (asks with |could not authorise:|failed to start:)/.exec(
      line
    )
  if (outcome != null)
    return {
      tag: 'dictation-outcome',
      utterance: outcome[1],
      error: outcome[2] !== 'asks with '
    }
  const socket = /^dictation socket for user (\S+):/.exec(line)
  if (socket != null) {
    if (!isUsr(socket[1])) return null
    return { tag: 'dictation-outcome', user: socket[1], error: true }
  }
  return null
}

/**
 * A part header field: `-` for none, otherwise the first 128 code points,
 * URI-encoded so a space cannot shift the header and `-` stays unambiguous.
 */
function headerField(value: string | undefined): string {
  if (value == null || value === '') return '-'
  const wellFormed = Array.from(value.slice(0, FIELD_MAX * 2))
    .slice(0, FIELD_MAX)
    .join('')
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '�'
    )
  const encoded = encodeURIComponent(wellFormed)
  return encoded === '-' ? '%2D' : encoded
}

/** Undoes `headerField`: undefined for `-`, null when it does not decode. */
function readField(value: string): string | undefined | null {
  if (value === '-') return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const PART =
  /^dictation-part (\d+)\/(\d+) ([0-9a-f]{64}) (info|error) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/

function parsePart(line: string): DictationDocument | null {
  const part = PART.exec(line)
  if (part == null) return null
  const index = Number(part[1])
  const count = Number(part[2])
  if (
    String(index) !== part[1] ||
    String(count) !== part[2] ||
    count < 2 ||
    index >= count
  )
    return null
  const tag = TAGS.find(candidate => candidate === part[5])
  const utterance = readField(part[6])
  const model = readField(part[7])
  const user = readField(part[8])
  if (tag == null || utterance === null || model === null || user === null)
    return null
  if (user != null && !isUsr(user)) return null
  return document(
    line,
    sha256Hex(`${part[3]}/${index}`),
    { tag, utterance, model, user, error: part[4] === 'error' },
    { index, count }
  )
}

/**
 * One printed line, or nothing when the line is not dictation.
 * A user token that is not `usr_…` makes the line not a document.
 * A part's `I` is the hash of the full line's hash and the part index, so it
 * names the source line rather than the header the part was printed with.
 */
export function parseDictationLine(line: string): DictationDocument | null {
  if (
    line.length === 0 ||
    line.length > DICTATION_LINE_MAX ||
    line.includes('\n')
  )
    return null
  if (line.startsWith('dictation-part ')) return parsePart(line)
  const fields = classify(line)
  return fields == null ? null : document(line, sha256Hex(line), fields)
}

/** `message` cut into pieces of at most `room`, never inside a surrogate pair. */
function cut(message: string, room: number): string[] {
  const pieces: string[] = []
  let start = 0
  while (start < message.length) {
    let end = Math.min(start + room, message.length)
    if (end < message.length && isHighSurrogate(message.charCodeAt(end - 1)))
      end -= 1
    pieces.push(message.slice(start, end))
    start = end
  }
  return pieces
}

/**
 * Lines to pass to `console.log`. A message of at most 16,000 characters is
 * unchanged. A longer dictation line becomes `dictation-part` lines, each at
 * most 16,000 characters, whose header carries the full line's hash, level,
 * tag, utterance, model, and user.
 */
export function printLines(message: string): string[] {
  if (message.length <= DICTATION_LINE_MAX) return [message]
  const fields = classify(message)
  if (fields == null) return [message]
  const header = [
    sha256Hex(message),
    fields.error ? 'error' : 'info',
    fields.tag,
    headerField(fields.utterance),
    headerField(fields.model),
    headerField(fields.user)
  ].join(' ')
  let count = 2
  for (;;) {
    // The widest numbering for `count` parts, so every part fits.
    const room =
      DICTATION_LINE_MAX - `dictation-part ${count}/${count} ${header} `.length
    const pieces = cut(message, room)
    if (pieces.length <= count)
      return pieces.map(
        (piece, index) =>
          `dictation-part ${index}/${pieces.length} ${header} ${piece}`
      )
    count = pieces.length
  }
}
