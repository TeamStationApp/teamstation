import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  afterFailure,
  firstTry,
  LONGEST_PAUSE_MS,
  MAX_ATTEMPTS,
  pauseAfter,
  type PushRequest,
  requestOf,
  RETRY_DELAYS_MS
} from './requests'

const chat: PushRequest = {
  v: 1,
  t: 'chat',
  c: 'cnv_one',
  seq: 7,
  sender: 'usr_one',
  attempt: 1,
  to: undefined,
  due: undefined
}
const reminder: PushRequest = {
  v: 1,
  t: 'reminder',
  kind: 'teamEvent',
  eventId: 'tev_one',
  startAt: '2027-05-01T22:00:00.000Z',
  attempt: 1
}

const read: PushRequest = {
  v: 1,
  t: 'read',
  u: 'usr_two',
  c: 'cnv_one',
  seq: 7,
  session: 'ses_two',
  attempt: 1,
  devices: undefined
}

describe('push requests', function () {
  it('makes a first try of what the API queues', function () {
    expect(
      firstTry({ t: 'chat', c: 'cnv_one', seq: 7, sender: 'usr_one' })
    ).deep.equals({
      t: 'chat',
      c: 'cnv_one',
      seq: 7,
      sender: 'usr_one',
      v: 1,
      attempt: 1,
      to: undefined,
      due: undefined
    })
  })

  it('makes a first try of a read, whose retry is the same read', function () {
    const { v, attempt, ...asked } = read
    expect(firstTry(asked)).deep.equals(read)
    expect(
      afterFailure(read, { error: '1 unreached', unreached: ['usr_two'] }, 0)
    ).deep.equals({ retry: { ...read, attempt: 2 }, at: 5000 })
  })

  it('reads every kind back, with or without whom a chat retry is for', function () {
    for (const request of [
      chat,
      reminder,
      read,
      { ...read, session: undefined },
      { ...read, attempt: 2, devices: ['psh_one'] },
      { ...chat, attempt: 3, to: ['usr_two'] },
      { ...chat, due: 1_700_000_015_000 }
    ])
      expect(requestOf(JSON.stringify(request))).deep.equals({ request })
  })

  it('says why an entry is not a request', function () {
    expect(requestOf(undefined)).deep.equals({
      malformed: 'the entry has no request'
    })
    expect(requestOf('{'))
      .to.have.property('malformed')
      .match(/^the request cannot be read: SyntaxError/)
    for (const bad of [
      { ...chat, v: 2 },
      { ...chat, t: 'email' },
      { ...reminder, kind: 'practice' },
      { ...chat, seq: '7' }
    ])
      expect(requestOf(JSON.stringify(bad)))
        .to.have.property('malformed')
        .match(/^the request cannot be read: TypeError/)
    for (const attempt of [0, 1.5, -1])
      expect(requestOf(JSON.stringify({ ...chat, attempt }))).deep.equals({
        malformed: `attempt ${attempt} is not a try`
      })
  })

  it('tries again after 5 s, 30 s, 2 min and 10 min, then gives up', function () {
    expect(RETRY_DELAYS_MS).deep.equals([5000, 30000, 120000, 600000])
    let request: PushRequest = reminder
    const waits: number[] = []
    for (;;) {
      const next = afterFailure(request, { error: 'down' }, 1000)
      if ('dead' in next) {
        expect(request.attempt).equals(MAX_ATTEMPTS)
        expect(next.dead).equals('gave up after 5 attempts: down')
        break
      }
      expect(next.retry).deep.equals({
        ...request,
        attempt: request.attempt + 1
      })
      waits.push(next.at - 1000)
      request = next.retry
    }
    expect(waits).deep.equals([5000, 30000, 120000, 600000])
  })

  it('narrows a read retry to the devices whose clear failed, or tries them all', function () {
    expect(
      afterFailure(
        read,
        { error: '1 device(s) not cleared', devices: ['psh_ipad'] },
        0
      )
    ).deep.equals({
      retry: { ...read, attempt: 2, devices: ['psh_ipad'] },
      at: 5000
    })
    expect(
      afterFailure(read, { error: '1 unreached', unreached: ['usr_two'] }, 0)
    ).deep.equals({ retry: { ...read, attempt: 2 }, at: 5000 })
  })

  it('narrows a chat retry to the people left unreached, and a reminder never', function () {
    const next = afterFailure(
      chat,
      { error: '1 unreached', unreached: ['usr_two'] },
      0
    )
    expect(next).deep.equals({
      retry: { ...chat, attempt: 2, to: ['usr_two'] },
      at: 5000
    })
    // A whole failure tries everybody it was for again.
    expect(afterFailure(chat, { error: 'down' }, 0)).deep.equals({
      retry: { ...chat, attempt: 2 },
      at: 5000
    })
    expect(
      afterFailure(
        reminder,
        { error: '1 unreached', unreached: ['usr_two'] },
        0
      )
    ).deep.equals({ retry: { ...reminder, attempt: 2 }, at: 5000 })
  })
})

describe('the push sender’s pause between failed turns', function () {
  it('doubles from a second to half a minute, and stays there', function () {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 7, 100].map(failures => pauseAfter(failures))
    ).deep.equals([1000, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(LONGEST_PAUSE_MS).equals(30_000)
  })
})
