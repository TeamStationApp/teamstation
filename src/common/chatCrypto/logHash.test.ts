import { createHash } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  GENESIS_HASH,
  type LogRow,
  logRowHash,
  verifiedPrefix
} from './logHash'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

const first: LogRow = {
  conversationId: 'cnv_c1',
  seq: 1,
  event: 'join',
  userId: 42,
  actorUserId: null,
  reason: null,
  at: 1790000000000
}
const second: LogRow = {
  conversationId: 'cnv_c1',
  seq: 2,
  event: 'leave',
  userId: 42,
  actorUserId: 7,
  reason: 'notEligible',
  at: new Date(1790000001000)
}
const H1 = 'a06197e2e1cff700d015ab1eb4c8e8f0ff78224a029740fbe047b36f5d6d56f5'
const H2 = 'bd02e848aa22160bb0ee73ac597813f5ce3174626d846d7be0621ec385222f72'

describe('chatCrypto logHash', () => {
  it('the genesis prev_hash is 32 zero bytes', () => {
    expect(hex(GENESIS_HASH)).equals('00'.repeat(32))
  })

  it('frozen vectors for a two-row chain', () => {
    const h1 = logRowHash(GENESIS_HASH, first)
    expect(hex(h1)).equals(H1)
    expect(hex(logRowHash(h1, second))).equals(H2)
  })

  it('is the SHA-256 of the fields as written, checked with Node', () => {
    const lp = (text: string): Buffer => {
      const bytes = Buffer.from(text)
      const length = Buffer.alloc(4)
      length.writeUInt32BE(bytes.length)
      return Buffer.concat([length, bytes])
    }
    const u64 = (n: number): Buffer => {
      const out = Buffer.alloc(8)
      out.writeBigUInt64BE(BigInt(n))
      return out
    }
    const input = Buffer.concat([
      Buffer.from(H1, 'hex'),
      lp('cnv_c1'),
      u64(2),
      lp('leave'),
      u64(42),
      u64(7),
      lp('notEligible'),
      u64(1790000001000)
    ])
    expect(createHash('sha256').update(input).digest('hex')).equals(H2)
  })

  it('a changed field changes the hash', () => {
    const changes: Array<Partial<LogRow>> = [
      { conversationId: 'cnv_c2' },
      { seq: 3 },
      { event: 'closed' },
      { userId: 43 },
      { actorUserId: 8 },
      { reason: 'other' },
      { at: 1790000001001 }
    ]
    const h1 = logRowHash(GENESIS_HASH, first)
    for (const change of changes) {
      expect(hex(logRowHash(h1, { ...second, ...change }))).not.equals(H2)
    }
    // No actor and actor 0 are the same bytes, as no reason and "" are.
    expect(hex(logRowHash(GENESIS_HASH, { ...first, actorUserId: 0 }))).equals(
      H1
    )
    expect(hex(logRowHash(GENESIS_HASH, { ...first, reason: '' }))).equals(H1)
  })

  it('refuses a prev_hash that is not 32 bytes', () => {
    expect(() => logRowHash(new Uint8Array(31), first)).throws(TypeError)
  })

  describe('verifiedPrefix', () => {
    const h1 = logRowHash(GENESIS_HASH, first)
    const h2 = logRowHash(h1, second)
    const rows = [
      { ...first, prevHash: GENESIS_HASH, hash: h1 },
      { ...second, prevHash: h1, hash: h2 }
    ]

    it('an untouched chain verifies to the end', () => {
      expect(verifiedPrefix(GENESIS_HASH, rows)).equals(2)
      expect(verifiedPrefix(h1, rows.slice(1))).equals(1)
      expect(verifiedPrefix(GENESIS_HASH, [])).equals(0)
    })

    it('a changed user id stops at that row', () => {
      expect(
        verifiedPrefix(GENESIS_HASH, [rows[0], { ...rows[1], userId: 99 }])
      ).equals(1)
    })

    it('a removed row stops where the chain breaks', () => {
      expect(verifiedPrefix(GENESIS_HASH, [rows[1]])).equals(0)
    })

    it('a row that claims the right prev_hash but a wrong hash stops', () => {
      expect(
        verifiedPrefix(GENESIS_HASH, [{ ...rows[0], hash: h2 }, rows[1]])
      ).equals(0)
    })
  })
})
