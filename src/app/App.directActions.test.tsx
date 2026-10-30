import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asAccountSettings } from '../common/accountSettings'
import { asAddedPerson, asSessionUser, TeamStationClient } from '../common/api'
import { asNotification } from '../common/notifications'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { fill, press, settle } from '../test/gameFormDom'
import { pageOfGames } from '../test/pageOf'
import { App } from './App'

describe('direct action app completion navigation', () => {
  for (const flow of [
    'relationship',
    'promotion',
    'people',
    'resendGame',
    'resendConnection'
  ] as const)
    for (const status of flow === 'people'
      ? ['accepted']
      : ['pending', 'accepted'])
      it(`${flow} ${status} returns to its connection or opens only a genuinely pending request`, async () => {
        const proto = TeamStationClient.prototype
        const originals = Object.getOwnPropertyDescriptors(proto)
        proto.whoAmI = async () =>
          asSessionUser({
            id: userIdOfGumbo(101),
            displayName: 'Babe Ruth',
            isAdmin: false
          })
        proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
        proto.hasNotifications = async () => false
        proto.teams = async () => []
        proto.roster = async () => []
        proto.seasonTeams = async () => []
        proto.seasonGamesPage = async (_id, query) => pageOfGames([], query)
        proto.gameProposals = async () => []
        proto.follows = async () => []
        proto.ownGroups = async () => [
          asPublicGroup({
            kind: 'team',
            id: 'team_demo',
            name: 'Demo Visitors',
            imageUrl: null,
            locality: null
          })
        ]
        proto.accountSettings = async () =>
          asAccountSettings({
            user: {
              id: userIdOfGumbo(101),
              displayName: 'Babe Ruth',
              avatarUrl: null,
              isAdmin: false
            },
            emails: [
              {
                id: 'email_demo',
                email: 'admin@example.test',
                isPrimary: true,
                isVerified: true
              }
            ],
            hasPassword: false
          })
        proto.group = async ref =>
          asGroupDetail({
            group: {
              ...ref,
              name: ref.kind === 'team' ? 'Demo Visitors' : 'Demo Season',
              imageUrl: null,
              locality: null
            },
            nonMemberView: false,
            parents: [],
            children: [],
            competingTeams: [],
            participatingSeasons: [],
            games: [],
            staff: [],
            canManage: true
          })
        proto.inviteRelationship = async () => ({ id: 'request_demo', status })
        proto.notification = async id =>
          asNotification({
            id,
            requestId: id,
            type: flow === 'resendGame' ? 'game' : 'participation',
            title: 'Demo Visitors connection',
            description: 'Demo Season',
            sentAt: '2027-04-10T19:00:00Z',
            expiresAt: '2027-04-17T19:00:00Z',
            status: 'declined',
            canAct: false,
            canWithdraw: false,
            canResend: id === 'old_request',
            viewed: true
          })
        proto.viewNotification = async () => {}
        proto.decideRelationship = async () => ({
          id: 'request_demo',
          status,
          notice: 'Connection saved: Demo Visitors in Demo Season',
          source:
            status === 'accepted'
              ? { kind: 'season', id: 'season_demo' }
              : undefined
        })
        proto.decideGameRequest = async () => ({
          id: 'request_demo',
          status,
          notice: 'Game saved: Demo Visitors in Demo Season',
          gameId: status === 'accepted' ? 'game_new' : null,
          proposedGameId: 'game_new',
          replacesGameId: null
        })
        proto.addPerson = async () =>
          asAddedPerson({
            added: true,
            person: {
              userId: userIdOfGumbo(102),
              displayName: 'Lou Gehrig',
              email: 'recipient@example.test'
            }
          })
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        try {
          const path =
            flow === 'relationship'
              ? '/groups/season/season_demo/link?target=team&relationship=participation&direction=children'
              : flow === 'promotion'
                ? '/groups/team/team_demo/invite-administrator'
                : flow === 'people'
                  ? '/groups/team/team_demo/settings/people'
                  : '/notifications/old_request'
          window.history.replaceState(null, '', path)
          await act(async () => {
            root.render(<App />)
          })
          await settle(320)
          if (flow === 'relationship') {
            await press('Choose Demo Visitors')
            await press('Save')
          } else if (flow === 'promotion') {
            await fill('Administrator email', 'admin@example.test')
            await press('Save')
          } else if (flow === 'people') {
            await fill('E-mail addresses', 'recipient@example.test')
            await press('Add people')
          } else await press('Submit again')
          await settle(120)
          if (status === 'pending')
            expect(window.location.pathname).equals(
              '/notifications/request_demo'
            )
          else {
            expect(window.location.pathname).not.includes('/notifications')
            expect(window.location.pathname).equals(
              flow === 'resendGame'
                ? '/games/game_new'
                : flow === 'relationship' || flow === 'resendConnection'
                  ? '/groups/season/season_demo'
                  : flow === 'promotion'
                    ? '/groups/team/team_demo'
                    : '/groups/team/team_demo/settings'
            )
            const toast = [...document.querySelectorAll('[role="alert"]')]
              .map(node => node.textContent)
              .join(' ')
            expect(toast).includes('Demo Visitors')
            expect(toast).includes(
              flow === 'relationship' ||
                flow === 'resendGame' ||
                flow === 'resendConnection'
                ? 'Demo Season'
                : flow === 'promotion'
                  ? 'admin@example.test'
                  : 'recipient@example.test'
            )
          }
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
          window.history.replaceState(null, '', '/')
          for (const [name, descriptor] of Object.entries(originals))
            Object.defineProperty(proto, name, descriptor)
        }
      })
})
