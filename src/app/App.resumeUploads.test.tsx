import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import { App } from './App'
import { phoneStream } from './stream/phoneStream'

/**
 * The app carries on a recording upload a kill cut off, once somebody is
 * signed in: `App` is where `useResumePendingUploads` is called, with the
 * app's own client and session.
 */
describe('the app at launch', () => {
  it('carries on cut-off recording uploads once somebody is signed in', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const engine = {
      capabilities: phoneStream.capabilities,
      resumePendingUploads: phoneStream.resumePendingUploads
    }
    const resumed: Array<[string, string]> = []
    // A phone that can record, in place of the browser's engine.
    phoneStream.capabilities = async () => ({
      supported: true,
      deviceModel: 'iPhone 13 Pro'
    })
    phoneStream.resumePendingUploads = async (apiBase, token) => {
      resumed.push([apiBase, token])
    }
    proto.whoAmI = async () =>
      asSessionUser({ id: 1, displayName: 'Demo Fan', isAdmin: false })
    proto.myRoles = async () => {
      throw new Error('offline')
    }
    proto.hasNotifications = async () => false
    proto.teams = async () => []
    proto.seasons = async () => []
    proto.ownGroups = async () => []
    proto.follows = async () => []
    proto.recentGame = async () => null
    proto.liveNow = async () => []
    window.history.replaceState(null, '', '/')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App apiBaseUrl="/api/v1" initialToken="token-0000" />)
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
      })
      expect(resumed).deep.equals([['/api/v1', 'token-0000']])
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      Object.defineProperties(proto, originals)
      Object.assign(phoneStream, engine)
      window.history.replaceState(null, '', '/')
    }
  })
})
