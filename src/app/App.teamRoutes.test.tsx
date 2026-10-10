import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { App, stackFor } from './App'

describe('team route frames', () => {
  it('retains the team or group return frame through settings address reconstruction', () => {
    for (const address of ['team', 'group'] as const) {
      const route = {
        name: 'groupSettings' as const,
        kind: 'team' as const,
        id: 'canonical',
        teamReturn: { id: 'alias', address, tab: 'schedule' }
      }
      const stack = stackFor(route).home!
      expect(stack[0]).deep.equals(
        stackFor(
          address === 'team'
            ? { name: 'team', teamId: 'alias', tab: 'schedule' }
            : { name: 'group', kind: 'team', id: 'alias', tab: 'schedule' }
        ).home![0]
      )
      expect(stack[1]).deep.equals(route)
    }
  })
  it('opens a team address before requesting private lists, retaining its tab', () => {
    const top = stackFor({ name: 'team', teamId: 'demo_alias', tab: 'roster' })
      .home?.[0]
    expect(top?.name).equals('team')
    if (top?.name !== 'team') throw new Error('Expected team frame')
    expect(top.team).includes({
      id: 'demo_alias',
      name: '',
      canViewPrivate: false
    })
    expect(top.tab).equals('roster')
  })
  it('puts the public/private team adapter underneath a direct settings address', () => {
    expect(
      stackFor({ name: 'groupSettings', kind: 'team', id: 'demo_team' }).home
    ).deep.equals([
      { name: 'group', kind: 'team', id: 'demo_team' },
      { name: 'groupSettings', kind: 'team', id: 'demo_team' }
    ])
  })
  it('retains ordinary group and game settings frame behavior', () => {
    expect(
      stackFor({ name: 'group', kind: 'league', id: 'demo_league' }).home
    ).deep.equals([{ name: 'group', kind: 'league', id: 'demo_league' }])
    expect(
      stackFor({ name: 'gameSettings', gameId: 'demo_game' }).home?.map(
        frame => frame.name
      )
    ).deep.equals(['game', 'gameSettings'])
  })
})

describe('team settings browser history', () => {
  it('returns to the original section after Back, Forward and Cancel or Save', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const detail = asGroupDetail({
      group: {
        kind: 'team',
        id: 'canonical',
        name: 'Demo Hawks',
        imageUrl: null,
        locality: null
      },
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      games: [],
      staff: [],
      canViewPrivate: false,
      canManage: true
    })
    proto.whoAmI = async () =>
      asSessionUser({ id: 1, displayName: 'Demo Admin', isAdmin: false })
    proto.myRoles = async () => ({ teams: {} })
    proto.hasNotifications = async () => false
    proto.group = async () => detail
    proto.gameProposals = async () => []
    proto.updateGroup = async () => detail.group
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
      })
    }
    const press = async (label: string): Promise<void> => {
      const button = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="button"], [role="tab"]'
        )
      ].find(
        node => (node.getAttribute('aria-label') ?? node.textContent) === label
      )
      expect(button, label).not.equals(undefined)
      await act(async () => {
        button!.click()
      })
      await settle()
    }
    try {
      for (const [path, tab, submit] of [
        ['/teams/alias?tab=schedule', 'Schedule', 'Cancel'],
        ['/groups/team/alias?tab=stats', 'Stats', 'Save settings']
      ]) {
        window.history.replaceState(null, '', path)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        try {
          await act(async () => {
            root.render(<App />)
          })
          await settle()
          await press('Team settings')
          await act(async () => {
            window.history.back()
            await new Promise(resolve => setTimeout(resolve, 60))
          })
          await settle()
          expect(window.location.pathname + window.location.search).equals(path)
          await act(async () => {
            window.history.forward()
            await new Promise(resolve => setTimeout(resolve, 60))
          })
          await settle()
          expect(window.location.pathname).equals(
            '/groups/team/canonical/settings'
          )
          await press(submit)
          expect(window.location.pathname + window.location.search).equals(path)
          expect(
            document.querySelector(
              '[aria-label="Team sections"] [aria-selected="true"]'
            )?.textContent
          ).equals(tab)
          // Distinct visits can even have identical addresses. Completion
          // belongs to the visit that submitted, never an earlier entry.
          for (const laterTab of [tab, 'Team']) {
            await press('Team settings')
            const priorAddress =
              window.location.pathname + window.location.search
            const priorIndex = (
              window.history.state as { tsRouteIndex: number }
            ).tsRouteIndex
            await press('Cancel')
            if (laterTab !== tab) await press(laterTab)
            await press('Team settings')
            let finishSave!: () => void
            proto.updateGroup = async () => {
              await new Promise<void>(resolve => {
                finishSave = resolve
              })
              return detail.group
            }
            await press('Save settings')
            const currentIndex = (
              window.history.state as { tsRouteIndex: number }
            ).tsRouteIndex
            await act(async () => {
              window.history.go(priorIndex - currentIndex)
              await new Promise(resolve => setTimeout(resolve, 60))
            })
            await settle()
            expect(window.location.pathname + window.location.search).equals(
              priorAddress
            )
            await act(async () => {
              finishSave()
            })
            await settle()
            expect(window.location.pathname + window.location.search).equals(
              priorAddress
            )
            await press('Cancel')
            expect(window.location.pathname + window.location.search).equals(
              path
            )
          }
          proto.updateGroup = async () => detail.group
          await press('Team settings')
          const earlierSettings =
            window.location.pathname + window.location.search
          await press('Cancel')
          await press('Team')
          await press('Team settings')
          await act(async () => {
            window.history.go(-3)
            await new Promise(resolve => setTimeout(resolve, 60))
          })
          await settle()
          expect(window.location.pathname + window.location.search).equals(
            earlierSettings
          )
          await press('Cancel')
          expect(window.location.pathname + window.location.search).equals(path)
          expect(
            document.querySelector(
              '[aria-label="Team sections"] [aria-selected="true"]'
            )?.textContent
          ).equals(tab)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      }
    } finally {
      Object.defineProperties(proto, originals)
      window.history.replaceState(null, '', '/')
    }
  })
})
