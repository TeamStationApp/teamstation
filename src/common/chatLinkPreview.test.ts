import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatContent,
  decodeContent,
  originalReportContent
} from './chatContent'
import { fromUtf8, utf8 } from './chatCrypto/bytes'
import { type MessageFields, messageKey } from './chatCrypto/seal'
import { contentWithPreview, previewFromContent } from './chatLinkPreview'
import { userIdOfGumbo } from './userId'

describe('private chat link preview', () => {
  const fields: MessageFields = {
    conversationId: 'room',
    messageId: 'message',
    epoch: 1,
    senderUserId: userIdOfGumbo(42),
    kind: 'post'
  }
  const epoch = new Uint8Array(32).fill(3)
  const content: ChatContent = {
    type: 'text',
    body: 'Read https://example.com',
    mentions: [],
    attachments: []
  }
  const preview = {
    url: 'https://example.com/',
    title: 'Private title',
    description: '',
    siteName: 'Example'
  }
  it('preserves legacy decoding and protects the preview when a message is reported', () => {
    const bytes = contentWithPreview(content, preview, fields, epoch)
    expect(decodeContent(bytes)).deep.equals(content)
    expect(previewFromContent(bytes, fields, epoch)).deep.equals(preview)
    const disclosedKey = messageKey(
      epoch,
      fields.conversationId,
      fields.messageId
    )
    expect(previewFromContent(bytes, fields, disclosedKey)).equals(undefined)
    const wire = fromUtf8(bytes)
    expect(wire).not.contains(preview.title)
    expect(originalReportContent(wire)).equals(JSON.stringify(content))
    expect(
      previewFromContent(bytes, { ...fields, kind: 'edit' }, epoch)
    ).equals(undefined)
  })
  it('keeps exact legacy bytes and removes only the protected top-level field', () => {
    for (const value of [
      'bad JSON',
      'null',
      '[]',
      ' { "body": "sealedPreview" } '
    ])
      expect(originalReportContent(value)).equals(value)
    expect(
      originalReportContent('{"future":2,"sealedPreview":{},"body":"text"}')
    ).equals('{"future":2,"body":"text"}')
  })
  it('discards a missing or damaged optional card', () => {
    for (const box of [
      null,
      {},
      { version: 2 },
      { version: 1, nonce: 'a'.repeat(32), ciphertext: '!' }
    ]) {
      const bytes = utf8(JSON.stringify({ ...content, sealedPreview: box }))
      expect(decodeContent(bytes)).deep.equals(content)
      expect(previewFromContent(bytes, fields, epoch)).equals(undefined)
    }
    expect(() =>
      contentWithPreview(
        content,
        { ...preview, title: 'x'.repeat(257) },
        fields,
        epoch
      )
    ).to.throw()
  })
})
