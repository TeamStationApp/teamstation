import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  asHighlightsResponse,
  asSessionUser,
  asVideoSummary,
  TeamStationClient
} from '../common/api'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { mount, settle, unmount } from '../test/gameFormDom'
import { App } from './App'
import { lstrings } from './locales/strings'
import { currentRoute, showRoute } from './navigation/useAddressBar'
import { gameFixture } from './scoring/isUnscoredGame.test'

/**
 * The shell's side of the full-screen player opened from the videos page
 * (U12): the opening is a page of its own in the history, the address names
 * the angle and never where it came from, and closing clears it.
 */
describe('the full-screen player in the shell (U12)', () => {
  let originals: PropertyDescriptorMap
  const originalSocket = globalThis.WebSocket
  const video = asVideoSummary({
    id: 'v1',
    title: 'Game — Home Plate',
    numCameras: 1,
    kind: 'primary',
    status: 'ready',
    storage: 'local',
    startAt: '2026-10-19T18:00:00Z',
    durationSec: 300,
    width: 1920,
    height: 1080,
    codecs: null
  })

  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    api.whoAmI = async () =>
      asSessionUser({ id: 101, displayName: 'Babe Ruth', isAdmin: false })
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.follows = async () => []
    api.ownGroups = async () => []
    api.teamGames = async () => []
    api.roster = async () => []
    api.game = async () => ({
      ...gameFixture,
      status: 'final',
      canScore: false,
      videos: [video]
    })
    api.highlights = async () =>
      asHighlightsResponse({ withheld: null, droppedCount: 0, highlights: [] })
    api.gameScheduling = async () => {
      throw new Error('not a scheduler')
    }
    api.playback = async videoId => ({
      videoId,
      storage: 'local',
      url: `/media/${videoId}/master.m3u8`,
      expiresAt: '2026-10-19T20:00:00Z',
      durationSec: 300,
      unavailable: false
    })
  })
  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
  })

  it('opens as a page of its own, names the angle alone, and closes back to the videos page', async () => {
    showRoute({ name: 'game', gameId: 'g1', tab: 'watch', videoId: 'v1' }, true)
    await mount(<App />)
    await settle(200)
    const pages = window.history.length
    const openedOver = (window.history.state as { tsRouteIndex?: number })
      ?.tsRouteIndex
    const open = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoOpen"]'
    )
    expect(open, 'the picture opens the player').not.equals(null)
    await act(async () => {
      open!.click()
    })
    await settle(100)
    expect(currentRoute()).deep.include({ angles: ['v1'], audio: 'v1' })
    expect(window.location.search).includes('angles=v1')
    expect(window.location.search).not.includes('from')
    expect(window.history.length, 'a page of its own').equals(pages + 1)

    await act(async () => {
      document
        .querySelector<HTMLElement>(`[aria-label="${lstrings.angles_close}"]`)!
        .click()
    })
    await settle(100)
    expect(window.location.search).not.includes('angles=')
    expect(document.querySelector('[data-testid="gameVideoOpen"]')).not.equals(
      null
    )
    // Back on the step it was opened over, rather than a copy of it pushed
    // or written over the player's: Back from here leaves the videos page.
    expect(
      (window.history.state as { tsRouteIndex?: number })?.tsRouteIndex,
      'the step the player was opened over'
    ).equals(openedOver)
    expect(window.location.search).includes('video=v1')
    // And the player is still the step ahead: Forward reopens it, rather
    // than walking into a copy of the videos page.
    await act(async () => {
      window.history.forward()
    })
    await settle(100)
    expect(window.location.search).includes('angles=v1')
  })
})
