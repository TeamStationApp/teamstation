import { expect } from 'chai'
import { describe, it } from 'mocha'
import { base64url } from 'rfc4648'

import {
  asAttachmentRef,
  asChatContent,
  type AttachmentRef,
  type ChatContent,
  decodeContent,
  encodeContent,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS,
  MAX_BODY
} from './chatContent'
import { utf8 } from './chatCrypto/bytes'
import { signingPublicKey } from './chatCrypto/keys'
import { openMessage, sealMessage } from './chatCrypto/seal'
import { seed } from './chatCrypto/vectors'
import { userIdOfGumbo, userIdOfValue } from './userId'

const key32 = base64url.stringify(new Uint8Array(32).fill(7), { pad: false })
const target = 'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const attachment: AttachmentRef = {
  id: 'cat_abc',
  key: key32,
  digest: key32,
  size: 1234,
  contentType: 'image/jpeg',
  fileName: 'photo.jpg',
  width: 640,
  height: 480
}
const text: ChatContent = {
  type: 'text',
  body: 'Great game 🎉',
  mentions: [userIdOfGumbo(7), userIdOfGumbo(42)],
  quote: {
    id: target,
    authorId: userIdOfGumbo(7),
    snippet: 'who brings snacks?'
  },
  attachments: [attachment]
}

describe('chatContent', () => {
  it('authenticates original numeric content before normalizing mentions and quoted authors', () => {
    const identity = seed('identity')
    const epochKey = seed('epoch key')
    const shapes = [
      {
        type: 'text',
        body: 'Great game',
        mentions: [7, 42],
        quote: { id: target, authorId: 7, snippet: 'Reply' },
        attachments: [attachment]
      },
      { type: 'edit', targetId: target, body: 'Fixed', mentions: [42] },
      { type: 'reaction', targetId: target, emoji: '👍', remove: false },
      { type: 'delete', targetId: target }
    ]
    for (const shape of shapes) {
      const original = utf8(JSON.stringify(shape))
      const fields = {
        conversationId: 'cnv_legacy',
        epoch: 1,
        messageId: target,
        senderUserId: userIdOfGumbo(42),
        kind: 'post' as const
      }
      const sealed = sealMessage({
        ...fields,
        epochKey,
        plaintext: original,
        identitySecretKey: identity,
        nonce: seed('nonce').slice(0, 24)
      })
      const opened = openMessage({
        ...fields,
        ...sealed,
        epochKey,
        senderIdentityKey: signingPublicKey(identity)
      })
      expect(opened).deep.equals(original)
      const interpreted = decodeContent(opened)
      expect(interpreted).deep.equals({
        ...shape,
        ...(shape.mentions != null
          ? { mentions: shape.mentions.map(userIdOfGumbo) }
          : {}),
        ...('quote' in shape
          ? { quote: { ...shape.quote, authorId: userIdOfGumbo(7) } }
          : {})
      })
      expect(
        opened,
        'interpretation never rewrites the authenticated disclosure'
      ).deep.equals(original)
      expect(() =>
        openMessage({
          ...fields,
          senderUserId: userIdOfGumbo(7),
          ...sealed,
          epochKey,
          senderIdentityKey: signingPublicKey(identity)
        })
      ).throws()
    }
  })

  it('writes full-width accounts and rejects malformed legacy identifiers without coercion', () => {
    const high = userIdOfValue((1n << 127n) + 7n)
    const content: ChatContent = {
      ...text,
      type: 'text',
      mentions: [high],
      quote: { id: target, authorId: high, snippet: 'Reply' }
    }
    expect(decodeContent(encodeContent(content))).deep.equals(content)
    for (const bad of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '42',
      'usr_bad',
      null
    ]) {
      expect(() =>
        decodeContent(
          utf8(
            JSON.stringify({
              type: 'text',
              body: '',
              mentions: [bad],
              attachments: []
            })
          )
        )
      ).throws()
      expect(() =>
        decodeContent(
          utf8(
            JSON.stringify({
              type: 'text',
              body: '',
              mentions: [],
              attachments: [],
              quote: { id: target, authorId: bad, snippet: '' }
            })
          )
        )
      ).throws()
    }
    expect(() =>
      encodeContent({ ...text, mentions: [42] } as unknown as ChatContent)
    ).throws()
  })

  it('accepts each of the four shapes, and round-trips them through bytes', () => {
    const shapes: ChatContent[] = [
      text,
      { type: 'text', body: 'no quote', mentions: [], attachments: [] },
      { type: 'reaction', targetId: target, emoji: '👍🏽', remove: false },
      {
        type: 'edit',
        targetId: target,
        body: 'fixed',
        mentions: [userIdOfGumbo(3)]
      },
      { type: 'delete', targetId: target }
    ]
    for (const shape of shapes) {
      expect(asChatContent(shape)).deep.equals(
        JSON.parse(JSON.stringify(shape))
      )
      expect(decodeContent(encodeContent(shape))).deep.equals(
        asChatContent(shape)
      )
    }
  })

  it('drops fields it does not know', () => {
    const cleaned = asChatContent({
      type: 'delete',
      targetId: target,
      body: 'secret'
    })
    expect(cleaned).deep.equals({ type: 'delete', targetId: target })
  })

  it('takes a body of 8,000 characters and refuses 8,001', () => {
    const full = 'a'.repeat(MAX_BODY)
    expect(
      asChatContent({ type: 'text', body: full, mentions: [], attachments: [] })
    ).property('body', full)
    expect(() =>
      asChatContent({
        type: 'text',
        body: full + 'a',
        mentions: [],
        attachments: []
      })
    ).throws('8000')
    expect(() =>
      asChatContent({
        type: 'edit',
        targetId: target,
        body: full + 'b',
        mentions: []
      })
    ).throws('8000')
  })

  it('counts an emoji once, whatever its UTF-16 length', () => {
    const emoji = '🎉'.repeat(MAX_BODY)
    expect(
      asChatContent({
        type: 'text',
        body: emoji,
        mentions: [],
        attachments: []
      })
    ).property('body', emoji)
  })

  it('takes 10 attachments and refuses 11', () => {
    const ten = Array.from({ length: MAX_ATTACHMENTS }, () => attachment)
    expect(
      asChatContent({ type: 'text', body: '', mentions: [], attachments: ten })
    ).property('attachments')
    expect(() =>
      asChatContent({
        type: 'text',
        body: '',
        mentions: [],
        attachments: [...ten, attachment]
      })
    ).throws('More than 10')
  })

  it('takes an attachment of 100 MiB and refuses one byte more', () => {
    expect(
      asAttachmentRef({ ...attachment, size: MAX_ATTACHMENT_SIZE }).size
    ).equals(104857600)
    expect(() =>
      asAttachmentRef({ ...attachment, size: MAX_ATTACHMENT_SIZE + 1 })
    ).throws()
  })

  it('refuses malformed attachments', () => {
    const bad: Array<Partial<Record<keyof AttachmentRef, unknown>>> = [
      { key: base64url.stringify(new Uint8Array(16)) },
      { key: '***' },
      { digest: 'abc' },
      { size: -1 },
      { size: 1.5 },
      { contentType: '' },
      { fileName: 'x'.repeat(256) },
      { width: -1 },
      { durationMs: 'long' }
    ]
    for (const change of bad) {
      expect(
        () => asAttachmentRef({ ...attachment, ...change }),
        JSON.stringify(change)
      ).throws()
    }
    expect(
      asAttachmentRef({ ...attachment, durationMs: 1500 }).durationMs
    ).equals(1500)
  })

  it('refuses unknown types, bad ids, mentions and emoji', () => {
    const bad: unknown[] = [
      { type: 'poll' },
      null,
      'text',
      { type: 'delete', targetId: 'msg_short' },
      { type: 'reaction', targetId: target, emoji: '', remove: false },
      {
        type: 'reaction',
        targetId: target,
        emoji: 'x'.repeat(65),
        remove: false
      },
      { type: 'reaction', targetId: target, emoji: '👍', remove: 'no' },
      { type: 'text', body: 'x', mentions: [0], attachments: [] },
      { type: 'text', body: 'x', mentions: ['7'], attachments: [] },
      {
        type: 'text',
        body: 'x',
        mentions: [],
        attachments: [],
        quote: { id: 'x' }
      },
      { type: 'text', body: 5, mentions: [], attachments: [] }
    ]
    for (const raw of bad) {
      expect(() => asChatContent(raw), JSON.stringify(raw)).throws()
    }
  })

  it('decodeContent refuses bytes that are not UTF-8 JSON content', () => {
    expect(() => decodeContent(Uint8Array.of(0xff))).throws('UTF-8')
    expect(() => decodeContent(utf8('not json'))).throws()
    expect(() => decodeContent(utf8('{"type":"poll"}'))).throws('poll')
  })

  it('encodeContent refuses content over a limit', () => {
    expect(() =>
      encodeContent({
        type: 'text',
        body: 'a'.repeat(MAX_BODY + 1),
        mentions: [],
        attachments: []
      })
    ).throws()
  })
})
