import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameDetail,
  asSessionUser,
  type GameDetail,
  TeamStationClient
} from '../common/api'
import type { StoredGame } from '../common/scoring/session'
import { userIdOfGumbo } from '../common/userId'
import {
  finalGame,
  REPLAY_GAME_ID,
  REPLAY_TEAMS
} from '../test/replayGameFixture'
import { App } from './App'

const settle = async (ms = 120): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

async function press(label: string): Promise<void> {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].find(
    node =>
      node.getAttribute('aria-label') === label || node.textContent === label
  )
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
}

const replayShown = (): boolean =>
  document.querySelector('[data-testid="game-replay"]') != null

describe('the app’s game replay', function () {
  this.timeout(30000)
  const proto = TeamStationClient.prototype
  const originals = Object.getOwnPropertyDescriptors(proto)
  let game: GameDetail
  let stored: StoredGame
  let host: HTMLElement
  let root: Root

  beforeEach(async function () {
    stored = await finalGame()
    game = asGameDetail({
      id: REPLAY_GAME_ID,
      nonMemberView: false,
      awayTeamId: REPLAY_TEAMS.away.id,
      homeTeamId: REPLAY_TEAMS.home.id,
      awayTeamName: REPLAY_TEAMS.away.name,
      homeTeamName: REPLAY_TEAMS.home.name,
      seasonId: null,
      startAt: '2026-05-10T18:00:00Z',
      endAt: null,
      venue: null,
      status: 'final',
      homeScore: 3,
      awayScore: 2,
      videos: [],
      ingestStatus: 'none',
      ingestMessage: null,
      canScore: false,
      replayable: true
    })
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(101),
        displayName: 'Babe Ruth',
        isAdmin: false
      })
    proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
    proto.hasNotifications = async () => false
    proto.teams = async () => []
    proto.game = async () => game
    proto.gameEvents = async () => stored
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async function () {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    window.history.replaceState(null, '', '/')
    for (const [name, descriptor] of Object.entries(originals))
      Object.defineProperty(proto, name, descriptor)
  })

  it('opens from its address, and Exit lands on the game', async function () {
    window.history.replaceState(null, '', `/games/${REPLAY_GAME_ID}/replay`)
    await act(async () => {
      root.render(<App />)
    })
    await settle()
    expect(replayShown()).equals(true)
    await press('Exit')
    await settle()
    expect(replayShown()).equals(false)
    expect(window.location.pathname).equals(`/games/${REPLAY_GAME_ID}`)
  })

  it('opens from the game’s Replay pill', async function () {
    window.history.replaceState(null, '', `/games/${REPLAY_GAME_ID}`)
    await act(async () => {
      root.render(<App />)
    })
    await settle()
    await press('Replay')
    await settle()
    expect(replayShown()).equals(true)
    expect(window.location.pathname).equals(`/games/${REPLAY_GAME_ID}/replay`)
  })

  it('goes back to the game when the replay cannot load, and one Back leaves the game', async function () {
    window.history.replaceState(null, '', `/games/${REPLAY_GAME_ID}`)
    await act(async () => {
      root.render(<App />)
    })
    await settle()
    proto.gameEvents = async () => {
      throw new Error('offline')
    }
    await press('Replay')
    await settle()
    expect(replayShown()).equals(false)
    expect(window.location.pathname).equals(`/games/${REPLAY_GAME_ID}`)
    await press('Back')
    await settle()
    expect(window.location.pathname).not.equals(`/games/${REPLAY_GAME_ID}`)
  })

  it('shows the game instead when there is nothing to replay', async function () {
    game = { ...game, replayable: false }
    window.history.replaceState(null, '', `/games/${REPLAY_GAME_ID}/replay`)
    await act(async () => {
      root.render(<App />)
    })
    await settle()
    expect(replayShown()).equals(false)
    expect(window.location.pathname).equals(`/games/${REPLAY_GAME_ID}`)
  })
})
