import { asUserId } from '../../src/common/userId'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The device event-control wire format, version 2, in Node: the reference
 * the Swift package, the Android app and any other receiver are checked
 * against, through the shared fixtures in
 * `mobile/apps/common/EventControl/Tests/Fixtures`. README.md beside the
 * Swift package is the specification.
 *
 *   frame   = u32be(payloadLength) || payload          1 <= payloadLength <= 4096
 *   payload = version(u8) || type(u8) || field* || mac(32)
 *   field   = u16be(byteLength) || bytes
 *   mac     = HMAC-SHA256(key, lp(FRAME_DOMAIN) || version || type || field*)
 */

export const VERSION = 2
export const PORTS = [47614, 47615]
export const MAX_PAYLOAD = 4096
export const RENEW_MS = 5000
export const LEASE_MS = 15000
export const FRAME_DOMAIN = 'device-event-control:v2:frame'
export const MAX_GAME_ID_BYTES = 128
export const MAX_TITLE_BYTES = 256

export const MESSAGE_TYPES = {
  discover: 1,
  announce: 2,
  assign: 3,
  ack: 4,
  renew: 5,
  release: 6
} as const
export type MessageType = keyof typeof MESSAGE_TYPES

export const ACK_STATUSES = [
  'applied',
  'disabled',
  'wrongAccount',
  'busy',
  'unsupported',
  'invalid',
  'stale',
  'expired',
  'failed',
  'keyMismatch'
] as const
export type AckStatus = (typeof ACK_STATUSES)[number]

export const LEASE_STATES = ['free', 'heldBySender', 'heldByOther'] as const
export type LeaseState = (typeof LEASE_STATES)[number]

export interface Header {
  /** 16 bytes. */
  sender: Buffer
  requestId: bigint
  /** 16 bytes. */
  accountTag: Buffer
  /** 8 bytes. */
  keyId: Buffer
  /** 16 bytes. */
  challenge: Buffer
  /** Empty or 16 bytes. */
  receiverNonce: Buffer
}

export type Body =
  | { type: 'discover' }
  | {
      type: 'announce'
      consent: boolean
      lease: LeaseState
      leaseRevision: bigint
    }
  | {
      type: 'assign'
      revision: bigint
      gameId: string
      title: string
      startAt: string
    }
  | { type: 'ack'; status: AckStatus; revision: bigint }
  | { type: 'renew'; revision: bigint }
  | { type: 'release'; revision: bigint }

export interface Message {
  header: Header
  body: Body
}

export interface Decoded {
  message: Message
  /** Version, type and fields: what the MAC covers after the domain. */
  signed: Buffer
  mac: Buffer
}

export type CodecErrorCode =
  | 'tooLarge'
  | 'tooShort'
  | 'unsupportedVersion'
  | 'unknownType'
  | 'truncated'
  | 'fieldTooLong'
  | 'badFieldLength'
  | 'trailingBytes'
  | 'badValue'
  | 'badUTF8'

export class CodecError extends Error {
  readonly code: CodecErrorCode
  /** The field, for errors about one; the byte, for version and type. */
  readonly index?: number

  constructor(code: CodecErrorCode, index?: number) {
    super(index == null ? code : `${code}(${index})`)
    this.code = code
    this.index = index
  }
}

// ---------------------------------------------------------------------------
// Bytes

/** `u16be(byteLength) || bytes` for each part. */
export function lengthPrefixed(parts: Array<Buffer | string>): Buffer {
  const out: Buffer[] = []
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part
    if (bytes.length > 0xffff) throw new Error('a field is over 65535 bytes')
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length)
    out.push(length, bytes)
  }
  return Buffer.concat(out)
}

export function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export function random(bytes: number): Buffer {
  return randomBytes(bytes)
}

// ---------------------------------------------------------------------------
// Encoding

interface FieldSpec {
  min: number
  max: number
  only?: number[]
}

const exact = (n: number): FieldSpec => ({ min: n, max: n })

const HEADER_SPECS: FieldSpec[] = [
  exact(16),
  exact(8),
  exact(16),
  exact(8),
  exact(16),
  { min: 0, max: 16, only: [0, 16] }
]

const BODY_SPECS: Record<MessageType, FieldSpec[]> = {
  discover: [],
  announce: [exact(1), exact(1), exact(8)],
  assign: [
    exact(8),
    { min: 1, max: MAX_GAME_ID_BYTES },
    { min: 1, max: MAX_TITLE_BYTES },
    exact(20)
  ],
  ack: [exact(1), exact(8)],
  renew: [exact(8)],
  release: [exact(8)]
}

export function signedBytes(message: Message): Buffer {
  const { header, body } = message
  const fields: Buffer[] = [
    header.sender,
    u64(header.requestId),
    header.accountTag,
    header.keyId,
    header.challenge,
    header.receiverNonce
  ]
  switch (body.type) {
    case 'discover':
      break
    case 'announce':
      fields.push(
        Buffer.from([body.consent ? 1 : 0]),
        Buffer.from([LEASE_STATES.indexOf(body.lease)]),
        u64(body.leaseRevision)
      )
      break
    case 'assign':
      fields.push(
        u64(body.revision),
        Buffer.from(body.gameId, 'utf8'),
        Buffer.from(body.title, 'utf8'),
        Buffer.from(body.startAt, 'utf8')
      )
      break
    case 'ack':
      fields.push(
        Buffer.from([ACK_STATUSES.indexOf(body.status)]),
        u64(body.revision)
      )
      break
    case 'renew':
    case 'release':
      fields.push(u64(body.revision))
      break
  }
  return Buffer.concat([
    Buffer.from([VERSION, MESSAGE_TYPES[body.type]]),
    lengthPrefixed(fields)
  ])
}

export function mac(signed: Buffer, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(lengthPrefixed([FRAME_DOMAIN]))
    .update(signed)
    .digest()
}

/** The signed payload for `message`. */
export function encode(message: Message, key: Buffer): Buffer {
  const signed = signedBytes(message)
  return Buffer.concat([signed, mac(signed, key)])
}

/** A payload with its four-byte length in front. */
export function frame(payload: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  return Buffer.concat([length, payload])
}

// ---------------------------------------------------------------------------
// Decoding

const TYPE_NAMES = new Map<number, MessageType>(
  Object.entries(MESSAGE_TYPES).map(([name, value]) => [
    value,
    name as MessageType
  ])
)

/** Takes a payload apart, checking each length before reading its bytes. */
export function decode(payload: Buffer): Decoded {
  if (payload.length > MAX_PAYLOAD) throw new CodecError('tooLarge')
  if (payload.length < 2) throw new CodecError('tooShort')
  if (payload[0] !== VERSION)
    throw new CodecError('unsupportedVersion', payload[0])
  const type = TYPE_NAMES.get(payload[1])
  if (type == null) throw new CodecError('unknownType', payload[1])
  if (payload.length < 2 + 32) throw new CodecError('tooShort')
  const end = payload.length - 32
  let at = 2
  const fields: Buffer[] = []
  const specs = [...HEADER_SPECS, ...BODY_SPECS[type]]
  specs.forEach((spec, index) => {
    if (end - at < 2) throw new CodecError('truncated')
    const length = payload.readUInt16BE(at)
    if (length > spec.max) throw new CodecError('fieldTooLong', index)
    if (end - at - 2 < length) throw new CodecError('truncated')
    if (length < spec.min || (spec.only != null && !spec.only.includes(length)))
      throw new CodecError('badFieldLength', index)
    fields.push(payload.subarray(at + 2, at + 2 + length))
    at += 2 + length
  })
  if (at !== end) throw new CodecError('trailingBytes')

  const header: Header = {
    sender: fields[0],
    requestId: fields[1].readBigUInt64BE(),
    accountTag: fields[2],
    keyId: fields[3],
    challenge: fields[4],
    receiverNonce: fields[5]
  }
  return {
    message: { header, body: decodeBody(type, fields.slice(6)) },
    signed: payload.subarray(0, end),
    mac: payload.subarray(end)
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

function decodeBody(type: MessageType, fields: Buffer[]): Body {
  const text = (offset: number): string => {
    try {
      return UTF8.decode(fields[offset])
    } catch {
      throw new CodecError('badUTF8', 6 + offset)
    }
  }
  switch (type) {
    case 'discover':
      return { type }
    case 'announce': {
      if (fields[0][0] > 1) throw new CodecError('badValue', 6)
      const lease = LEASE_STATES[fields[1][0]]
      if (lease == null) throw new CodecError('badValue', 7)
      return {
        type,
        consent: fields[0][0] === 1,
        lease,
        leaseRevision: fields[2].readBigUInt64BE()
      }
    }
    case 'assign':
      return {
        type,
        revision: fields[0].readBigUInt64BE(),
        gameId: text(1),
        title: text(2),
        startAt: text(3)
      }
    case 'ack': {
      const status = ACK_STATUSES[fields[0][0]]
      if (status == null) throw new CodecError('badValue', 6)
      return { type, status, revision: fields[1].readBigUInt64BE() }
    }
    case 'renew':
    case 'release':
      return { type, revision: fields[0].readBigUInt64BE() }
  }
}

/** Whether `key` made the MAC, compared in constant time. */
export function isAuthentic(decoded: Decoded, key: Buffer): boolean {
  return constantTimeEqual(mac(decoded.signed, key), decoded.mac)
}

export function isFromDirector(type: MessageType): boolean {
  return (
    type === 'discover' ||
    type === 'assign' ||
    type === 'renew' ||
    type === 'release'
  )
}

/** Splits a byte stream into payloads; an oversized length throws at once. */
export class FrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: Buffer[] = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_PAYLOAD) throw new CodecError('tooLarge')
      if (length === 0) throw new CodecError('tooShort')
      if (this.buffer.length < 4 + length) break
      out.push(this.buffer.subarray(4, 4 + length))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Assignments

export interface Assignment {
  gameId: string
  title: string
  startAt: string
}

export type AssignmentProblem =
  | 'emptyGameId'
  | 'gameIdTooLong'
  | 'untrimmedGameId'
  | 'emptyTitle'
  | 'titleTooLong'
  | 'untrimmedTitle'
  | 'badStartAt'

export class AssignmentError extends Error {
  readonly problem: AssignmentProblem
  constructor(problem: AssignmentProblem) {
    super(problem)
    this.problem = problem
  }
}

const BLANK = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g

/** Trims ASCII space, tab, LF, VT, FF and CR only. */
export function trimmed(text: string): string {
  return text.replace(BLANK, '')
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** `YYYY-MM-DDTHH:MM:SSZ`, rounded down to the second. */
export function formatStartAt(date: Date): string {
  const whole = new Date(Math.floor(date.getTime() / 1000) * 1000)
  return whole.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** The date a canonical start time names, or undefined. */
export function parseStartAt(text: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) return undefined
  const date = new Date(text)
  if (Number.isNaN(date.getTime()) || formatStartAt(date) !== text)
    return undefined
  return date
}

/**
 * The assignment for a selected event. Game ID and title trimmed; an empty
 * or over-long game ID refused; a title over 256 bytes cut at the last whole
 * character that fits.
 */
export function buildAssignment(
  gameId: string,
  title: string,
  startAt: Date
): Assignment {
  const id = trimmed(gameId)
  if (id === '') throw new AssignmentError('emptyGameId')
  if (byteLength(id) > MAX_GAME_ID_BYTES)
    throw new AssignmentError('gameIdTooLong')
  let label = trimmed(title)
  if (label === '') throw new AssignmentError('emptyTitle')
  const characters = [...new Intl.Segmenter().segment(label)].map(
    part => part.segment
  )
  while (byteLength(label) > MAX_TITLE_BYTES) {
    characters.pop()
    label = characters.join('')
  }
  return { gameId: id, title: trimmed(label), startAt: formatStartAt(startAt) }
}

/** An assignment exactly as received, refused unless already canonical. */
export function wireAssignment(
  gameId: string,
  title: string,
  startAt: string
): Assignment {
  if (gameId === '') throw new AssignmentError('emptyGameId')
  if (byteLength(gameId) > MAX_GAME_ID_BYTES)
    throw new AssignmentError('gameIdTooLong')
  if (trimmed(gameId) !== gameId) throw new AssignmentError('untrimmedGameId')
  if (title === '') throw new AssignmentError('emptyTitle')
  if (byteLength(title) > MAX_TITLE_BYTES)
    throw new AssignmentError('titleTooLong')
  if (trimmed(title) !== title) throw new AssignmentError('untrimmedTitle')
  if (parseStartAt(startAt) == null) throw new AssignmentError('badStartAt')
  return { gameId, title, startAt }
}

// ---------------------------------------------------------------------------
// Credentials

/** A device's key, as `GET /api/v1/device-event-control/key` answers it. */
export interface Credentials {
  issuer: string
  userId: string
  accountTag: string
  keyId: string
  key: string
}

/** Raw bytes of a credential, for the wire. */
export interface KeyBytes {
  key: Buffer
  accountTag: Buffer
  keyId: Buffer
}

const lowerHex = (text: unknown, bytes: number): boolean =>
  typeof text === 'string' &&
  text.length === bytes * 2 &&
  /^[0-9a-f]+$/.test(text)

/** Checks the server's reply and returns it as credentials. */
export function asCredentials(raw: unknown): Credentials {
  const value = raw as Record<string, unknown>
  if (value == null || typeof value !== 'object')
    throw new Error('not a key reply')
  if (value.version !== 2)
    throw new Error('unsupported key version')
  const userId = value.userId
  if (typeof value.issuer !== 'string' || value.issuer === '')
    throw new Error('bad issuer')
  let canonical: string
  try { canonical = asUserId(userId) } catch { throw new Error('bad userId') }
  if (!lowerHex(value.accountTag, 16)) throw new Error('bad accountTag')
  if (!lowerHex(value.keyId, 8)) throw new Error('bad keyId')
  if (!lowerHex(value.key, 32)) throw new Error('bad key')
  return {
    issuer: value.issuer,
    userId: canonical,
    accountTag: value.accountTag as string,
    keyId: value.keyId as string,
    key: value.key as string
  }
}

export function keyBytes(credentials: Credentials): KeyBytes {
  return {
    key: Buffer.from(credentials.key, 'hex'),
    accountTag: Buffer.from(credentials.accountTag, 'hex'),
    keyId: Buffer.from(credentials.keyId, 'hex')
  }
}

/** A message in plain words for a log line: hex for bytes, strings for numbers. */
export function describe(message: Message): Record<string, unknown> {
  const { header, body } = message
  const out: Record<string, unknown> = {
    type: body.type,
    sender: header.sender.toString('hex'),
    requestId: header.requestId.toString(),
    accountTag: header.accountTag.toString('hex'),
    keyId: header.keyId.toString('hex'),
    challenge: header.challenge.toString('hex'),
    receiverNonce: header.receiverNonce.toString('hex')
  }
  for (const [name, value] of Object.entries(body)) {
    if (name === 'type') continue
    out[name] = typeof value === 'bigint' ? value.toString() : value
  }
  return out
}
