import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  testPasswordCosts,
  testPasswordParameters
} from '../test/passwordFixtures'
import { TeamStationClient } from './api'
import { userIdOfGumbo } from './userId'

describe('password API client', () => {
  it('cancels password submission when leaving during each preparation or hashing step', async () => {
    for (const stage of ['start', 'calibration', 'account', 'current', 'new']) {
      const controller = new AbortController()
      let writes = 0
      const cancelAt = (step: string): void => {
        if (stage === step) controller.abort()
      }
      const client = new TeamStationClient({
        baseUrl: 'https://example.test',
        passwordKdf: async password => {
          cancelAt(password === 'current password' ? 'current' : 'new')
          return 'ab'.repeat(32)
        },
        fetch: async (_input, init) => {
          if (init?.method === 'PUT') writes++
          cancelAt('account')
          return new Response(
            JSON.stringify({
              user: {
                id: userIdOfGumbo(101),
                gumboId: null,
                displayName: 'Demo',
                isAdmin: false,
                avatarUrl: null
              },
              emails: [],
              hasPassword: true,
              passwordNeedsUpgrade: false,
              passwordParameters: {
                client: testPasswordParameters,
                server: testPasswordParameters
              },
              newPasswordSalt: 'ff'.repeat(16)
            })
          )
        }
      })
      cancelAt('start')
      const preparation = Promise.resolve().then(() => {
        cancelAt('calibration')
        return testPasswordCosts
      })
      try {
        await client.setAccountPassword(
          'invented valid password',
          'current password',
          undefined,
          preparation,
          controller.signal
        )
        expect.fail('submitted after cancellation')
      } catch (error) {
        expect(String(error), stage).includes('Password change cancelled')
      }
      expect(writes, stage).equals(0)
    }
  })
  it('sends only client proofs and chosen parameters, honoring saved costs for old passwords', async () => {
    const calls: Array<{ route: string; body: Record<string, unknown> }> = []
    const derived: Array<{ password: string; iterations: number }> = []
    const account = {
      user: {
        id: userIdOfGumbo(101),
        gumboId: null,
        displayName: 'Demo',
        isAdmin: false,
        avatarUrl: null
      },
      emails: [],
      hasPassword: true,
      passwordParameters: {
        client: { ...testPasswordParameters, iterations: 3 },
        server: { ...testPasswordParameters, iterations: 12 }
      },
      newPasswordSalt: 'ff'.repeat(16),
      passwordNeedsUpgrade: false
    }
    const client = new TeamStationClient({
      baseUrl: 'https://example.com/api/v1',
      passwordCosts: testPasswordCosts,
      passwordTargetMs: Number.MIN_VALUE,
      passwordKdf: async (password, p) => {
        derived.push({ password, iterations: p.iterations })
        return 'ab'.repeat(32)
      },
      fetch: async (input, init) => {
        const route =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}'
        )
        calls.push({ route, body })
        return new Response(
          JSON.stringify(
            route.endsWith('/parameters')
              ? account.passwordParameters.client
              : route.endsWith('/auth/password')
                ? { token: 'fixture', expiresAt: 'date', user: account.user }
                : route.endsWith('/reset')
                  ? { requestId: 'id', email: 'a@example.com' }
                  : account
          )
        )
      }
    })
    await client.setAccountPassword(
      'new invented password',
      'current invented password'
    )
    expect(derived.map(d => d.iterations)).deep.equals([6, 3, 6])
    expect(calls[1].body).deep.equals({
      clientHash: 'ab'.repeat(32),
      currentClientHash: 'ab'.repeat(32),
      clientParameters: { ...testPasswordParameters, salt: 'ff'.repeat(16) }
    })
    await client.signInWithPassword(
      'a@example.com',
      'current invented password'
    )
    expect(derived[3].iterations).equals(3)
    expect(client.token).equals('fixture')
    await client.requestPasswordReset()
    await client.setAccountPassword('reset invented password', undefined, {
      requestId: 'id',
      code: 'synthetic'
    })
    expect(JSON.stringify(calls)).not.includes('invented password')
    account.passwordNeedsUpgrade = true
    try {
      await client.setAccountPassword('new invented password')
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('Verify an email')
    }
    await client.setAccountPassword('new invented password', undefined, {
      requestId: 'id',
      code: 'synthetic'
    })
    account.passwordNeedsUpgrade = false
    try {
      await client.setAccountPassword('new invented password')
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('current password')
    }
    account.newPasswordSalt = undefined as unknown as string
    try {
      await client.setAccountPassword('new invented password')
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('Update the server')
    }
  })
  it('never falls back to plaintext when a KDF is missing or fails', async () => {
    const client = new TeamStationClient({
      baseUrl: 'https://example.com',
      fetch: async () => {
        throw new Error('must not fetch')
      }
    })
    try {
      await client.signInWithPassword('a@example.com', 'password')
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('unavailable')
    }
  })
})

describe('password preparation lifecycle', () => {
  it('shares pending work, retries failures and benchmarks on a later visit', async () => {
    let finish!: (value: string) => void
    let fail!: (error: Error) => void
    let count = 0
    const client = new TeamStationClient({
      baseUrl: 'https://example.test',
      passwordTargetMs: Number.MIN_VALUE,
      passwordKdf: async () => {
        count++
        return await new Promise<string>((resolve, reject) => {
          finish = resolve
          fail = reject
        })
      }
    })
    const first = client.preparePasswordCosts()
    expect(client.preparePasswordCosts()).equals(first)
    await Promise.resolve()
    expect(count).equals(1)
    fail(new Error('unavailable'))
    try {
      await first
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('unavailable')
    }
    const retry = client.preparePasswordCosts()
    await Promise.resolve()
    finish('ab'.repeat(32))
    expect((await retry).iterations).equals(6)
    const later = client.preparePasswordCosts()
    await Promise.resolve()
    expect(count).equals(3)
    finish('ab'.repeat(32))
    await later
  })
  it('waits for preparation before deriving secrets or sending requests, and rejects weak supplied costs', async () => {
    let finishPreparation!: (costs: typeof testPasswordCosts) => void
    const pending = new Promise<typeof testPasswordCosts>(resolve => {
      finishPreparation = resolve
    })
    let requests = 0
    const client = new TeamStationClient({
      baseUrl: 'https://example.test',
      passwordKdf: async () => {
        throw new Error('must not derive')
      },
      fetch: async () => {
        requests++
        throw new Error('request after preparation')
      }
    })
    const saved = client.setAccountPassword(
      'invented long password',
      undefined,
      undefined,
      pending
    )
    await Promise.resolve()
    expect(requests).equals(0)
    finishPreparation(testPasswordCosts)
    try {
      await saved
      expect.fail('saved')
    } catch (error) {
      expect(String(error)).includes('Cannot reach TeamStation')
    }
    expect(requests).equals(1)
    try {
      await client.setAccountPassword(
        'invented long password',
        undefined,
        undefined,
        Promise.resolve({ ...testPasswordCosts, iterations: 2 })
      )
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('at least')
    }
    expect(requests).equals(1)
  })
})
