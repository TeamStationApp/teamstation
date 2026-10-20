import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail, asSearchRow } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { press, settle } from '../test/gameFormDom'
import { App } from './App'

const team = (id: string, name: string): ReturnType<typeof asSearchRow> =>
  asSearchRow({ id, kind: 'team', name, locality: null, imageUrl: null })

describe('actual app Create Game navigation', () => {
  for (const status of ['pending', 'accepted'])
    it(`opens the ${status === 'accepted' ? 'game' : 'request'} with its notice after Save`, async () => {
      const proto = TeamStationClient.prototype
      const originals = Object.getOwnPropertyDescriptors(proto)
      const sent: Array<Parameters<TeamStationClient['proposeGame']>[0]> = []
      proto.whoAmI = async () =>
        asSessionUser({
          id: userIdOfGumbo(101),
          displayName: 'Babe Ruth',
          isAdmin: false
        })
      proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
      proto.hasNotifications = async () => false
      proto.teams = async () => []
      proto.ownGroups = async () => []
      proto.relatedTeams = async () => [team('away', 'Demo Eagles')]
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
          canManage: true
        })
      proto.proposeGame = async body => {
        sent.push(body)
        return {
          id: 'proposal_demo',
          status,
          gameId: status === 'accepted' ? 'game_new' : null,
          proposedGameId: 'game_new',
          replacesGameId: null
        }
      }
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      try {
        window.history.replaceState(null, '', '/groups/team/home/create-game')
        await act(async () => {
          root.render(<App />)
        })
        await settle(120)
        await press('Choose Away Team')
        await settle()
        await press('Choose Demo Eagles')
        await settle(80)
        await press('Save')
        await settle(120)
        expect(sent[0].sender).deep.equals({ kind: 'team', id: 'home' })
        expect(window.location.pathname).equals(
          status === 'accepted'
            ? '/games/game_new'
            : '/notifications/proposal_demo'
        )
        expect(document.body.textContent).includes(
          status === 'accepted' ? 'Game scheduled' : 'Game proposal sent'
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
