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
  let member: boolean
  const originalSocket = globalThis.WebSocket
  const media = window.HTMLMediaElement.prototype
  const originalMedia = Object.getOwnPropertyDescriptors(media)
  const user = asSessionUser({
    id: 101,
    displayName: 'Babe Ruth',
    isAdmin: false
  })
  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    signedIn = false
    member = false
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    api.whoAmI = async () => {
      if (!signedIn) throw new HttpError('unauthorized', 'Sign in')
      return user
    }
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.roster = async () => []
    api.defaultLineup = async () => ({
      lineup: null,
      fromGameId: null,
      setAt: null
    })
    api.gameEvents = async () => ({ plays: [], currentPlay: null })
    api.serverTime = async () => Date.now()
    api.playback = async videoId => ({
      videoId,
      storage: 'local',
      url: '/sample.mp4',
      expiresAt: null,
      durationSec: 300,
      unavailable: false
    })
    api.highlights = async () => ({
      withheld: null,
      droppedCount: 0,
      highlights: []
    })
    api.game = async () => ({
      ...gameFixture,
      videos,
      nonMemberView: !member,
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
    Object.defineProperties(media, originalMedia)
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
  for (const child of ['Scoreboard', 'Full game scoring'])
    for (const playing of [false, true])
      it(`retains camera, position and playing=${playing} through both ${child} Back steps`, async () => {
        signedIn = true
        member = true
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
        let plays = 0
        media.play = async () => {
          plays++
        }
        media.pause = () => undefined
        const video = document.querySelector('video')!
        expect(video).not.equals(null)
        Object.defineProperty(video, 'paused', {
          configurable: true,
          value: !playing
        })
        video.currentTime = 43
        await press('Score')
        await press(child)
        expect(currentRoute().name).equals(
          child === 'Scoreboard' ? 'scoreboardOverride' : 'scoreGame'
        )
        if (child === 'Full game scoring') {
          await settle(100)
          expect(
            document.querySelector('[aria-label="Open scoring menu"]')
          ).not.equals(null)
        }
        for (const name of ['scoreOptions', 'game']) {
          await act(async () => {
            window.history.back()
          })
          await settle(100)
          expect(currentRoute().name).equals(name)
        }
        expect(currentRoute()).includes({
          videoId: 'v2',
          at: 43,
          tab: 'watch'
        })
        const restored = document.querySelector('video')!
        expect(restored).not.equals(null)
        await act(async () => {
          restored.dispatchEvent(new window.Event('loadedmetadata'))
        })
        expect(restored.currentTime).equals(43)
        expect(plays).equals(playing ? 1 : 0)
      })
  it('has a safe Back fallback when scoring choices were opened directly', async () => {
    signedIn = true
    showRoute({ name: 'scoreOptions', gameId: 'g1' }, true)
    await mount(<App />)
    await press('Scoreboard')
    await act(async () => {
      window.history.back()
    })
    await settle(100)
    expect(currentRoute().name).equals('scoreOptions')
    await press('Back')
    expect(currentRoute()).includes({ name: 'game', gameId: 'g1' })
  })
})
