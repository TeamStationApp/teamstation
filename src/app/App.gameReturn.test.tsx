import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asSessionUser, asVideoSummary, TeamStationClient } from '../common/api'
import { HttpError } from '../common/errors'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { fill, mount, press, settle, text, unmount } from '../test/gameFormDom'
import { App } from './App'
import { currentRoute, showRoute } from './navigation/useAddressBar'
import { gameFixture } from './scoring/isUnscoredGame.test'

const videos = ['Home plate', 'Outfield'].map((angle, index) =>
  asVideoSummary({
    id: `v${index + 1}`,
    title: `Game — ${angle}`,
    kind: 'primary',
    numCameras: 1,
    status: 'ready',
    storage: 'local',
    startAt: '2026-01-01T18:00:00Z',
    durationSec: 300,
    width: 1920,
    height: 1080,
    codecs: null,
    posterUrl: `https://example.test/${index}.jpg`
  })
)

describe('actual app game return navigation', () => {
  let originals: PropertyDescriptorMap
  let signedIn: boolean
  const originalSocket = globalThis.WebSocket
  const user = asSessionUser({
    id: 101,
    displayName: 'Babe Ruth',
    isAdmin: false
  })
  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    signedIn = false
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    api.whoAmI = async () => {
      if (!signedIn) throw new HttpError('unauthorized', 'Sign in')
      return user
    }
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.highlights = async () => ({
      withheld: null,
      droppedCount: 0,
      highlights: []
    })
    api.game = async () => ({
      ...gameFixture,
      videos,
      nonMemberView: true,
      canScore: signedIn,
      scoreboard: { open: true, mayOverride: true }
    })
    api.requestEmailCode = async () => ({
      requestId: 'test-wait',
      clientSecret: 'test-secret'
    })
    api.signInWithCode = async () => {
      signedIn = true
      return { user, token: 'test-token', expiresAt: '2099-01-01' }
    }
  })
  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
  })
  it('returns sign-in to the nondefault public camera without unlocking playback', async () => {
    showRoute({ name: 'game', gameId: 'g1', tab: 'watch', videoId: 'v1' }, true)
    await mount(<App />)
    await act(async () => {
      const angle = document.querySelector<HTMLElement>(
        '[aria-label="Outfield"]'
      )
      expect(angle).not.equals(null)
      angle!.click()
    })
    await settle()
    expect(currentRoute()).includes({ videoId: 'v2' })
    await press('Play game video')
    await press('Log in / Sign up')
    expect(currentRoute().name).equals('signIn')
    await fill('E-mail address', 'reader@example.test')
    await press('Send me a sign-in code')
    await fill('Sign-in code', '000000')
    await press('Sign in')
    await settle()
    expect(currentRoute()).includes({
      name: 'game',
      gameId: 'g1',
      videoId: 'v2',
      tab: 'watch'
    })
    expect(
      document
        .querySelector('[aria-label="Outfield"]')
        ?.getAttribute('aria-selected')
    ).equals('true')
    expect(document.querySelector('video')).equals(null)
    await press('Play game video')
    expect(text()).includes('Request membership')
  })
  it('retains the camera and playback snapshot through both scoreboard Back steps', async () => {
    signedIn = true
    showRoute(
      {
        name: 'game',
        gameId: 'g1',
        tab: 'watch',
        videoId: 'v2',
        at: 37
      },
      true
    )
    await mount(<App />)
    await press('Score')
    await press('Scoreboard')
    expect(currentRoute().name).equals('scoreboardOverride')
    for (const name of ['scoreOptions', 'game']) {
      await act(async () => {
        window.history.back()
      })
      await settle(100)
      expect(currentRoute().name).equals(name)
    }
    expect(currentRoute()).includes({
      videoId: 'v2',
      at: 37,
      tab: 'watch'
    })
  })
})
