import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Platform } from 'react-native'

import {
  asHighlightsResponse,
  asPlayerDetail,
  asSessionUser,
  asVideoSummary,
  TeamStationClient
} from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { mount, settle, unmount } from '../test/gameFormDom'
import { pageOfGames } from '../test/pageOf'
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
    api.teamGamesPage = async (_id, query) => pageOfGames([], query)
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

  for (const platform of ['ios', 'web'] as const)
    it(`${platform === 'ios' ? 'in the app, opens a highlight chosen on a player page straight into the player' : 'in a browser, opens a highlight chosen on a player page in the game page’s picture'}, and Back returns there`, async () => {
      const was = Platform.OS
      Platform.OS = platform
      try {
        const api = TeamStationClient.prototype
        const player = userIdOfGumbo(7)
        // Signed in: a player's page is for members.
        api.whoAmI = async () =>
          asSessionUser({
            id: userIdOfGumbo(1),
            displayName: 'Babe Ruth',
            isAdmin: false
          })
        api.player = async () =>
          asPlayerDetail({
            userId: player,
            name: 'Mookie B',
            bats: 'right',
            throws: 'right',
            teams: [],
            guardianInviteAs: null
          })
        api.playerHighlights = async () => ({
          highlights: [
            {
              tag: null,
              eventId: 'e1',
              gameId: 'g1',
              videoId: 'v1',
              teamId: null,
              teamName: 'Dodgers',
              outcome: 'Double',
              title: 'Double: Mookie B',
              playAt: '2026-10-19T18:02:52Z',
              startOffsetSec: 142,
              playOffsetSec: 172,
              endOffsetSec: 177,
              stillUrl: ''
            }
          ],
          nextBefore: null,
          withoutVideo: 0
        })
        api.playerStats = async () => ({
          userId: player,
          filter: { seasonId: null, teamId: null, year: null },
          games: 1,
          batting: null,
          pitching: null,
          options: { seasons: [], teams: [], years: [] }
        })
        showRoute({ name: 'player', userId: player }, true)
        await mount(<App />)
        await settle(200)
        const row = [
          ...document.querySelectorAll<HTMLElement>('[role="button"]')
        ].find(node => (node.textContent ?? '').includes('Double'))
        expect(row, 'the highlight').not.equals(undefined)
        await act(async () => {
          row!.click()
        })
        await settle(400)
        if (platform === 'ios') {
          // The game page, and over it the player already open on the highlight.
          expect(currentRoute()).deep.include({
            name: 'game',
            angles: ['v1'],
            audio: 'v1'
          })
          expect(
            document.querySelector(`[aria-label="${lstrings.angles_close}"]`)
          ).not.equals(null)
          await act(async () => {
            document
              .querySelector<HTMLElement>(
                `[aria-label="${lstrings.angles_close}"]`
              )!
              .click()
          })
          await settle(200)
        } else {
          // The game page, with no player over it, and its picture at the
          // highlight, playing.
          expect(currentRoute()).deep.include({ name: 'game', gameId: 'g1' })
          expect(
            document.querySelector(`[aria-label="${lstrings.angles_close}"]`)
          ).equals(null)
          const video = document.querySelector('video')!
          let played = 0
          video.play = async () => {
            played += 1
          }
          await act(async () => {
            video.dispatchEvent(new window.Event('loadedmetadata'))
          })
          expect(video.currentTime).equals(142)
          expect(played).greaterThan(0)
        }
        expect(currentRoute()).deep.include({ name: 'game' })
        expect(window.location.search).not.includes('angles=')
        await act(async () => {
          window.history.back()
        })
        await settle(200)
        expect(currentRoute()).deep.include({ name: 'player', userId: player })
      } finally {
        Platform.OS = was
      }
    })
})
