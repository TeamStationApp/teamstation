import { asArray, asNumber, asObject, asString } from 'cleaners'
import { deflateSync, inflateSync } from 'fflate'
import { base64 } from 'rfc4648'

import { utf8 } from '../walkup/localFileId'

/**
 * GameChanger's lineup QR code, which its "Share your lineup" shows and its
 * "Scan lineup" reads. The code's text is base64 (standard, padded) of raw
 * DEFLATE (no zlib header) of this JSON. GameChanger ignores the ids when it
 * imports, but refuses a code whose ids are not UUIDs.
 *
 * Position codes: 1 1B, 2 2B, 3 3B, 4 P, 5 C, 6 CF, 7 LF, 8 RF, 9 Roamer,
 * 10 SS, 11 EH, 12 DH. 100 + X is a player who fields X while a DH bats for
 * him. Bench players are not in the code.
 */
export interface GameChangerLineup {
  /** The game's id. */
  e: string
  /** The team's id. */
  t: string
  /** The batters, leadoff first. */
  h: GameChangerPlayer[]
  /** The fielders who do not bat. */
  n: GameChangerPlayer[]
}

export interface GameChangerPlayer {
  i: string
  f: string
  l: string
  /** The jersey number, as text. */
  n: string
  p: number
}

export type LineupQrErrorReason = 'notLineup' | 'wrongShape' | 'empty'

/** Why a scanned code is not a lineup this app can import. */
export class LineupQrError extends Error {
  readonly reason: LineupQrErrorReason
  constructor(reason: LineupQrErrorReason) {
    super(`Lineup QR code: ${reason}`)
    this.name = 'LineupQrError'
    this.reason = reason
  }
}

const asPlayer = asObject({
  i: asString,
  f: asString,
  l: asString,
  n: asString,
  p: asNumber
})
const asLineup = asObject({
  e: asString,
  t: asString,
  h: asArray(asPlayer),
  n: asArray(asPlayer)
})

/** The QR text of a lineup. */
export function encodeLineupQr(lineup: GameChangerLineup): string {
  const player = ({ i, f, l, n, p }: GameChangerPlayer): GameChangerPlayer => ({
    i,
    f,
    l,
    n,
    p
  })
  const json = JSON.stringify({
    e: lineup.e,
    t: lineup.t,
    h: lineup.h.map(player),
    n: lineup.n.map(player)
  })
  return base64.stringify(deflateSync(utf8(json), { level: 9 }))
}

/** The lineup in a QR code's text, or a `LineupQrError` saying why not. */
export function decodeLineupQr(text: string): GameChangerLineup {
  let json: unknown
  try {
    json = JSON.parse(fromUtf8(inflateSync(base64.parse(text.trim()))))
  } catch {
    throw new LineupQrError('notLineup')
  }
  let lineup: GameChangerLineup
  try {
    lineup = asLineup(json)
  } catch {
    throw new LineupQrError('wrongShape')
  }
  const players = [...lineup.h, ...lineup.n]
  if (players.length === 0) throw new LineupQrError('empty')
  if (players.some(p => p.f.trim() === '' && p.l.trim() === ''))
    throw new LineupQrError('wrongShape')
  return lineup
}

/**
 * Text from UTF-8, without `TextDecoder`, which the phone's type library does
 * not name. Refuses a malformed sequence rather than guess at it.
 */
export function fromUtf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i]
    const length =
      byte < 0x80
        ? 1
        : byte >> 5 === 6
          ? 2
          : byte >> 4 === 14
            ? 3
            : byte >> 3 === 30
              ? 4
              : 0
    if (length === 0 || i + length > bytes.length)
      throw new Error('Malformed UTF-8')
    let code = length === 1 ? byte : byte & (0x7f >> length)
    for (let k = 1; k < length; k++) {
      const next = bytes[i + k]
      if (next >> 6 !== 2) throw new Error('Malformed UTF-8')
      code = (code << 6) | (next & 63)
    }
    out += String.fromCodePoint(code)
    i += length
  }
  return out
}
