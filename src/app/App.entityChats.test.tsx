import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  asSeasonSummary,
  asSessionUser,
  TeamStationClient
} from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { App } from './App'
import { ChatEngine, type ConversationListItem } from './chat/engine/engine'

// The real shell and route adapters, with access and conversation boundaries controlled.
describe('entity chat app routing', () => {
  it('opens scoped rows on the originating stack and returns directly with Back', async () => {
    const viewportDescriptors = Object.fromEntries(
      ['visualViewport', 'innerWidth', 'innerHeight'].map(key => [
        key,
        Object.getOwnPropertyDescriptor(window, key)
      ])
    )
    const visual = Object.assign(new window.EventTarget(), {
      height: 844,
      width: 390,
      scale: 1,
      offsetTop: 0
    })
    Object.defineProperties(window, {
      visualViewport: { configurable: true, value: visual },
      innerWidth: { configurable: true, value: 390 },
      innerHeight: { configurable: true, value: 844 }
    })
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const engineProto = ChatEngine.prototype
    const engineOriginals = Object.getOwnPropertyDescriptors(engineProto)
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo User',
        isAdmin: false
      })
    proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
    proto.hasNotifications = async () => false
    proto.group = async ({ kind, id }) =>
      asGroupDetail({
        group: { kind, id, name: 'Demo Group', locality: null, imageUrl: null },
        nonMemberView: true,
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canViewPrivate: false,
        canManage: false,
        canSeePeople: true
      })
    proto.teamGames = async () => []
    proto.teamSchedule = async () => []
    proto.teamStaff = async () => []
    proto.roster = async () => []
    proto.seasonTeams = async () => []
    proto.seasonGames = async () => []
    proto.standings = async () => []
    proto.seasons = async () => [
      asSeasonSummary({
        id: 'group_demo',
        name: 'Demo Season',
        leagueId: null,
        year: 2027,
        term: null,
        ageGroup: null,
        teams: 0,
        games: 0,
        videos: 0
      })
    ]
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 40))
      })
    }
    try {
      for (const [path, kind] of [
        ['/groups/league/group_demo', 'league'],
        ['/groups/team/group_demo', 'team'],
        ['/teams/group_demo', 'team'],
        ['/groups/season/group_demo', 'season'],
        ['/seasons/group_demo', 'season']
      ] as const) {
        engineProto.refresh = async () =>
          [
            {
              id: 'cnv_exact',
              kind:
                kind === 'league'
                  ? 'leagueOrg'
                  : kind === 'season'
                    ? 'seasonStaff'
                    : 'teamFans',
              title: 'Demo Group Chat',
              scope: { type: kind, id: 'group_demo' },
              scopeName: 'Demo Group',
              lastSeq: 0,
              lastMessageAt: null,
              unread: 0,
              canPost: false,
              canModerate: false,
              locked: true,
              noHolder: false,
              closed: false,
              memberCount: 2,
              unverified: false
            }
          ] as ConversationListItem[]
        window.history.replaceState(null, '', path + '?tab=chats')
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        try {
          await act(async () => {
            root.render(<App />)
          })
          await settle()
          const row = document.querySelector<HTMLElement>(
            '[data-testid="entity-chat-cnv_exact"]'
          )
          expect(row, path).not.equals(null)
          expect(row!.textContent).not.contains('Demo Group Chat')
          await act(async () => {
            row!.click()
          })
          await settle()
          expect(window.location.pathname).equals('/chat/cnv_exact')
          // Entity-origin chats keep Home selected, but still hide its floating
          // navigation while an editor's keyboard covers the viewport.
          expect(host.querySelector('[role="tablist"]')).not.equals(null)
          const editor = document.createElement('textarea')
          host.append(editor)
          await act(async () => {
            editor.focus()
            visual.height = 500
            visual.dispatchEvent(new window.Event('resize'))
          })
          expect(host.querySelector('[role="tablist"]')).equals(null)
          await act(async () => {
            editor.blur()
            visual.height = 844
            visual.dispatchEvent(new window.Event('resize'))
          })
          editor.remove()
          expect(host.querySelector('[role="tablist"]')).not.equals(null)
          await act(async () => {
            document.querySelector<HTMLElement>('[aria-label="Back"]')!.click()
          })
          await settle()
          expect(window.location.pathname + window.location.search).equals(
            path + '?tab=chats'
          )
          expect(
            document.querySelector('[data-testid="entity-chat-cnv_exact"]')
          ).not.equals(null)
          await act(async () => {
            window.history.forward()
          })
          await settle()
          await act(async () => {
            window.history.back()
          })
          await settle()
          await act(async () => {
            document.querySelector<HTMLElement>('[aria-label="Back"]')!.click()
          })
          await settle()
          expect(
            window.location.pathname,
            'the source has only one frame'
          ).equals('/')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      }
    } finally {
      for (const [key, descriptor] of Object.entries(viewportDescriptors)) {
        if (descriptor == null) Reflect.deleteProperty(window, key)
        else Object.defineProperty(window, key, descriptor)
      }
      Object.defineProperties(proto, originals)
      Object.defineProperties(engineProto, engineOriginals)
      window.history.replaceState(null, '', '/')
    }
  }).timeout(15000)
})
