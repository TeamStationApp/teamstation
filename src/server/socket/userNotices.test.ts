import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChangeFeed, FeedHandlers } from '../changeFeed/feed'
import { UserNoticeListener, type UserNoticePayload } from './userNotices'

/** A feed whose one subscription the test speaks for. */
function fakeFeed(): { feed: ChangeFeed; handlers: () => FeedHandlers } {
  let held: FeedHandlers | undefined
  const feed = {
    subscribe: (_channel: string, handlers: FeedHandlers) => {
      held = handlers
      return { listening: Promise.resolve(), stop: () => undefined }
    }
  } as unknown as ChangeFeed
  return {
    feed,
    handlers: () => {
      if (held == null) throw new Error('nothing subscribed')
      return held
    }
  }
}

const settle = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('the user notice listener', function () {
  it('delivers a notice that reads, and logs one that does not or fails to deliver', async () => {
    const { feed, handlers } = fakeFeed()
    const delivered: UserNoticePayload[] = []
    const logged: string[] = []
    let fail = false
    const listener = new UserNoticeListener({
      feed,
      deliver: async payload => {
        if (fail) throw new Error('no socket')
        delivered.push(payload)
      },
      onResync: () => undefined,
      log: message => logged.push(message)
    })
    handlers().onPayload(JSON.stringify({ t: 'badge', u: ['usr_a'] }))
    handlers().onPayload(undefined)
    handlers().onPayload('{"t": 7}')
    fail = true
    handlers().onPayload(JSON.stringify({ t: 'tess', u: ['usr_b'] }))
    await settle()
    expect(delivered.map(payload => [payload.t, payload.u])).deep.equals([
      ['badge', ['usr_a']]
    ])
    expect(logged).to.have.length(2)
    expect(logged[0]).contains('does not read')
    expect(logged[1]).contains('no socket')
    listener.close()
  })

  it('asks for a resync on every listen after the first, and logs to the console by default', async () => {
    const { feed, handlers } = fakeFeed()
    let resyncs = 0
    const listener = new UserNoticeListener({
      feed,
      deliver: async () => undefined,
      onResync: () => {
        resyncs++
      }
    })
    handlers().onListening?.(true)
    handlers().onListening?.(false)
    expect(resyncs).equals(1)
    const error = console.error
    const said: unknown[] = []
    console.error = (...args: unknown[]) => {
      said.push(args.join(' '))
    }
    try {
      handlers().onPayload('not json')
    } finally {
      console.error = error
    }
    expect(String(said[0])).contains('user notices:')
    listener.close()
  })
})
