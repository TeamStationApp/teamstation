import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React from 'react'

import { asSessionUser, TeamStationClient } from '../common/api'
import { HttpError } from '../common/errors'
import { userIdOfGumbo } from '../common/userId'
import { fill, mount, press, settle, text, unmount } from '../test/gameFormDom'
import { App } from './App'
import type { Route } from './navigation/routes'
import { currentRoute, showRoute } from './navigation/useAddressBar'

describe('TeamStation TV signed-out QR return', () => {
  let originals: PropertyDescriptorMap
  let requestedNext: string | undefined
  const inspected: string[] = []
  const token = 'a'.repeat(43)
  const user = asSessionUser({
    id: userIdOfGumbo(101),
    displayName: 'Babe Ruth',
    isAdmin: false
  })
  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    requestedNext = undefined
    inspected.length = 0
    api.whoAmI = async () => {
      throw new HttpError('unauthorized', 'Sign in')
    }
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.requestEmailCode = async (_email, options) => {
      requestedNext = options?.next
      return { requestId: 'test-wait', clientSecret: 'test-secret' }
    }
    api.signInWithCode = async () => ({
      user,
      token: 'test-token',
      expiresAt: '2099-01-01'
    })
    api.inspectTvLogin = async value => {
      inspected.push(value)
      return {
        platform: 'Apple TV',
        location: null,
        expiresAt: Date.now() + 120000
      }
    }
  })
  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
  })
  for (const route of [
    { name: 'teamStationTv', token },
    { name: 'signIn', next: `/tv-login?token=${token}` }
  ] as Route[]) {
    it(`returns ${route.name} to confirmation only after the account signs in`, async () => {
      showRoute(route, true)
      await mount(<App />)
      expect(inspected).length(0)
      await fill('E-mail address', 'reader@example.test')
      await press('Send me a sign-in code')
      expect(requestedNext).equals(`/tv-login?token=${token}`)
      await fill('Sign-in code', '000000')
      await press('Sign in')
      await settle()
      expect(currentRoute()).deep.equals({ name: 'teamStationTv', token })
      expect(inspected).deep.equals([token])
      expect(text()).includes('Sign this TV in to your TeamStation account?')
    })
  }
})
