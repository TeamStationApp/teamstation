import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asGameDetail, asSessionUser, TeamStationClient } from '../common/api'
import { asEventInfo } from '../common/eventInfo'
import { asGameScheduling } from '../common/gameApprovals'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { pressSchedule } from '../test/eventScheduleDom'
import { App } from './App'

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 80))
  })
}
describe('actual app event Settings navigation', () => {
  for (const status of ['eventUpdated', 'accepted', 'pending'])
    it(`returns from ${status} settings with appropriate feedback`, async () => {
      const proto = TeamStationClient.prototype
      const originals = Object.getOwnPropertyDescriptors(proto)
      const game = asGameDetail({
        id: 'game_demo',
        eventKind: status === 'eventUpdated' ? 'event' : 'game',
        title: status === 'eventUpdated' ? 'Team dinner' : null,
        nonMemberView: false,
        homeTeamId: 'home',
        awayTeamId: 'away',
        homeTeamName: 'Demo Hawks',
        awayTeamName: 'Demo Eagles',
        seasonId: null,
        startAt: '2027-04-10T18:00:00Z',
        endAt: null,
        venue: null,
        status: 'scheduled',
        homeScore: null,
        awayScore: null,
        videos: [],
        ingestStatus: 'none',
        ingestMessage: null,
        canScore: false
      })
      const info = asEventInfo({
        ...game,
        teamId: 'home',
        teamName: 'Demo Hawks',
        timezone: 'UTC',
        address: null,
        latitude: null,
        longitude: null,
        canManage: true,
        attendees: [],
        replyUserIds: []
      })
      proto.whoAmI = async () =>
        asSessionUser({
          id: userIdOfGumbo(101),
          displayName: 'Babe Ruth',
          isAdmin: false
        })
      proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
      proto.hasNotifications = async () => false
      proto.game = async id => ({ ...game, id })
      proto.teams = async () => []
      proto.eventInfo = async () => info
      proto.gameScheduling = async () =>
        asGameScheduling({
          game: {
            homeTeamId: 'home',
            awayTeamId: 'away',
            seasonId: null,
            startAt: game.startAt,
            venue: null,
            timezone: 'UTC',
            exhibition: false,
            status: 'scheduled'
          },
          version: 'a'.repeat(64),
          canPropose: true,
          withdrawTeamIds: ['home'],
          administeredTeamIds: ['home']
        })
      proto.group = async ref =>
        asGroupDetail({
          nonMemberView: false,
          group: {
            id: ref.id,
            kind: 'team',
            name: ref.id === 'home' ? 'Demo Hawks' : 'Demo Eagles',
            locality: null,
            imageUrl: null
          },
          parents: [],
          children: [],
          competingTeams: [],
          participatingSeasons: [],
          staff: [],
          games: [],
          canManage: status !== 'pending' || ref.id === 'home'
        })
      proto.updateEventInfo = async () => info
      proto.proposeGame = async () => ({
        id: 'proposal_demo',
        status,
        gameId: status === 'accepted' ? 'game_new' : null,
        proposedGameId: 'game_new',
        replacesGameId: 'game_demo'
      })
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      try {
        window.history.replaceState(null, '', '/games/game_demo/settings')
        await act(async () => {
          root.render(<App />)
        })
        await settle()
        // A game saves with Save whether or not another team must approve.
        await pressSchedule(
          status === 'eventUpdated' ? 'Save event details' : 'Save'
        )
        await settle()
        expect(window.location.pathname).equals(
          status === 'accepted' ? '/games/game_new' : '/games/game_demo'
        )
        expect(document.body.textContent).includes(
          status === 'eventUpdated'
            ? 'Event changes saved'
            : status === 'accepted'
              ? 'Game changes saved'
              : 'Game proposal sent'
        )
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
