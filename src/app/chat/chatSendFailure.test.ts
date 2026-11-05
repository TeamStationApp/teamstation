import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { lstrings } from '../locales/strings'
import { ChatDraftOwner, newChatWorkspaceState } from './chatWorkspaceModel'

describe('chat send failure messages', () => {
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
