import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChatMessage } from '../../../common/api'
import type { AttachmentRef, ChatContent } from '../../../common/chatContent'
import { message, view } from '../chatViews.test.helpers'
import { foldMessages, type MessageView, type QuoteView } from './apply'
import type { Opened } from './decrypt'
import { findOriginal, replyExcerpt, resolveQuote } from './reply'

const quote: QuoteView = {
  id: 'msg_original',
  authorId: 7,
  authorName: 'Cached sender',
  snippet: 'Untrusted cached text'
}
const attachment = (
  contentType: string,
  fileName = 'notes.pdf'
): AttachmentRef => ({
  id: 'cat_fixture',
  key: 'AA',
  digest: 'AA',
  contentType,
  fileName,
  size: 1
})

describe('chat reply authority and excerpts', function () {
  it('uses only the current original sender and edited body, without a nested quote', function () {
    const original = message({
      id: quote.id,
      senderUserId: 2,
      senderName: 'Shohei Ohtani',
      body: 'Edited wording',
      quote: { ...quote, id: 'msg_nested', snippet: 'Nested quote' }
    })
    expect(resolveQuote(quote, new Map([[original.id, original]]))).deep.equals(
      {
        id: quote.id,
        authorId: 2,
        authorName: 'Shohei Ohtani',
        snippet: 'Edited wording',
        status: 'ok'
      }
    )
    expect(replyExcerpt(original)).equals('Edited wording')
  })

  it('caps the excerpt at 200 Unicode code points without splitting an emoji', function () {
    expect(replyExcerpt(message({ body: '😀'.repeat(200) }))).equals(
      '😀'.repeat(200)
    )
    expect(replyExcerpt(message({ body: '😀'.repeat(201) }))).equals(
      '😀'.repeat(200) + '…'
    )
  })

  it('replaces every inaccessible original with its safe status and clears cached plaintext', function () {
    for (const status of ['removed', 'locked', 'lost', 'invalid'] as const) {
      const original = message({
        id: quote.id,
        status,
        body: 'Stale body',
        attachments: [attachment('application/pdf')]
      })
      const resolved = resolveQuote(quote, new Map([[original.id, original]]))
      expect(resolved.status).equals(status)
      expect(resolved.snippet)
        .not.contains('Stale body')
        .and.not.contains(quote.snippet)
        .and.not.contains('notes.pdf')
    }
    expect(resolveQuote(quote, new Map())).deep.equals({
      id: quote.id,
      authorId: 7,
      authorName: undefined,
      snippet: 'Message unavailable',
      status: 'unavailable'
    })
    expect(replyExcerpt(message({ senderName: undefined, body: '' }))).equals(
      'Message unavailable'
    )
  })

  it('uses locally decrypted attachment labels without opening full attachment bytes', function () {
    expect(
      replyExcerpt(
        message({ body: '', attachments: [attachment('image/png')] })
      )
    ).equals('Photo')
    expect(
      replyExcerpt(
        message({ body: '', attachments: [attachment('video/mp4')] })
      )
    ).equals('Video')
    expect(
      replyExcerpt(
        message({ body: '', attachments: [attachment('application/pdf')] })
      )
    ).equals('File: notes.pdf')
    expect(
      replyExcerpt(
        message({
          body: '',
          attachments: [attachment('image/png'), attachment('video/mp4')]
        })
      )
    ).equals('2 attachments')
    expect(
      replyExcerpt(
        message({
          body: 'Photo caption',
          attachments: [attachment('image/png')]
        })
      )
    ).equals('Photo caption')
  })

  it('resolves a folded reply after edits and removal instead of trusting its encrypted snapshot', function () {
    const envelopes: ChatMessage[] = []
    const opened = new Map<string, Opened>()
    const add = (
      id: string,
      seq: number,
      senderUserId: number,
      kind: ChatMessage['kind'],
      content?: ChatContent,
      targetIds: string[] | null = null
    ): void => {
      envelopes.push({
        id,
        seq,
        senderUserId,
        kind,
        targetIds,
        conversationId: 'cnv_fixture',
        senderIdentityId: 'cid_fixture',
        epoch: 1,
        nonce: '',
        ciphertext: 'AA',
        signature: '',
        attachmentIds: [],
        clearedAt: null,
        createdAt: '2027-04-01T17:00:00Z'
      })
      if (content != null)
        opened.set(id, { status: 'ok', content, replacedIdentity: false })
    }
    add(quote.id, 1, 2, 'post', {
      type: 'text',
      body: 'Original wording',
      mentions: [],
      attachments: []
    })
    add('msg_reply', 2, 1, 'post', {
      type: 'text',
      body: 'Reply body',
      mentions: [],
      attachments: [],
      quote
    })
    add('msg_edit', 3, 2, 'edit', {
      type: 'edit',
      targetId: quote.id,
      body: 'Edited wording',
      mentions: []
    })
    const fold = (): MessageView[] =>
      foldMessages({
        envelopes,
        opened,
        me: 1,
        names: new Map([
          [1, 'Mookie Betts'],
          [2, 'Shohei Ohtani']
        ]),
        reads: []
      })
    expect(fold()[1].quote?.snippet).equals('Edited wording')
    add('msg_delete', 4, 2, 'delete', undefined, [quote.id])
    expect(fold()[1].quote?.snippet).equals('Message deleted')
    expect(fold()[1].quote?.status).equals('removed')
  })
})

describe('chat verified reply paging', function () {
  it('finds an already loaded original without paging or changing view state', async function () {
    const original = message({ id: quote.id })
    let loads = 0
    const current = view({ messages: [original], hasEarlier: true })
    const engine = {
      view: () => current,
      loadEarlier: async () => {
        loads += 1
        return current
      }
    }
    expect(
      await findOriginal(engine, 'cnv_fixture', quote.id, () => false)
    ).equals(original)
    expect(loads).equals(0)
  })

  it('pages past edit or reaction pages even when they add no visible posts', async function () {
    const original = message({ id: quote.id, seq: 1 })
    const recent = message({ id: 'msg_recent', seq: 20 })
    const pages = [
      view({ messages: [recent], hasEarlier: true, historyBefore: 20 }),
      view({ messages: [recent], hasEarlier: true, historyBefore: 10 }),
      view({
        messages: [original, recent],
        hasEarlier: false,
        historyBefore: 1
      })
    ]
    let page = 0
    const engine = {
      view: () => pages[page],
      loadEarlier: async () => pages[++page]
    }
    expect(
      await findOriginal(engine, 'cnv_fixture', quote.id, () => false)
    ).equals(original)
    expect(page).equals(2)
  })

  it('stops on missing conversation, exhausted history or cancellation before loading', async function () {
    let loads = 0
    const current = view({ messages: [], hasEarlier: false })
    const loadEarlier = async (): Promise<ReturnType<typeof view>> => {
      loads += 1
      return current
    }
    expect(
      await findOriginal(
        { view: () => undefined, loadEarlier },
        'cnv_fixture',
        quote.id,
        () => false
      )
    ).equals(undefined)
    expect(
      await findOriginal(
        { view: () => current, loadEarlier },
        'cnv_fixture',
        quote.id,
        () => false
      )
    ).equals(undefined)
    expect(
      await findOriginal(
        { view: () => ({ ...current, hasEarlier: true }), loadEarlier },
        'cnv_fixture',
        quote.id,
        () => true
      )
    ).equals(undefined)
    expect(loads).equals(0)
  })

  it('stops on an unchanged verified cursor rather than looping forever', async function () {
    const current = view({
      messages: [message({ seq: 20 })],
      hasEarlier: true,
      historyBefore: 20
    })
    let loads = 0
    expect(
      await findOriginal(
        {
          view: () => current,
          loadEarlier: async () => {
            loads += 1
            return current
          }
        },
        'cnv_fixture',
        quote.id,
        () => false
      )
    ).equals(undefined)
    expect(loads).equals(1)
  })

  it('discards a result after cancellation or lost membership and propagates paging errors', async function () {
    const original = message({ id: quote.id })
    let cancelled = false
    let visible = true
    const current = view({ hasEarlier: true })
    const engine = {
      view: () => (visible ? current : undefined),
      loadEarlier: async () => {
        cancelled = true
        return view({ messages: [original] })
      }
    }
    expect(
      await findOriginal(engine, 'cnv_fixture', quote.id, () => cancelled)
    ).equals(undefined)
    cancelled = false
    engine.loadEarlier = async () => {
      visible = false
      return view({ messages: [original] })
    }
    expect(
      await findOriginal(engine, 'cnv_fixture', quote.id, () => false)
    ).equals(undefined)
    visible = true
    engine.loadEarlier = async () => {
      throw new Error('Unavailable')
    }
    let failure: unknown
    await findOriginal(engine, 'cnv_fixture', quote.id, () => false).catch(
      (error: unknown) => {
        failure = error
      }
    )
    expect(String(failure)).contains('Unavailable')
  })
})
