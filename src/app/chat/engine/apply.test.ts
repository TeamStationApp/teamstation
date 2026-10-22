import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChatMessage } from '../../../common/api'
import type { ChatContent } from '../../../common/chatContent'
import { userIdOfGumbo } from '../../../common/userId'
import { foldMessages } from './apply'
import type { Opened } from './decrypt'

/** U12: edits, deletes, reactions and receipts fold by target id. */
describe('chat engine fold', function () {
  const id = (n: number): string => `msg_${String(n).padStart(26, 'a')}`

  function envelope(
    seq: number,
    sender: string,
    kind: ChatMessage['kind'],
    targetIds: string[] | null = null,
    clearedAt: string | null = null
  ): ChatMessage {
    return {
      id: id(seq),
      conversationId: 'cnv_x',
      seq,
      epoch: 1,
      senderUserId: sender,
      senderIdentityId: 'cid_x',
      kind,
      targetIds,
      nonce: '',
      ciphertext: clearedAt == null ? 'AA' : '',
      signature: '',
      attachmentIds: [],
      clearedAt,
      createdAt: `2027-04-10T12:00:0${seq % 10}Z`
    }
  }

  function fold(
    rows: Array<[ChatMessage, Opened | ChatContent | undefined]>,
    reads: Array<{ userId: string; seq: number }> = []
  ): ReturnType<typeof foldMessages> {
    const opened = new Map<string, Opened>()
    for (const [row, content] of rows) {
      if (content == null) continue
      opened.set(
        row.id,
        'status' in content
          ? content
          : { status: 'ok', content, replacedIdentity: false }
      )
    }
    return foldMessages({
      envelopes: rows.map(([row]) => row).reverse(),
      opened,
      me: userIdOfGumbo(1),
      names: new Map([
        [userIdOfGumbo(1), 'Me'],
        [userIdOfGumbo(2), 'Bo']
      ]),
      reads
    })
  }

  const text = (body: string): ChatContent => ({
    type: 'text',
    body,
    mentions: [],
    attachments: []
  })

  it('applies the author’s edits in order and ignores anyone else’s', function () {
    const [post] = fold([
      [envelope(1, userIdOfGumbo(2), 'post'), text('hello')],
      [
        envelope(2, userIdOfGumbo(2), 'edit'),
        {
          type: 'edit',
          targetId: id(1),
          body: 'hello there',
          mentions: [userIdOfGumbo(1)]
        }
      ],
      [
        envelope(3, userIdOfGumbo(1), 'edit'),
        { type: 'edit', targetId: id(1), body: 'forged', mentions: [] }
      ],
      [
        envelope(4, userIdOfGumbo(2), 'edit'),
        { type: 'edit', targetId: id(9), body: 'nowhere', mentions: [] }
      ]
    ])
    expect(post.body).equals('hello there')
    expect(post.mentions).deep.equals([userIdOfGumbo(1)])
    expect(post.edited).equals(true)
    expect(post.editIds).deep.equals([id(2)])
    expect(post.senderName).equals('Bo')
    expect(post.mine).equals(false)
  })

  it('counts one reaction per person and emoji, the latest standing', function () {
    const [post] = fold([
      [envelope(1, userIdOfGumbo(1), 'post'), text('hi')],
      [
        envelope(2, userIdOfGumbo(2), 'reaction'),
        { type: 'reaction', targetId: id(1), emoji: '👍', remove: false }
      ],
      [
        envelope(3, userIdOfGumbo(1), 'reaction'),
        { type: 'reaction', targetId: id(1), emoji: '👍', remove: false }
      ],
      [
        envelope(4, userIdOfGumbo(1), 'reaction'),
        { type: 'reaction', targetId: id(1), emoji: '👍', remove: true }
      ],
      [
        envelope(5, userIdOfGumbo(1), 'reaction'),
        { type: 'reaction', targetId: id(1), emoji: '🎉', remove: false }
      ],
      [
        envelope(6, userIdOfGumbo(2), 'reaction'),
        { type: 'reaction', targetId: id(1), emoji: '🎉', remove: false }
      ],
      [
        envelope(7, userIdOfGumbo(2), 'reaction'),
        { type: 'reaction', targetId: id(1), emoji: '😢', remove: true }
      ],
      [
        envelope(8, userIdOfGumbo(2), 'reaction'),
        { type: 'reaction', targetId: id(9), emoji: '👍', remove: false }
      ],
      [envelope(9, userIdOfGumbo(2), 'reaction'), { status: 'locked' }]
    ])
    expect(post.reactions).deep.equals([
      { emoji: '👍', userIds: [userIdOfGumbo(2)], mine: false },
      { emoji: '🎉', userIds: [userIdOfGumbo(1), userIdOfGumbo(2)], mine: true }
    ])
  })

  it('removes a post its author deletes, and shows a moderator’s removal', function () {
    const views = fold([
      [
        envelope(1, userIdOfGumbo(2), 'post', null, '2027-04-10T12:01:00Z'),
        { status: 'cleared' }
      ],
      [
        envelope(2, userIdOfGumbo(2), 'edit', null, '2027-04-10T12:01:00Z'),
        { status: 'cleared' }
      ],
      [envelope(3, userIdOfGumbo(2), 'post'), text('second')],
      [envelope(4, userIdOfGumbo(1), 'post'), text('mine')],
      [envelope(5, userIdOfGumbo(1), 'post'), text('kept')],
      [
        envelope(6, userIdOfGumbo(2), 'delete', [id(1), id(2)]),
        { type: 'delete', targetId: id(1) }
      ],
      [
        envelope(7, userIdOfGumbo(1), 'moderatorDelete', [id(3)]),
        { status: 'locked' }
      ],
      [envelope(8, userIdOfGumbo(1), 'moderatorDelete', [id(4)]), undefined],
      [envelope(9, userIdOfGumbo(2), 'delete', [id(5)]), undefined],
      [
        envelope(10, userIdOfGumbo(2), 'reaction'),
        { type: 'reaction', targetId: id(3), emoji: '👍', remove: false }
      ],
      [envelope(11, userIdOfGumbo(2), 'delete', [id(99)]), undefined]
    ])
    const byId = new Map(views.map(view => [view.id, view]))
    expect(byId.get(id(1))).include({ status: 'removed', removedBy: 'author' })
    expect(byId.get(id(3))).include({
      status: 'removed',
      removedBy: 'moderator',
      body: ''
    })
    expect(byId.get(id(3))?.reactions).deep.equals([])
    // A moderator removing their own post removed it as its author.
    expect(byId.get(id(4))).include({ status: 'removed', removedBy: 'author' })
    // A plain delete of someone else's post does nothing.
    expect(byId.get(id(5))).include({ status: 'ok', body: 'kept' })
  })

  it('carries quotes, attachments, read receipts and every status', function () {
    const attachment = {
      id: 'cat_1',
      key: 'k',
      digest: 'd',
      size: 3,
      contentType: 'image/jpeg',
      fileName: 'a.jpg'
    }
    const views = fold(
      [
        [envelope(1, userIdOfGumbo(2), 'post'), text('first')],
        [
          envelope(2, userIdOfGumbo(1), 'post'),
          {
            type: 'text',
            body: 'reply',
            mentions: [],
            quote: { id: id(1), authorId: userIdOfGumbo(2), snippet: 'first' },
            attachments: [attachment]
          }
        ],
        [envelope(3, userIdOfGumbo(2), 'post'), { status: 'locked' }],
        [envelope(4, userIdOfGumbo(2), 'post'), { status: 'lost' }],
        [
          envelope(5, userIdOfGumbo(3), 'post'),
          { status: 'invalid', reason: 'signature' }
        ],
        [envelope(6, userIdOfGumbo(2), 'post'), undefined],
        [
          envelope(7, userIdOfGumbo(2), 'post'),
          { status: 'ok', content: text('old key'), replacedIdentity: true }
        ]
      ],
      [
        { userId: userIdOfGumbo(1), seq: 7 },
        { userId: userIdOfGumbo(2), seq: 2 },
        { userId: userIdOfGumbo(3), seq: 1 }
      ]
    )
    expect(views.map(view => view.status)).deep.equals([
      'ok',
      'ok',
      'locked',
      'lost',
      'invalid',
      'locked',
      'ok'
    ])
    expect(views[1].quote).deep.equals({
      id: id(1),
      authorId: userIdOfGumbo(2),
      snippet: 'first',
      authorName: 'Bo',
      status: 'ok'
    })
    expect(views[1].attachments).deep.equals([attachment])
    expect(views[0].readBy).deep.equals([userIdOfGumbo(1), userIdOfGumbo(3)])
    expect(views[1].readBy).deep.equals([userIdOfGumbo(2)])
    expect(views[4].senderName).equals(undefined)
    expect(views[6].sentBeforeSafetyNumberChange).equals(true)
    expect(views[0].sentBeforeSafetyNumberChange).equals(false)
  })
})
