import { expect } from 'chai'
import { it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../../common/api'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { pageOfUmpireSchedule } from '../../test/pageOf'
import { fixtureTypes } from '../../test/umpireTypes'
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
  proto.umpirePeople = async () => [
    {
      id: 'umpire-person',
      name: 'Demo Umpire',
      avatarUrl: null,
      affiliations: '',
      certifications: []
    }
  ]
  proto.umpireNoteTypes = async () => []
  proto.umpireTypes = async () => fixtureTypes
  proto.setUmpireRequirements = async () => undefined
  proto.umpireSchedulePage = async (_league, _query, page) =>
    pageOfUmpireSchedule(
      {
        settings: { management: true, credits: true },
        levels: [],
        types: fixtureTypes,
        noteTypes: [{ id: 'color', name: 'Color', position: 0, inUse: false }],
        viewerId: 'demo',
        isAdmin: true,
        view: 'league',
        creditTeams: [],
        games: [
          {
            id: 'demo-game',
            seasonId: 'spring',
            seasonName: 'Spring',
            levelId: 'majors',
            levelName: 'majors',
            startAt: '2099-04-01T12:00:00Z',
            endAt: null,
            timezone: 'UTC',
            date: 'Apr 1, 12:00 pm',
            status: 'scheduled',
            home: 'Demo Hawks',
            away: 'Demo Eagles',
            homeTeamId: 'hawks',
            awayTeamId: 'eagles',
            venue: '',
            notes: '',
            umpireNotes: {},
            positions: [],
            assignments: {},
            choices: {},
            conflicts: []
          }
        ]
      },
      page
    )
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
      // No mask in the header: Home offers the schedule as Help Umpire.
      expect(labels.indexOf('Umpire schedule')).equals(-1)
      expect(labels.indexOf('Umpire Schedule')).greaterThan(-1)
      expect(host.textContent).match(/help umpire/i)
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
    await press('Umpire Schedule')
    expect(window.location.pathname).equals('/umpires/demo')
    expect(host.textContent).contains('Umpire')
    await press('Leaderboard')
    expect(window.location.search).contains('leaderboard')
    for (const label of [
      'Manage Umpire Game Notes',
      'Manage Umpire Types',
      'Manage Umpire Levels',
      'Set Season Requirements',
      'Manage Umpires',
      'Umpire schedule'
    ]) {
      window.history.replaceState(null, '', '/groups/league/demo/settings')
      await act(async () => {
        root.render(<App key={label} />)
      })
      await settle()
      await press(label)
      if (label === 'Set Season Requirements') {
        await press('Select Spring')
        await press('Next')
        await press('Apply umpire requirements to the below seasons')
      }
      if (label === 'Manage Umpires') {
        await press('Open profile for Demo Umpire')
        expect(window.location.pathname).equals(
          '/leagues/demo/people/umpire-person'
        )
        continue
      }
      expect(window.location.pathname).contains(
        label === 'Umpire schedule' ? '/umpires/demo' : '/groups/league/demo/'
      )
    }
    for (const [label, path] of [
      ['Open Demo Hawks', '/teams/hawks'],
      ['Open game Apr 1, 12:00 pm', '/games/demo-game'],
      ['Home', '/'],
      ['Back', '/']
    ]) {
      window.history.replaceState(null, '', '/umpires/demo')
      await act(async () => {
        root.render(<App key={label} />)
      })
      await settle()
      let fail = true
      const writes: string[] = []
      proto.saveUmpireNote = async (_game, _type, _before, value) => {
        if (fail) throw new Error('Save refused')
        writes.push(value)
        return { value }
      }
      await press('Edit Color, Demo Hawks vs Demo Eagles, Apr 1, 12:00 pm')
      await act(async () => {
        const input = host.querySelector<HTMLInputElement>(
          'input[data-testid^="umpire-note-input"]'
        )!
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, 'Blue')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await press(label)
      expect(window.location.pathname).equals('/umpires/demo')
      expect(host.textContent).contains('Save refused')
      fail = false
      await press(label)
      expect(window.location.pathname).equals(path)
      expect(writes).deep.equals(['Blue'])
    }
    // Back twice while the save is still deciding: one step, one save. The
    // schedule over the league's settings, so a second pop would leave
    // those as well.
    window.history.replaceState(null, '', '/groups/league/demo/settings')
    await act(async () => {
      root.render(<App key="twice" />)
    })
    await settle()
    await press('Umpire schedule')
    expect(window.location.pathname).equals('/umpires/demo')
    const saves: Array<() => void> = []
    const written: string[] = []
    proto.saveUmpireNote = async (_game, _type, _before, value) =>
      await new Promise(resolve => {
        saves.push(() => {
          written.push(value)
          resolve({ value })
        })
      })
    await press('Edit Color, Demo Hawks vs Demo Eagles, Apr 1, 12:00 pm')
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>(
        'input[data-testid^="umpire-note-input"]'
      )!
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'Green')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await press('Back')
    expect(window.location.pathname).equals('/umpires/demo')
    await press('Back')
    await act(async () => {
      for (const save of saves) save()
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })
    await settle()
    expect(written).deep.equals(['Green'])
    expect(window.location.pathname).equals('/groups/league/demo/settings')
    // The browser's Back while the chevron's save decides: refused and put
    // back, so the screen moves one step, the address with it, and Back
    // still answers after.
    await act(async () => {
      root.render(<App key="browser" />)
    })
    await settle()
    await press('Umpire schedule')
    saves.length = 0
    written.length = 0
    await press('Edit Color, Demo Hawks vs Demo Eagles, Apr 1, 12:00 pm')
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>(
        'input[data-testid^="umpire-note-input"]'
      )!
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, 'Red')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await press('Back')
    await act(async () => {
      window.history.back()
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })
    await act(async () => {
      for (const save of saves) save()
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })
    await settle()
    expect(written).deep.equals(['Red'])
    expect(window.location.pathname).equals('/groups/league/demo/settings')
    await press('Back')
    expect(window.location.pathname).not.equals('/groups/league/demo/settings')
    window.history.replaceState(null, '', '/')
    proto.umpireLeagues = async () => []
    await act(async () => {
      root.render(<App key="no-role" />)
    })
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })
    expect(host.querySelector('[aria-label="Umpire schedule"]')).equals(null)
    expect(host.querySelector('[aria-label="Umpire Schedule"]')).equals(null)
    expect(host.textContent).not.match(/help umpire/i)
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
}).timeout(10000)
