import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asSession, type TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { TvLoginRequest } from '../../common/tvLogin'
import { userIdOfGumbo } from '../../common/userId'
import { TvSessionController, type TvSessionStore } from './session'

const session = asSession({
  token: 'fixture-session',
  expiresAt: '2030-01-01',
  user: { id: userIdOfGumbo(101), displayName: 'Babe Ruth', isAdmin: false }
})
type SessionClient = Pick<
  TeamStationClient,
  'token' | 'whoAmI' | 'startTvLogin' | 'claimTvLogin' | 'signOut'
>
function fixture(initial: string | null = null): {
  controller: TvSessionController
  client: SessionClient
  store: TvSessionStore
  value: () => string | null
  claims: () => number
} {
  let value = initial
  let starts = 0
  let claims = 0
  const request = (): TvLoginRequest => ({
    requestId: `request-${++starts}`,
    clientSecret: 'secret',
    displayCode: 'ABCD–EFGH',
    qrUrl: 'https://app.teamstation.app/tv-login?token=fixture',
    expiresAt: Date.now() + 120000
  })
  const client: SessionClient = {
    token: undefined as string | undefined,
    whoAmI: async () => session.user,
    startTvLogin: async () => request(),
    claimTvLogin: async (
      ..._args: string[]
    ): Promise<{ ready: false } | typeof session> => {
      claims++
      return { ready: false }
    },
    signOut: async () => {
      client.token = undefined
    }
  }
  const store = {
    load: async () => value,
    save: async (v: string) => {
      value = v
    },
    clear: async () => {
      value = null
    }
  }
  const controller = new TvSessionController(
    client as unknown as TeamStationClient,
    store,
    'fixture-origin'
  )
  return { controller, client, store, value: () => value, claims: () => claims }
}
describe('TV session lifecycle', () => {
  it('creates, polls, persists, restores, and revokes a device session', async () => {
    const h = fixture()
    let changes = 0
    const unsubscribe = h.controller.subscribe(() => changes++)
    try {
      await h.controller.boot()
      expect(h.controller.snapshot().phase).equals('login')
      await h.controller.poll()
      expect(h.claims()).equals(1)
      h.client.claimTvLogin = async () => session
      await h.controller.poll()
      expect(h.controller.snapshot().phase).equals('ready')
      expect(h.client.token).equals(session.token)
      expect(h.value()).contains(session.token)
      await h.controller.boot()
      expect(h.controller.snapshot().session?.user.displayName).equals(
        'Babe Ruth'
      )
      await h.controller.signOut()
      expect(h.value()).equals(null)
      expect(h.client.token).equals(undefined)
      expect(h.controller.snapshot().phase).equals('login')
      expect(changes).greaterThan(4)
    } finally {
      unsubscribe()
      h.controller.stop()
    }
  })
  it('rejects corrupt and foreign-origin persisted credentials', async () => {
    for (const value of [
      'broken',
      JSON.stringify({ origin: 'other', session }),
      JSON.stringify({ origin: 'fixture-origin', session: {} })
    ]) {
      const h = fixture(value)
      try {
        await h.controller.boot()
        expect(h.controller.snapshot().phase).equals('login')
        expect(h.client.token).equals(undefined)
      } finally {
        h.controller.stop()
      }
    }
  })
  it('clears rejected sessions but retains credentials during transient failures', async () => {
    const h = fixture(JSON.stringify({ origin: 'fixture-origin', session }))
    try {
      h.client.whoAmI = async () => {
        throw new Error('Offline')
      }
      await h.controller.boot()
      expect(h.controller.snapshot().error).equals('Offline')
      expect(h.value()).contains(session.token)
      h.client.whoAmI = async () => null
      await h.controller.boot()
      expect(h.controller.snapshot().phase).equals('login')
      expect(h.value()).equals(null)
    } finally {
      h.controller.stop()
    }
  })
  it('rotates expired or rejected requests and exposes retryable errors', async () => {
    const h = fixture()
    try {
      await h.controller.boot()
      const old = h.controller.snapshot().request!
      old.expiresAt = Date.now()
      await h.controller.poll()
      expect(h.controller.snapshot().request!.requestId).not.equals(
        old.requestId
      )
      h.client.claimTvLogin = async () => {
        throw new HttpError('unauthorized', 'Expired')
      }
      await h.controller.poll()
      expect(h.controller.snapshot().phase).equals('login')
      h.client.claimTvLogin = async () => {
        throw new Error('Offline')
      }
      await h.controller.poll()
      expect(h.controller.snapshot().error).equals('Offline')
      h.client.startTvLogin = async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Verify arbitrary rejected values from native bridges.
        throw 'offline'
      }
      await h.controller.renew()
      expect(h.controller.snapshot().error).equals(
        'Unable to connect. Try again.'
      )
    } finally {
      h.controller.stop()
    }
  })
  it('ignores responses after stop or a new login visit', async () => {
    const h = fixture()
    let resolve!: (value: typeof session) => void
    try {
      await h.controller.boot()
      h.client.claimTvLogin = async () =>
        await new Promise(_resolve => {
          resolve = _resolve
        })
      const pending = h.controller.poll()
      h.controller.stop()
      resolve(session)
      await pending
      expect(h.value()).equals(null)
      expect(h.client.token).equals(undefined)
      await h.controller.poll(-1)
      h.store.load = async () =>
        await new Promise(resolve => {
          setImmediate(() => {
            h.controller.stop()
            resolve(null)
          })
        })
      await h.controller.boot()
      expect(h.controller.snapshot().phase).equals('loading')
    } finally {
      h.controller.stop()
    }
  })
})
