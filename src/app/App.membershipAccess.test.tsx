import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { asDjGame, asSessionUser, TeamStationClient } from '../common/api'
import { HttpError } from '../common/errors'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { fill, mount, press, settle, text, unmount } from '../test/gameFormDom'
import { pageOfGames } from '../test/pageOf'
import { App } from './App'
import { currentRoute, showRoute } from './navigation/useAddressBar'
import { gameFixture } from './scoring/isUnscoredGame.test'
import walkUpMusic from './walkup/walkUpMusic'

describe('actual app membership sign-in return', () => {
  let originals: PropertyDescriptorMap
  let signedIn: boolean
  let djSupported: boolean
  const originalSocket = globalThis.WebSocket
  const user = asSessionUser({
    id: userIdOfGumbo(101),
    displayName: 'Babe Ruth',
    isAdmin: false
  })
  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    signedIn = false
    djSupported = walkUpMusic.djSupported
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    api.whoAmI = async () => {
      if (!signedIn) throw new HttpError('unauthorized', 'Sign in')
      return user
    }
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.follows = async () => []
    api.ownGroups = async () => []
    api.teamGamesPage = async (_id, query) => pageOfGames([], query)
    api.roster = async () => []
    api.game = async () => ({
      ...gameFixture,
      nonMemberView: true,
      canScore: false
    })
    api.group = async ref =>
      asGroupDetail({
        group: { ...ref, name: 'Demo Owls', imageUrl: null, locality: null },
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canManage: false,
        nonMemberView: signedIn
      })
    api.requestEmailCode = async () => ({
      requestId: 'test-wait',
      clientSecret: 'test-wait-secret'
    })
    api.signInWithCode = async () => {
      signedIn = true
      return { user, token: 'test-session-token', expiresAt: '2099-01-01' }
    }
  })
  afterEach(async () => {
    await unmount()
    Object.defineProperties(TeamStationClient.prototype, originals)
    walkUpMusic.djSupported = djSupported
    globalThis.WebSocket = originalSocket
  })
  it('opens the DJ screen when both the device and game grant the capability', async () => {
    signedIn = true
    walkUpMusic.djSupported = true
    TeamStationClient.prototype.game = async () => ({
      ...gameFixture,
      canScore: true,
      canDj: true,
      assignedRoles: { away: [], home: ['scorekeeper', 'songkeeper'] }
    })
    TeamStationClient.prototype.djGame = async () =>
      asDjGame({
        away: {
          teamId: 'away',
          teamName: 'Demo Owls',
          source: 'lineup',
          canEditWalkUp: true,
          batters: [
            { userId: userIdOfGumbo(101), name: 'Mookie B', walkUpSong: null }
          ]
        },
        home: {
          teamId: 'home',
          teamName: 'Demo Hawks',
          source: 'lineup',
          canEditWalkUp: false,
          batters: []
        }
      })
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await mount(<App apiBaseUrl="http://localhost/api/v1" />)
    await press('DJ')
    expect(currentRoute()).includes({ name: 'djGame', gameId: 'g1' })
    expect(document.querySelector('[data-testid="DJ list"]')).not.equals(null)
    expect(text()).includes('Mookie B')
  })
  it('returns browser Back from scoring choices to the existing game page', async () => {
    signedIn = true
    TeamStationClient.prototype.game = async () => gameFixture
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await mount(<App />)
    await press('Score')
    expect(currentRoute()).includes({ name: 'scoreOptions' })
    await act(async () => {
      window.history.back()
    })
    await settle(100)
    expect(currentRoute()).includes({ name: 'game', gameId: 'g1' })
    expect(text()).includes('Owls')
    expect(text()).not.includes('Full game scoring')
  })
  for (const action of ['Score', 'Coach'] as const)
    it(`keeps ${action} available when a signed-in reader opens a DJ address on the web`, async () => {
      signedIn = true
      TeamStationClient.prototype.game = async () => ({
        ...gameFixture,
        canScore: true,
        coachSides: ['home'],
        assignedRoles: { away: [], home: ['scorekeeper', 'coach'] }
      })
      showRoute({ name: 'djGame', gameId: 'g1' }, true)
      await mount(<App />)
      await press(action)
      expect(currentRoute()).includes({
        name: action === 'Score' ? 'scoreOptions' : 'coachGame',
        gameId: 'g1'
      })
    })
  for (const location of ['game', 'team'] as const)
    it(`returns a guest to the same ${location} page after signing in, with membership still required`, async () => {
      const destination =
        location === 'team'
          ? { name: 'team' as const, teamId: 'home', tab: 'stats' as const }
          : { name: 'game' as const, gameId: 'g1', tab: 'boxScore' as const }
      showRoute(destination, true)
      await mount(<App />)
      await settle(100)
      const before = window.location.pathname + window.location.search
      expect(text()).includes('Log in or create an account first')
      await press('Log in / Sign up')
      expect(currentRoute()).deep.equals({ name: 'signIn', next: before })
      await fill('E-mail address', 'reader@example.test')
      await press('Send me a sign-in code')
      await fill('Sign-in code', '000000')
      await press('Sign in')
      await settle(100)
      expect(window.location.pathname + window.location.search).equals(before)
      expect(text()).includes('Request membership')
      expect(text()).not.includes('Log in / Sign up')
    })
})
