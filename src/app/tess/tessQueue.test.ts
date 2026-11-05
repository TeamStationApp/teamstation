import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  awaitingHold,
  enqueue,
  expiredBy,
  failedAtHead,
  firstExpiry,
  nextToDrain,
  type QueuedMessage,
  resolvedUnsure,
  stampDeadlines,
  unsureAtHead,
  withoutQueued
} from './tessQueue'
import type { TessChange, TessMessage } from './tessTypes'

function queued(
  seq: number,
  extra: Partial<QueuedMessage> = {}
): QueuedMessage {
  return {
    id: `q${seq}`,
    text: `Message ${seq}`,
    attachments: [],
    seq,
    ...extra
  }
}

const seqs = (queue: readonly QueuedMessage[]): number[] =>
  queue.map(message => message.seq)

const change = (status: TessChange['status']): TessChange => ({
  id: `c-${status}`,
  summary: 'Add a home game against Demo Eagles',
  method: 'POST',
  path: '/teams/t1/games',
  body: {},
  status
})

function message(
  role: 'user' | 'assistant',
  changes: TessChange[] = []
): TessMessage {
  return {
    id: `${role}-${changes.length}`,
    role,
    text: role === 'user' ? 'Add the game' : 'Hold Confirm.',
    attachments: [],
    changes,
    createdAt: '2026-11-03T10:00:00.000Z'
  }
}

describe('the queue of messages for Tess', function () {
  it('queues new messages in the order they were sent', function () {
    let queue: QueuedMessage[] = []
    for (const seq of [1, 2, 3]) queue = enqueue(queue, queued(seq))
    expect(seqs(queue)).deep.equals([1, 2, 3])
  })

  it('puts an edited message back at its original place', function () {
    const queue = [queued(1), queued(3), queued(4)]
    expect(seqs(enqueue(queue, queued(2)))).deep.equals([1, 2, 3, 4])
  })

  it('puts it at the next closest place when its neighbour has gone', function () {
    // 2 was edited, and 3 removed meanwhile: before 4, the first behind it.
    const queue = [queued(1), queued(4)]
    expect(seqs(enqueue(queue, queued(2)))).deep.equals([1, 2, 4])
  })

  it('puts it first when every message left was behind it', function () {
    // 1 went out while 2 was being edited.
    const queue = [queued(3), queued(4)]
    expect(seqs(enqueue(queue, queued(2)))).deep.equals([2, 3, 4])
  })

  it('puts it last when none left was behind it', function () {
    const queue = [queued(1), queued(2)]
    expect(seqs(enqueue(queue, queued(3)))).deep.equals([1, 2, 3])
    expect(seqs(enqueue([], queued(3)))).deep.equals([3])
  })

  it('removes a message by id, and returns a failed one to the head with why', function () {
    const queue = [queued(1), queued(2), queued(3)]
    expect(seqs(withoutQueued(queue, 'q2'))).deep.equals([1, 3])
    const failed = failedAtHead(withoutQueued(queue, 'q2'), queued(2), 'Busy')
    expect(seqs(failed)).deep.equals([2, 1, 3])
    expect(failed[0].error).equals('Busy')
    // Never twice.
    expect(seqs(failedAtHead(queue, queued(2), 'Busy'))).deep.equals([2, 1, 3])
  })

  it('drains the head once Tess is done', function () {
    const queue = [queued(1), queued(2)]
    expect(nextToDrain(queue, [])?.id).equals('q1')
    expect(nextToDrain([], [])).equals(null)
    // Changes from an earlier turn, or ended ones, do not hold it.
    expect(
      nextToDrain(queue, [
        message('assistant', [change('pending')]),
        message('user'),
        message('assistant', [change('done'), change('expired')])
      ])?.id
    ).equals('q1')
  })

  it('waits while the latest turn has a change awaiting its hold', function () {
    const messages = [
      message('user'),
      message('assistant', [change('pending')]),
      message('assistant')
    ]
    expect(awaitingHold(messages)).equals(true)
    expect(nextToDrain([queued(1)], messages)).equals(null)
    expect(awaitingHold([...messages, message('user')])).equals(false)
  })

  it('expires the pending changes past their time, so the queue goes on', function () {
    // The server's clock is a day ahead of this device's: its expiresAt is
    // never compared, only the time left from when the chat received it.
    const soon = {
      ...change('pending'),
      id: 'c-soon',
      expiresAt: '2026-11-04T10:30:00.000Z',
      expiresInMs: 30 * 60000
    }
    const later = {
      ...change('pending'),
      id: 'c-later',
      expiresAt: '2026-11-04T10:45:00.000Z',
      expiresInMs: 45 * 60000
    }
    const messages = [
      message('user'),
      message('assistant', [later, soon, change('done')])
    ]
    const received = 1000
    const deadlines = stampDeadlines(messages, new Map(), received)
    expect([...deadlines]).deep.equals([
      ['c-later', received + 45 * 60000],
      ['c-soon', received + 30 * 60000]
    ])
    // Seen again later, each keeps the deadline it was first given.
    stampDeadlines(messages, deadlines, received + 5000)
    expect(deadlines.get('c-soon')).equals(received + 30 * 60000)
    const due = received + 30 * 60000
    expect(firstExpiry(messages, deadlines)).equals(due)
    // One that does not say how long it has left waits for its hold.
    const silent = [message('assistant', [change('pending')])]
    expect(firstExpiry(silent, stampDeadlines(silent, new Map(), 0))).equals(
      null
    )
    // Before its time, nothing; the same messages.
    expect(expiredBy(messages, due - 1, deadlines)).equals(messages)
    const expired = expiredBy(messages, due, deadlines)
    expect(expired[1].changes.map(one => one.status)).deep.equals([
      'pending',
      'expired',
      'done'
    ])
    expect(nextToDrain([queued(1)], expired)).equals(null)
    const all = expiredBy(expired, received + 45 * 60000, deadlines)
    expect(firstExpiry(all, deadlines)).equals(null)
    expect(nextToDrain([queued(1)], all)?.id).equals('q1')
  })

  it('keeps a message the chat lost track of at the head until the conversation says whether it went', function () {
    const queue = unsureAtHead([queued(1), queued(3)], queued(2), 'm-2')
    expect(seqs(queue)).deep.equals([2, 1, 3])
    expect(queue[0].unsure).equals('m-2')
    expect(nextToDrain(queue, [])).equals(null)
    // Found by its client id, it reached Tess, and goes from the queue.
    const reached = [message('user')].map(one => ({ ...one, clientId: 'm-2' }))
    expect(seqs(resolvedUnsure(queue, reached, 'Unsure'))).deep.equals([1, 3])
    // Not found, it stays, with why, and waits for the person.
    const kept = resolvedUnsure(queue, [message('user')], 'Unsure')
    expect(kept[0]).deep.equals({ ...queued(2), error: 'Unsure' })
    expect(seqs(kept)).deep.equals([2, 1, 3])
    expect(nextToDrain(kept, [])).equals(null)
    // A head that is not unsure is left as it is.
    expect(resolvedUnsure(kept, [], 'Unsure')).equals(kept)
  })

  it('waits while the head failed going out', function () {
    expect(nextToDrain([queued(1, { error: 'Busy' }), queued(2)], [])).equals(
      null
    )
  })
})
