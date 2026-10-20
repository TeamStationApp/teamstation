import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asRosterEntry, asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { App, stackFor } from './App'

describe('the Search tab', () => {
  it('is a stack of its own, with Discover at its root and no Back there', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const league = asPublicGroup({
      id: 'league_demo',
      kind: 'league',
      name: 'Demo League',
      imageUrl: null,
      locality: null
    })
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Fan',
        isAdmin: false
      })
    // Roles that cannot be read leave the app as somebody holding none.
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
    proto.discoverGroups = async () => [league]
    proto.group = async () =>
      asGroupDetail({
        nonMemberView: false,
        group: league,
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canManage: false
      })
    const settle = async (ms = 80): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms))
      })
    }
    const control = (label: string): HTMLElement | undefined =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[role="button"], [role="tab"]'
        )
      ].find(node => node.getAttribute('aria-label') === label)
    const press = async (label: string): Promise<void> => {
      const node = control(label)
      expect(node, label).not.equals(undefined)
      await act(async () => {
        node!.click()
      })
      await settle(label === 'Search' ? 350 : 80)
    }
    window.history.replaceState(null, '', '/')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App />)
      })
      await settle()
      await press('Search')
      expect(window.location.pathname).equals('/discover')
      expect(control('Back')).equals(undefined)
      expect(document.body.textContent).includes('Demo League')

      await press('Open Demo League')
      expect(window.location.pathname).equals('/groups/league/league_demo')
      expect(control('Back')).not.equals(undefined)

      // Another tab and back again: Search kept what was opened in it.
      await press('Home')
      expect(window.location.pathname).equals('/')
      await press('Search')
      expect(window.location.pathname).equals('/groups/league/league_demo')

      // Pressing Search on Search goes back up its own stack.
      await press('Search')
      expect(window.location.pathname).equals('/discover')
      expect(control('Back')).equals(undefined)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      Object.defineProperties(proto, originals)
      window.history.replaceState(null, '', '/')
    }
  })
  it('opens a team from Search on the team’s own page, as anybody signed in who is not a member reads it', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const team = asPublicGroup({
      id: 'tem_hawks',
      kind: 'team',
      name: 'Demo Hawks',
      imageUrl: null,
      locality: null
    })
    const asked: string[] = []
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
    proto.discoverGroups = async () => [team]
    proto.group = async () =>
      asGroupDetail({
        nonMemberView: true,
        group: team,
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canManage: false
      })
    proto.teamGames = async () => []
    proto.roster = async () => [
      asRosterEntry({
        userId: userIdOfGumbo(201),
        gumboId: 201,
        shortName: 'Avery S',
        jersey: '7',
        positions: ['SS'],
        isPlayer: true,
        role: 'member',
        section: 'player',
        staffRoles: [],
        inheritedFrom: null,
        avatarUrl: null
      })
    ]
    for (const method of ['teamStats', 'teamPitchingStats'] as const)
      proto[method] = async () => {
        asked.push(method)
        throw new Error('Kept for members')
      }
    const settle = async (ms = 80): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms))
      })
    }
    const control = (label: string): HTMLElement | undefined =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[role="button"], [role="tab"]'
        )
      ].find(
        node => (node.getAttribute('aria-label') ?? node.textContent) === label
      )
    const press = async (label: string): Promise<void> => {
      const node = control(label)
      expect(node, label).not.equals(undefined)
      await act(async () => {
        node!.click()
      })
      await settle(label === 'Search' ? 350 : 80)
    }
    window.history.replaceState(null, '', '/')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App />)
      })
      await settle()
      await press('Search')
      await press('Open Demo Hawks')
      await press('Team')
      const text = document.body.textContent ?? ''
      // The members' page, less what is kept for members: the roster, and
      // not the public summary's staff list or its membership notes.
      expect(text).includes('PLAYERS')
      expect(text).includes('Avery S')
      expect(text).not.includes('Standalone team')
      expect(text).not.includes('membership is required')
      expect(control('Follow Demo Hawks')).not.equals(undefined)
      await press('Stats')
      expect(document.body.textContent).includes(
        'You need to be a member of this team to see individual player stats.'
      )
      expect(asked).deep.equals([])
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      Object.defineProperties(proto, originals)
      window.history.replaceState(null, '', '/')
    }
  })
  it('opens a discovery address on the Search tab, and following on Home', () => {
    expect(stackFor({ name: 'discover' })).deep.equals({})
    expect(
      stackFor({ name: 'discover', kind: 'team', follow: true })
    ).deep.equals({ home: [{ name: 'discover', kind: 'team', follow: true }] })
  })
})
