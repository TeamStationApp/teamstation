import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { settle } from '../test/gameFormDom'
import { App } from './App'

const proto = TeamStationClient.prototype
const originals = Object.getOwnPropertyDescriptors(proto)
let root: Root | undefined
let host: HTMLElement | undefined

/** A league administrator, signed in, whose league has no recordings. */
function signedIn(): void {
  proto.whoAmI = async () =>
    asSessionUser({
      id: userIdOfGumbo(101),
      displayName: 'Demo Admin',
      isAdmin: false
    })
  proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
  proto.hasNotifications = async () => false
  proto.teams = async () => []
  proto.home = async () => ({ teams: [], seasons: [], leagues: [] })
  proto.ownGroups = async () => []
  proto.group = async ref =>
    asGroupDetail({
      nonMemberView: false,
      group: {
        id: ref.id,
        kind: ref.kind,
        name: 'Demo League',
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
  proto.videoGames = async () => []
}

async function open(path: string): Promise<void> {
  window.history.replaceState(null, '', path)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<App />)
  })
  await settle(150)
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = undefined
  window.history.replaceState(null, '', '/')
  for (const [name, descriptor] of Object.entries(originals))
    Object.defineProperty(proto, name, descriptor)
})

describe('the sponsor features screens in the app', () => {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()

  it('opens Sponsor Video Logos at its address', async () => {
    signedIn()
    await open('/groups/league/lea_demo/sponsors/logos')
    await settle(150)
    expect(window.location.pathname).equals(
      '/groups/league/lea_demo/sponsors/logos'
    )
    const page = document.body.textContent ?? ''
    expect(page).includes('Sponsor Video Logos')
    expect(page).includes('Remaining game logo credits: 120 of 300')
    expect(page).includes('No recording to preview')
  })
})
