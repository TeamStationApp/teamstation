import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  asGameLiveStreams,
  asSessionUser,
  TeamStationClient
} from '../common/api'
import { userIdOfGumbo } from '../common/userId'
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
      recordings: phoneStream.recordings,
      resumeUpload: phoneStream.resumeUpload
    }
    const resumed: Array<[string, string, string]> = []
    // A phone that can record, with a take whose upload a kill cut off, in
    // place of the browser's engine.
    phoneStream.capabilities = async () => ({
      supported: true,
      deviceModel: 'iPhone 13 Pro'
    })
    phoneStream.recordings = async () => [
      {
        liveStreamId: 'liv_00000000000000000001',
        gameId: 'gam_00000000000000000001',
        angleName: 'Home Plate',
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_600_000,
        parts: 1,
        uploadId: 'dup_00000000000000000001',
        uploadTitle: 'Home Plate',
        uploadedAt: null,
        videoId: null,
        stoppedForLowStorage: false,
        publishedOutsideParts: false,
        hasPendingUpload: true,
        uploadRunning: false,
        uploadProgress: null
      }
    ]
    phoneStream.resumeUpload = async ({ liveStreamId, apiBase, token }) => {
      resumed.push([liveStreamId, apiBase, token])
      return 'vid_00000000000000000001'
    }
    proto.liveStreams = async gameId =>
      asGameLiveStreams({
        gameId,
        mine: [
          {
            id: 'liv_00000000000000000001',
            gameId,
            userId: userIdOfGumbo(1),
            ownerName: 'Demo Fan',
            slot: 1,
            label: 'Home Plate',
            keyPrefix: 'ts_0000',
            state: 'ended',
            opensAt: '2026-05-20T16:00:00.000Z',
            closesAt: null,
            videoId: null,
            lastError: null,
            status: null
          }
        ],
        others: [],
        canAdd: 3,
        maxCameras: 4
      })
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Fan',
        isAdmin: false
      })
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
      expect(resumed).deep.equals([
        ['liv_00000000000000000001', '/api/v1', 'token-0000']
      ])
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
