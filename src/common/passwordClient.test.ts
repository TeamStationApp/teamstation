import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  testPasswordCosts,
  testPasswordParameters
} from '../test/passwordFixtures'
import { TeamStationClient } from './api'

describe('password API client', () => {
  it('sends only client proofs and chosen parameters, honoring saved costs for old passwords', async () => {
    const calls: Array<{ route: string; body: Record<string, unknown> }> = []
    const derived: Array<{ password: string; iterations: number }> = []
    const account = {
      user: { id: 101, displayName: 'Demo', isAdmin: false, avatarUrl: null },
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
    expect(derived.map(d => d.iterations)).deep.equals([3, 2])
    expect(calls[1].body).deep.equals({
      clientHash: 'ab'.repeat(32),
      currentClientHash: 'ab'.repeat(32),
      clientParameters: { ...testPasswordParameters, salt: 'ff'.repeat(16) }
    })
    await client.signInWithPassword(
      'a@example.com',
      'current invented password'
    )
    expect(derived[2].iterations).equals(3)
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
