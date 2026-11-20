import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { lstrings } from '../locales/strings'
import { message } from './chatViews.test.helpers'
import { ChatDraftOwner, newChatWorkspaceState } from './chatWorkspaceModel'
import { UnconfirmedChatPost } from './engine/context'

describe('chat send failure messages', () => {
  it('restores the exact ordinary retry, reply and files after cancelling or acknowledging an edit', () => {
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    const mine = message({ mine: true, body: 'Practice' })
    const file = {
      fileName: 'lineup.txt',
      contentType: 'text/plain',
      bytes: new Uint8Array([1])
    }
    const retry = async (): Promise<void> => {}
    owner.write('A', {
      text: 'My unsent draft',
      replyTo: mine,
      picked: [file],
      scrollOffset: 50
    })
    const ordinary = owner.begin('A')!
    expect(owner.startEdit('A', mine)).equals(false)
    owner.finish(
      'A',
      ordinary,
      false,
      new UnconfirmedChatPost(new HttpError('offline', 'Lost reply'), retry)
    )
    expect(owner.startEdit('A', mine)).equals(true)
    expect(owner.startEdit('A', mine)).equals(false)
    expect(owner.draft('A')).includes({
      text: mine.body,
      replyTo: undefined,
      editing: mine
    })
    expect(owner.draft('A').picked).deep.equals([])
    const edit = owner.begin('A')!
    expect(edit.retry).equals(undefined)
    owner.finish('A', edit, false, new HttpError('offline', 'Send interrupted'))
    expect(owner.draft('A').editing).equals(mine)
    owner.write('B', { text: 'Other room', picked: [], scrollOffset: 0 })
    const save = owner.begin('A')!
    owner.finish('A', save, true)
    expect(owner.draft('A')).includes({
      text: 'My unsent draft',
      replyTo: mine,
      editing: undefined
    })
    expect(owner.draft('A').picked[0]).equals(file)
    expect(owner.draft('B').text).equals('Other room')
    owner.startEdit('A', mine)
    const cancelled = owner.begin('A')!
    owner.cancelEdit('A')
    owner.finish(
      'A',
      cancelled,
      false,
      new HttpError('offline', 'Late failure')
    )
    expect(owner.begin('A')?.retry).equals(retry)
    owner.cancelEdit('B')
    owner.invalidate()
    expect(owner.startEdit('B', mine)).equals(false)
    owner.cancelEdit('B')
  })

  it('replays an unchanged draft and distinguishes edits and dismissed cards', async () => {
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    owner.write('chat', { text: 'An event', picked: [], scrollOffset: 0 })
    let count = 0
    const error = new UnconfirmedChatPost(
      new HttpError('offline', 'Lost reply'),
      async () => ++count
    )
    const first = owner.begin('chat')!
    owner.finish('chat', first, false, error)
    const retry = owner.begin('chat')!
    expect(await retry.retry!()).equals(1)
    owner.write('chat', { ...owner.draft('chat'), text: 'A new event' })
    owner.finish('chat', retry, false, error)
    const other = owner.begin('chat')!
    expect(other.retry).equals(undefined)
    owner.discardRetry('chat')
    owner.finish('chat', other, false, error)
    expect(owner.begin('chat')!.retry).equals(undefined)
  })
  for (const [label, error, blocked] of [
    [
      'recipient block',
      new HttpError('forbidden', 'Unavailable', { reason: 'recipientBlocked' }),
      true
    ],
    ['ordinary forbidden', new HttpError('forbidden', 'Unavailable'), false],
    ['offline', new HttpError('offline', 'No connection'), false],
    [
      'unrelated reason',
      new HttpError('forbidden', 'Unavailable', { reason: 'notStaff' }),
      false
    ],
    [
      'wrong status',
      new HttpError('internal', 'Failure', { reason: 'recipientBlocked' }),
      false
    ],
    ['unexpected failure', new Error('Failure'), false]
  ] as const) {
    it(`preserves the correct message and draft for ${label}`, () => {
      const owner = new ChatDraftOwner(newChatWorkspaceState())
      owner.write('chat', {
        text: 'Keep my draft',
        picked: [],
        scrollOffset: 0
      })
      const submission = owner.begin('chat')!
      owner.finish('chat', submission, false, error)
      expect(owner.failed('chat')).equals(true)
      expect(owner.failure('chat')).equals(
        blocked ? lstrings.chat_send_blocked : lstrings.chat_send_failed
      )
      expect(owner.draft('chat').text).equals('Keep my draft')
      expect(owner.failure('other')).equals(undefined)
      const retry = owner.begin('chat')!
      expect(owner.failure('chat')).equals(undefined)
      owner.finish('chat', retry, true)
      expect(owner.failed('chat')).equals(false)
      expect(owner.draft('chat').text).equals('')
    })
  }
})
