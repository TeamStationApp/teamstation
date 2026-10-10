import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
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
      asSessionUser({ id: 1, displayName: 'Demo Fan', isAdmin: false })
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
  it('opens a discovery address on the Search tab, and following on Home', () => {
    expect(stackFor({ name: 'discover' })).deep.equals({})
    expect(
      stackFor({ name: 'discover', kind: 'team', follow: true })
    ).deep.equals({ home: [{ name: 'discover', kind: 'team', follow: true }] })
  })
})
