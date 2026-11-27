import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { fakeSponsorClient, usedSponsorState } from '../test/fakeSponsorClient'
import { press, settle } from '../test/gameFormDom'
import { App } from './App'

const proto = TeamStationClient.prototype
const originals = Object.getOwnPropertyDescriptors(proto)
let root: Root | undefined
let host: HTMLElement | undefined

/**
 * A league administrator, signed in, whose league's sponsors are the fake
 * server's: 120 of 300 logo credits and 500 of 1,000 broadcasts left.
 */
function signedIn(): void {
  const sponsors = fakeSponsorClient({ state: usedSponsorState(new Date()) })
  for (const name of [
    'sponsorState',
    'sponsorSample',
    'uploadSponsorMedia',
    'addSponsorLogo',
    'deactivateSponsorLogo'
  ] as const)
    Object.defineProperty(proto, name, {
      configurable: true,
      value: sponsors[name]
    })
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

describe('U14 the sponsor features screens in the app, on the API store', () => {
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
    expect(page).includes('Harbor Hardware')
  })

  it('opens Sponsor Video Reels at its address', async () => {
    signedIn()
    await open('/groups/league/lea_demo/sponsors/reels')
    await settle(150)
    expect(window.location.pathname).equals(
      '/groups/league/lea_demo/sponsors/reels'
    )
    const page = document.body.textContent ?? ''
    expect(page).includes('Sponsor Video Reels')
    expect(page).includes('Remaining reel broadcast credits: 500 of 1,000')
  })

  it('opens Sponsor in Event Stream at its address', async () => {
    signedIn()
    await open('/groups/league/lea_demo/sponsors/event-stream')
    await settle(150)
    const page = document.body.textContent ?? ''
    expect(page).includes('Sponsor in Event Stream')
    expect(page).includes('8 of 10 event stream slots left')
  })

  it('goes from League Settings to Sponsor features and on to each screen', async () => {
    signedIn()
    await open('/groups/league/lea_demo/settings')
    expect(document.body.textContent).includes('Sponsor features')
    expect(
      document.querySelector('[data-testid="sponsor-premium-pill"]')
    ).not.equals(null)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="sponsor-features-row"]')
        ?.click()
    })
    await settle(150)
    expect(window.location.pathname).equals('/groups/league/lea_demo/sponsors')
    expect(document.body.textContent).includes('Sponsor Features')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="sponsor-menu-sponsorLogos"]')
        ?.click()
    })
    await settle(150)
    expect(window.location.pathname).equals(
      '/groups/league/lea_demo/sponsors/logos'
    )
    expect(document.body.textContent).includes(
      'Remaining game logo credits: 120 of 300'
    )
    await press('Deactivate Summit Dental')
    await settle(50)
    await press('Deactivate')
    await settle(50)
    expect(document.body.textContent).includes(
      'Remaining game logo credits: 170 of 300'
    )
  })
})
