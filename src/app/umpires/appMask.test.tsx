import { expect } from 'chai'
import { it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../../common/api'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { App } from '../App'
import { UmpireMaskDrawing as NativeMask } from './UmpireMaskDrawing.native'
it('mounts the shell with role-only mask visibility and preserves header order at both widths', async () => {
  const proto = TeamStationClient.prototype
  const originals = Object.getOwnPropertyDescriptors(proto)
  proto.whoAmI = async () =>
    asSessionUser({
      id: userIdOfGumbo(1),
      displayName: 'Demo Fan',
      isAdmin: true
    })
  proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
  proto.hasNotifications = async () => false
  proto.teams = async () => []
  proto.seasons = async () => []
  proto.ownGroups = async () => []
  proto.follows = async () => []
  proto.recentGame = async () => null
  proto.liveNow = async () => []
  proto.umpireLeagues = async () => [
    { id: 'demo', name: 'Demo League', logoUrl: null }
  ]
  proto.umpireSettings = async () => ({ management: true, credits: true })
  proto.umpireLevels = async () => [
    { id: 'majors', name: 'majors', position: 0, inUse: true }
  ]
  proto.umpireRequirements = async () => [
    { id: 'spring', name: 'Spring', logoUrl: null, requirement: null }
  ]
  proto.umpirePeople = async () => []
  proto.setUmpireRequirements = async () => undefined
  proto.umpireSchedule = async () => ({
    settings: { management: true, credits: true },
    levels: [],
    viewerId: 'demo',
    isAdmin: true,
    view: 'league',
    creditTeams: [],
    games: []
  })
  proto.umpireLeaderboard = async () => ({
    completed: [],
    scheduled: [],
    teams: []
  })
  proto.group = async () =>
    asGroupDetail({
      group: asPublicGroup({
        id: 'demo',
        kind: 'league',
        name: 'Demo League',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      games: [],
      staff: [],
      canManage: true,
      nonMemberView: false
    })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    for (const width of [1280, 390]) {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: width
      })
      window.dispatchEvent(new window.Event('resize'))
      window.history.replaceState(null, '', '/')
      await act(async () => {
        root.render(<App key={width} />)
        await new Promise<void>(resolve => setTimeout(resolve, 100))
      })
      await act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 100))
      })
      const labels = [...host.querySelectorAll('[aria-label]')].map(n =>
        n.getAttribute('aria-label')
      )
      const mask = labels.indexOf('Umpire schedule')
      expect(mask).greaterThan(-1)
      expect(mask).lessThan(labels.indexOf('Notifications'))
      expect(labels.indexOf('Notifications')).lessThan(
        labels.indexOf('Account, Demo Fan')
      )
    }
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      })
    }
    const press = async (label: string): Promise<void> => {
      const node = [
        ...host.querySelectorAll<HTMLElement>(
          '[aria-label],[role="button"],[role="tab"]'
        )
      ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
      expect(node, label).not.equals(undefined)
      await act(async () => {
        node!.click()
      })
      await settle()
    }
    await press('Umpire schedule')
    await press('Leaderboard')
    expect(window.location.search).contains('leaderboard')
    for (const label of [
      'Create Umpire Levels',
      'Set Requirements',
      'Add Umpires',
      'Umpire schedule'
    ]) {
      window.history.replaceState(null, '', '/groups/league/demo/settings')
      await act(async () => {
        root.render(<App key={label} />)
      })
      await settle()
      await press(label)
      if (label === 'Set Requirements') {
        await press('Select Spring')
        await press('Next')
        await press('Apply umpire requirements to the below seasons')
      }
      expect(window.location.pathname).contains(
        label === 'Umpire schedule' ? '/umpires/demo' : '/groups/league/demo/'
      )
    }
    proto.umpireLeagues = async () => []
    await act(async () => {
      root.render(<App key="no-role" />)
    })
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })
    expect(host.querySelector('[aria-label="Umpire schedule"]')).equals(null)
    await act(async () => {
      root.render(<NativeMask size={24} color="#123456" />)
    })
    expect(host.querySelector('path')?.getAttribute('stroke')).equals('#123456')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    Object.defineProperties(proto, originals)
    window.history.replaceState(null, '', '/')
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280
    })
  }
})
