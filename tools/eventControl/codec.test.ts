import { expect } from 'chai'
import { describe, it } from 'mocha'

import { deviceEventControlGrant } from '../../src/server/auth/deviceEventControl'
import {
  ACK_STATUSES,
  asCredentials,
  type Body,
  buildAssignment,
  CodecError,
  decode,
  describe as describeMessage,
  encode,
  formatStartAt,
  frame,
  FrameReader,
  isAuthentic,
  isFromDirector,
  keyBytes,
  LEASE_STATES,
  lengthPrefixed,
  type Message,
  parseStartAt,
  trimmed,
  wireAssignment
} from './codec'
import { fixture, fixtureCredentials } from './fixtures'

interface FrameVector {
  name: string
  key: string
  message: Record<string, string | boolean>
  payload: string
  frame: string
}

function messageOf(vector: FrameVector): Message {
  const credentials = keyBytes(fixtureCredentials(vector.key))
  const fields = vector.message
  const big = (name: string): bigint => BigInt(fields[name] as string)
  let body: Body
  switch (fields.type) {
    case 'discover':
      body = { type: 'discover' }
      break
    case 'announce':
      body = {
        type: 'announce',
        consent: fields.consent as boolean,
        lease: fields.lease as (typeof LEASE_STATES)[number],
        leaseRevision: big('leaseRevision')
      }
      break
    case 'assign':
      body = {
        type: 'assign',
        revision: big('revision'),
        gameId: fields.gameId as string,
        title: fields.title as string,
        startAt: fields.startAt as string
      }
      break
    case 'ack':
      body = {
        type: 'ack',
        status: fields.status as (typeof ACK_STATUSES)[number],
        revision: big('revision')
      }
      break
    default:
      body = {
        type: fields.type as 'renew' | 'release',
        revision: big('revision')
      }
  }
  return {
    header: {
      sender: Buffer.from(fields.sender as string, 'hex'),
      requestId: big('requestId'),
      accountTag: credentials.accountTag,
      keyId: credentials.keyId,
      challenge: Buffer.from(fields.challenge as string, 'hex'),
      receiverNonce: Buffer.from(fields.receiverNonce as string, 'hex')
    },
    body
  }
}

describe('event-control codec against the shared fixtures', function () {
  it('derives every key the way the server does', function () {
    const { vectors } = fixture<{
      vectors: Array<Record<string, string>>
    }>('keys.json')
    for (const vector of vectors) {
      const grant = deviceEventControlGrant(
        vector.secret,
        vector.issuer,
        vector.userId
      )
      expect(asCredentials(grant)).deep.equals(fixtureCredentials(vector.name))
    }
  })

  it('encodes and decodes every frame byte for byte', function () {
    const { vectors } = fixture<{ vectors: FrameVector[] }>('frames.json')
    expect(vectors.length).greaterThan(11)
    for (const vector of vectors) {
      const key = keyBytes(fixtureCredentials(vector.key)).key
      const message = messageOf(vector)
      const payload = encode(message, key)
      expect(payload.toString('hex'), vector.name).equals(vector.payload)
      expect(frame(payload).toString('hex'), vector.name).equals(vector.frame)
      const decoded = decode(Buffer.from(vector.payload, 'hex'))
      expect(decoded.message, vector.name).deep.equals(message)
      expect(isAuthentic(decoded, key), vector.name).equals(true)
      const reader = new FrameReader()
      expect(reader.push(Buffer.from(vector.frame, 'hex'))).deep.equals([
        payload
      ])
      // Every field again, as a log line shows it.
      expect(describeMessage(decoded.message).type).equals(message.body.type)
    }
  })

  it('refuses every rejection for the named reason', function () {
    const rejections = fixture<{
      decode: Array<{
        name: string
        payload: string
        error: string
        index?: number
      }>
      unauthentic: Array<{ name: string; key: string; payload: string }>
      prefixes: Array<{
        name: string
        prefix: string
        error?: string
        length?: number
      }>
    }>('rejections.json')
    for (const vector of rejections.decode) {
      let caught: CodecError | undefined
      try {
        decode(Buffer.from(vector.payload, 'hex'))
      } catch (error) {
        caught = error as CodecError
      }
      expect(caught, vector.name).instanceOf(CodecError)
      expect(caught?.code, vector.name).equals(vector.error)
      expect(caught?.index, vector.name).equals(vector.index)
    }
    for (const vector of rejections.unauthentic) {
      const decoded = decode(Buffer.from(vector.payload, 'hex'))
      expect(
        isAuthentic(decoded, keyBytes(fixtureCredentials(vector.key)).key),
        vector.name
      ).equals(false)
    }
    for (const vector of rejections.prefixes) {
      const reader = new FrameReader()
      const prefix = Buffer.from(vector.prefix, 'hex')
      if (vector.length != null) {
        expect(reader.push(prefix)).deep.equals([])
        expect(reader.push(Buffer.alloc(vector.length))).has.length(1)
      } else {
        expect(() => reader.push(prefix), vector.name)
          .throws(CodecError)
          .with.property('code', vector.error)
      }
    }
  })

  it('builds and validates assignments as the fixtures say', function () {
    const assignments = fixture<{
      build: Array<{
        name: string
        input: { gameId: string; title: string; startAtMs: number }
        expected?: { gameId: string; title: string; startAt: string }
        error?: string
      }>
      wire: Array<{
        name: string
        gameId: string
        title: string
        startAt: string
        error: string | null
      }>
    }>('assignments.json')
    for (const vector of assignments.build) {
      const make = (): unknown =>
        buildAssignment(
          vector.input.gameId,
          vector.input.title,
          new Date(vector.input.startAtMs)
        )
      if (vector.expected != null)
        expect(make(), vector.name).deep.equals(vector.expected)
      else
        expect(make, vector.name)
          .throws()
          .with.property('problem', vector.error)
    }
    for (const vector of assignments.wire) {
      const make = (): unknown =>
        wireAssignment(vector.gameId, vector.title, vector.startAt)
      if (vector.error == null) expect(make, vector.name).not.throws()
      else
        expect(make, vector.name)
          .throws()
          .with.property('problem', vector.error)
    }
  })
})

describe('event-control codec details', function () {
  it('length-prefixes and refuses an over-long part', function () {
    expect(lengthPrefixed(['ab', Buffer.from([1])]).toString('hex')).equals(
      '000261620001' + '01'
    )
    expect(() => lengthPrefixed([Buffer.alloc(0x10000)])).throws(/65535/)
  })

  it('trims ASCII whitespace only, and writes start times to the second', function () {
    expect(trimmed(' \t\n\v\f\rx\r ')).equals('x')
    expect(trimmed(' x')).equals(' x')
    expect(formatStartAt(new Date(1790013600999))).equals(
      '2026-09-21T18:00:00Z'
    )
    expect(parseStartAt('2026-09-21T18:00:00Z')?.getTime()).equals(
      1790013600000
    )
    expect(parseStartAt('nope')).equals(undefined)
  })

  it('reads the server reply, and refuses a malformed one', function () {
    const good = fixtureCredentials('one')
    expect(asCredentials({ ...good, version: 1, userId: 1001 })).deep.equals(
      good
    )
    expect(() => asCredentials(null)).throws(/not a key reply/)
    expect(() => asCredentials({ ...good, version: 2 })).throws(/version/)
    expect(() => asCredentials({ ...good, issuer: '' })).throws(/issuer/)
    expect(() => asCredentials({ ...good, userId: 'x' })).throws(/userId/)
    expect(() => asCredentials({ ...good, accountTag: 'AB' })).throws(/accountTag/)
    expect(() => asCredentials({ ...good, keyId: '0' })).throws(/keyId/)
    expect(() => asCredentials({ ...good, key: 'ff' })).throws(/key/)
  })

  it('names who sends what, and splits a stream', function () {
    expect(isFromDirector('discover')).equals(true)
    expect(isFromDirector('announce')).equals(false)
    const reader = new FrameReader()
    const a = frame(Buffer.alloc(40, 1))
    const b = frame(Buffer.alloc(50, 2))
    const both = Buffer.concat([a, b])
    expect(reader.push(both.subarray(0, 3))).deep.equals([])
    expect(reader.push(both.subarray(3, 53))).has.length(1)
    expect(reader.push(both.subarray(53))).has.length(1)
    expect(new CodecError('truncated').message).equals('truncated')
    expect(new CodecError('badValue', 6).message).equals('badValue(6)')
  })
})
