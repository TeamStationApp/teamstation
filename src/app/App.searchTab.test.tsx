import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { asRosterEntry, asSessionUser, TeamStationClient } from '../common/api'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
import type {
  Location,
  SearchGroupResult,
  SearchPersonResult
} from '../common/search/types'
import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { FakeSearchServer } from '../test/fakeSearchSocket'
import { pageOfGames } from '../test/pageOf'
import { App, stackFor } from './App'
import {
  SEARCH_PLACEHOLDER,
  SEARCH_SIGNED_OUT_MESSAGE
} from './screens/SearchScreen'

const group = (
  kind: SearchGroupResult['kind'],
  id: string,
  name: string,
  extra: Partial<SearchGroupResult> = {}
): SearchGroupResult => ({
  kind,
  id,
  name,
  imageUrl: null,
  cityLine: kind === 'league' ? null : 'Demo City, Demo Region',
  associations: '',
  follow: 'follow',
  ...extra
})
const league = group('league', 'league_demo', 'Demo League', {
  associations: 'Demo City, Demo Region'
})
const season = group('season', 'season_demo', 'Demo Spring', {
  associations: 'Demo League'
})
const hawks = group('team', 'tem_hawks', 'Demo Hawks', {
  associations: 'Demo Spring · Demo League'
})
const ownTeam = group('team', 'tem_owls', 'Demo Owls', { follow: null })
const person: SearchPersonResult = {
  kind: 'person',
  userId: userIdOfGumbo(201),
  name: 'Mike Trout',
  avatarUrl: null,
  associations: 'Demo Hawks'
}
const sanDiego: Location = {
  kind: 'city',
  id: 'geonames:5391811',
  label: 'San Diego, CA',
  city: 'San Diego',
  region: 'California',
  country: 'US'
}

let root: Root | undefined
let host: HTMLElement | undefined
let originals: PropertyDescriptorMap
let signedIn = true
const followed: string[] = []

/** The Shell's reads, as somebody holding no roles sees them. */
function stubClient(): void {
  const proto = TeamStationClient.prototype
  originals = Object.getOwnPropertyDescriptors(proto)
  proto.whoAmI = async () => {
    if (!signedIn) throw new Error('Not signed in')
    return asSessionUser({
      id: userIdOfGumbo(1),
      displayName: 'Demo Fan',
      isAdmin: false
    })
  }
  proto.myRoles = async () => {
    throw new Error('offline')
  }
  proto.hasNotifications = async () => false
  proto.teams = async () => []
  proto.home = async () => ({ teams: [], seasons: [], leagues: [] })
  proto.seasons = async () => []
  proto.ownGroups = async () => []
  proto.follows = async () => []
  proto.recentGame = async () => null
  proto.liveNow = async () => []
  proto.follow = async ref => {
    followed.push(`follow:${ref.id}`)
    return asPublicGroup({
      id: ref.id,
      kind: ref.kind,
      name: 'Demo',
      imageUrl: null,
      locality: null
    })
  }
  proto.unfollow = async ref => {
    followed.push(`unfollow:${ref.id}`)
  }
  proto.group = async ref =>
    asGroupDetail({
      nonMemberView: true,
      group: asPublicGroup({
        id: ref.id,
        kind: ref.kind,
        name: ref.id === 'league_demo' ? 'Demo League' : 'Demo Group',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      games: [],
      staff: [],
      canManage: false
    })
}

beforeEach(() => {
  signedIn = true
  followed.length = 0
  stubClient()
  window.history.replaceState(null, '', '/')
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  Object.defineProperties(TeamStationClient.prototype, originals)
  window.history.replaceState(null, '', '/')
})

async function settle(ms = 80): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}
const control = (label: string): HTMLElement | undefined =>
  [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].find(node => node.getAttribute('aria-label') === label)
async function press(label: string): Promise<void> {
  const node = control(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
  await settle(label === 'Search' ? 350 : 80)
}
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(
    `input[aria-label="${SEARCH_PLACEHOLDER}"]`
  )
async function type(value: string): Promise<void> {
  await act(async () => {
    const input = field()!
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle(20)
}

/** A Backspace key on the field, as the browser sends it before the delete. */
async function backspace(): Promise<void> {
  await act(async () => {
    field()!.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })
    )
  })
  await settle(20)
}
/** The rows' labels, in order. */
const rows = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="search-result-row"] [aria-label^="Open "]'
    )
  ].map(node => node.getAttribute('aria-label')!)
const text = (): string => document.body.textContent ?? ''

async function openSearch(server: FakeSearchServer): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<App searchSocketFactory={server.factory} />)
  })
  await settle()
  await press('Search')
  expect(window.location.pathname).equals('/discover')
}

describe('the Search tab', () => {
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()

  it('is a stack of its own, with Search at its root and no Back there', async () => {
    const server = new FakeSearchServer(() => ({ results: [league] }))
    await openSearch(server)
    expect(control('Back')).equals(undefined)
    expect(text()).includes('Discover')
    // One field, and no kind buttons.
    expect(field()).not.equals(null)
    for (const kind of ['Leagues', 'Seasons', 'Teams'])
      expect(control(kind), kind).equals(undefined)
    // An empty field asks nothing and shows nothing.
    expect(server.frames).deep.equals([])
    expect(rows()).deep.equals([])

    await type('Demo Lea')
    expect(rows()).deep.equals(['Open Demo League'])
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
  })

  it('asks on every change, shows the lexicographic answer, then Jev’s, and never an older answer', async () => {
    const server = new FakeSearchServer()
    await openSearch(server)
    // Signed in: the socket carries the session's token getter.
    expect(server.made.at(-1)!.token).not.equals(undefined)

    await type('s')
    await type('sa')
    await type('san')
    expect(server.frames.map(frame => frame.text)).deep.equals([
      's',
      'sa',
      'san'
    ])
    expect(server.last).deep.include({
      type: 'search',
      text: 'san',
      location: null,
      mode: 'all'
    })
    const [, sa, san] = server.frames

    // An answer to older typing is dropped.
    await act(async () => {
      server.reply({ results: [ownTeam] }, { frame: sa })
    })
    expect(rows()).deep.equals([])

    await act(async () => {
      server.reply({ results: [hawks, season, league, person] }, { frame: san })
    })
    expect(rows()).deep.equals([
      'Open Demo Hawks',
      'Open Demo Spring',
      'Open Demo League',
      'Open Mike Trout'
    ])
    const page = text()
    for (const kind of ['League', 'Season', 'Team', 'Person'])
      expect(page).includes(kind)

    // Jev's order replaces it.
    await act(async () => {
      server.reply(
        { results: [person, league, hawks, season] },
        { frame: san, stage: 'jev' }
      )
    })
    expect(rows()).deep.equals([
      'Open Mike Trout',
      'Open Demo League',
      'Open Demo Hawks',
      'Open Demo Spring'
    ])

    // Two results with one name are told apart by their place.
    await type('demo h')
    await act(async () => {
      server.reply({
        results: [
          hawks,
          { ...hawks, id: 'tem_other', cityLine: 'Demo Town, Demo Region' }
        ]
      })
    })
    expect(rows()).deep.equals([
      'Open Demo Hawks, Demo City, Demo Region',
      'Open Demo Hawks, Demo Town, Demo Region'
    ])

    // Nothing found says so.
    await type('zzz')
    await act(async () => {
      server.reply({ results: [] })
    })
    expect(text()).includes('Nothing matches.')

    // Emptied, the field shows nothing and supersedes what was asked.
    await type('')
    expect(server.last!.text).equals('')
    expect(rows()).deep.equals([])
    expect(text()).not.includes('Nothing matches.')
  })

  it('puts a chosen location pill in the field, clearing the text, and takes it out with its X', async () => {
    const server = new FakeSearchServer(frame =>
      frame.location == null
        ? {
            results: [hawks],
            locations: [
              sanDiego,
              { ...sanDiego, id: 'geonames:1', label: 'San Dimas, CA' },
              {
                kind: 'region',
                id: 'region:US:California',
                label: 'California',
                region: 'California',
                country: 'US'
              },
              {
                kind: 'country',
                id: 'country:US',
                label: 'USA',
                country: 'US'
              },
              { ...sanDiego, id: 'geonames:2', label: 'San Diego, TX' }
            ]
          }
        : { results: [hawks] }
    )
    await openSearch(server)
    await type('san die')
    const suggestions = document.querySelector(
      '[data-testid="location-suggestions"]'
    )!
    expect(
      [...suggestions.querySelectorAll('[data-testid="location-pill"]')].map(
        pill => pill.textContent
      )
    ).deep.equals(['San Diego, CA', 'San Dimas, CA', 'California', 'USA'])

    await press('Choose San Diego, CA')
    expect(field()!.value).equals('')
    expect(server.last).deep.include({ text: '', location: sanDiego })
    const dock = document.querySelector('[data-testid="Search field"]')!
    expect(dock.textContent).includes('San Diego, CA')
    // With a place chosen, no more are suggested.
    expect(
      document.querySelector('[data-testid="location-suggestions"]')
    ).equals(null)
    // The organizations in the place are listed with no text typed.
    expect(rows()).deep.equals(['Open Demo Hawks'])

    await type('hawks')
    expect(server.last).deep.include({ text: 'hawks', location: sanDiego })
    // Beside the pill, the input takes the width left up to the clear
    // button and never less than 25% of the field: past that the pill's
    // label ellipsizes, keeping the pill's height and circle.
    const input = getComputedStyle(field()!)
    expect([input.flexGrow, input.flexShrink, input.minWidth]).deep.equals([
      '1',
      '0',
      '25%'
    ])
    const pill = dock.querySelector<HTMLElement>(
      '[data-testid="location-pill"]'
    )!
    const label = [...pill.querySelectorAll<HTMLElement>('div')].find(
      node => node.textContent === 'San Diego, CA' && node.children.length === 0
    )!
    expect(getComputedStyle(label).minWidth).equals('0px')
    expect(getComputedStyle(label).flexShrink).equals('1')
    expect(getComputedStyle(pill).height).equals('20px')
    await press('Clear search')
    expect(server.last).deep.include({ text: '', location: sanDiego })
    expect(rows()).deep.equals(['Open Demo Hawks'])

    await press('Remove San Diego, CA')
    expect(server.last).deep.include({ text: '', location: null })
    expect(dock.textContent).not.includes('San Diego, CA')
    expect(rows()).deep.equals([])
  })

  it('takes the chosen place out with Backspace in an empty field, and keeps it while there is text to delete', async () => {
    const server = new FakeSearchServer(frame =>
      frame.location == null
        ? { results: [hawks], locations: [sanDiego] }
        : { results: [hawks] }
    )
    await openSearch(server)
    // With no place chosen, Backspace in the empty field does nothing.
    await backspace()
    expect(server.last).equals(undefined)

    await type('san die')
    await press('Choose San Diego, CA')
    const dock = document.querySelector('[data-testid="Search field"]')!
    await type('x')
    // The key comes before the text changes: this one deletes the x.
    await backspace()
    expect(dock.textContent).includes('San Diego, CA')
    await type('')
    expect(server.last).deep.include({ text: '', location: sanDiego })

    await backspace()
    expect(dock.textContent).not.includes('San Diego, CA')
    expect(server.last).deep.include({ text: '', location: null })
    expect(rows()).deep.equals([])
  })

  it('in a browser, puts the field under the title, its pills under it and the results below', async () => {
    const server = new FakeSearchServer(frame =>
      frame.location == null
        ? { results: [hawks], locations: [sanDiego] }
        : { results: [hawks] }
    )
    await openSearch(server)
    await type('san die')
    const title = [...document.querySelectorAll('[role="heading"]')].find(
      node => node.textContent === 'Discover'
    )!
    const searchField = document.querySelector('[data-testid="Search field"]')!
    const suggestions = document.querySelector(
      '[data-testid="location-suggestions"]'
    )!
    const row = document.querySelector('[data-testid="search-result-row"]')!
    const before = (a: Node, b: Node): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(before(title, searchField), 'title, then the field').equals(true)
    expect(before(searchField, suggestions), 'then its pills').equals(true)
    expect(before(suggestions, row), 'then the results').equals(true)
    // A finger's row: the pills' reach above and below falls inside it.
    const pillRow = suggestions.querySelector<HTMLElement>(
      '[data-testid="location-pill"]'
    )!.parentElement!
    expect(getComputedStyle(pillRow).minHeight).equals('44px')
    expect(getComputedStyle(pillRow).alignItems).equals('center')
    // The pills' shadows are not cut at the row's ends: it reaches into a
    // gutter on each side and pads it back, so they line up with the field.
    expect(getComputedStyle(pillRow).paddingLeft).equals('12px')
    expect(getComputedStyle(pillRow).paddingRight).equals('12px')
    expect(getComputedStyle(suggestions).marginLeft).equals('-12px')
    expect(getComputedStyle(suggestions).marginRight).equals('-12px')
    // In the page's flow, not floating over it.
    expect(getComputedStyle(searchField.parentElement!).position).not.equals(
      'absolute'
    )
  })

  it('on a phone, docks the pills above the field and keeps the same focused input when they appear', async () => {
    const server = new FakeSearchServer(frame =>
      frame.location == null
        ? { results: [hawks], locations: [sanDiego] }
        : { results: [hawks] }
    )
    const os = Platform.OS
    ;(Platform as { OS: string }).OS = 'ios'
    try {
      await openSearch(server)
      const input = field()!
      await act(async () => {
        input.focus()
      })
      await type('san die')
      const dock = document.querySelector('[data-testid="search-dock"]')!
      const suggestions = dock.querySelector(
        '[data-testid="location-suggestions"]'
      )!
      expect(suggestions, 'the pills ride in the dock').not.equals(null)
      expect(
        (suggestions.compareDocumentPosition(field()!) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
        'pills above the field'
      ).equals(true)
      // Not remounted: the keyboard stays up as the pills arrive.
      expect(field(), 'the same input').equals(input)
      expect(document.activeElement).equals(input)
    } finally {
      ;(Platform as { OS: string }).OS = os
    }
  })

  it('follows at once, flips back when the follow fails, and draws no Follow on the reader’s own group', async () => {
    let follows: 'follow' | 'following' = 'follow'
    const server = new FakeSearchServer(() => ({
      results: [{ ...hawks, follow: follows }, ownTeam]
    }))
    let finish: (() => void) | undefined
    TeamStationClient.prototype.follow = async ref => {
      followed.push(`follow:${ref.id}`)
      await new Promise<void>(resolve => {
        finish = resolve
      })
      follows = 'following'
      return asPublicGroup({
        id: ref.id,
        kind: ref.kind,
        name: 'Demo Hawks',
        imageUrl: null,
        locality: null
      })
    }
    await openSearch(server)
    await type('demo')
    expect(control('Follow Demo Owls')).equals(undefined)
    expect(control('Unfollow Demo Owls')).equals(undefined)

    // The pills share the name's line only; the city and association lines
    // sit beneath it, outside the pills' container, the full text width.
    const hawksRow = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="search-result-row"]'
      )
    ].find(row => row.textContent!.includes('Demo Hawks'))!
    const top = hawksRow.querySelector('[data-testid="search-result-top"]')!
    expect(top.textContent).equals('Demo HawksTeamFollow')
    const lines = [
      ...hawksRow.querySelectorAll('[data-testid="search-result-lines"] > *')
    ]
    expect(lines.map(line => line.textContent)).deep.equals([
      'Demo City, Demo Region',
      'Demo Spring · Demo League'
    ])
    for (const line of lines) {
      expect(top.contains(line)).equals(false)
      expect(line.parentElement!.parentElement).equals(top.parentElement)
    }
    await press('Follow Demo Hawks')
    // Following before the server has said so.
    expect(control('Unfollow Demo Hawks')).not.equals(undefined)
    expect(followed).deep.equals(['follow:tem_hawks'])
    await act(async () => {
      finish!()
    })
    await settle()
    expect(control('Unfollow Demo Hawks')).not.equals(undefined)
    // A later answer agrees.
    await type('demo ')
    expect(control('Unfollow Demo Hawks')).not.equals(undefined)

    await press('Unfollow Demo Hawks')
    expect(followed).deep.equals(['follow:tem_hawks', 'unfollow:tem_hawks'])
    expect(control('Follow Demo Hawks')).not.equals(undefined)

    TeamStationClient.prototype.follow = async () => {
      throw new Error('Demo Hawks could not be followed. Retry.')
    }
    follows = 'follow'
    await type('demo h')
    await press('Follow Demo Hawks')
    await settle()
    expect(control('Follow Demo Hawks')).not.equals(undefined)
    expect(text()).includes('Demo Hawks could not be followed. Retry.')
  })

  it('opens each kind on its own page', async () => {
    const server = new FakeSearchServer(() => ({
      results: [league, season, hawks, person]
    }))
    await openSearch(server)
    await type('demo')
    for (const [label, path] of [
      ['Open Demo League', '/groups/league/league_demo'],
      ['Open Demo Spring', '/groups/season/season_demo'],
      ['Open Demo Hawks', '/groups/team/tem_hawks'],
      ['Open Mike Trout', `/players/${person.userId}`]
    ] as const) {
      await press(label)
      expect(window.location.pathname, label).equals(path)
      await press('Back')
      expect(window.location.pathname).equals('/discover')
    }
  })

  it('opens a team from Search on the team’s own page, as anybody signed in who is not a member reads it', async () => {
    const proto = TeamStationClient.prototype
    const team = asPublicGroup({
      id: 'tem_hawks',
      kind: 'team',
      name: 'Demo Hawks',
      imageUrl: null,
      locality: null
    })
    const asked: string[] = []
    proto.group = async () =>
      asGroupDetail({
        nonMemberView: true,
        group: team,
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canManage: false
      })
    proto.teamGamesPage = async (_id, query) => pageOfGames([], query)
    proto.roster = async () => [
      asRosterEntry({
        userId: userIdOfGumbo(201),
        gumboId: 201,
        shortName: 'Alfonso S',
        jersey: '7',
        positions: ['SS'],
        isPlayer: true,
        role: 'member',
        section: 'player',
        staffRoles: [],
        inheritedFrom: null,
        avatarUrl: null
      })
    ]
    for (const method of ['teamStats', 'teamPitchingStats'] as const)
      proto[method] = async () => {
        asked.push(method)
        throw new Error('Kept for members')
      }
    const server = new FakeSearchServer(() => ({ results: [hawks] }))
    await openSearch(server)
    await type('Demo Hawks')
    await press('Open Demo Hawks')
    const tab = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(
      node => (node.getAttribute('aria-label') ?? node.textContent) === 'Team'
    )
    await act(async () => {
      tab!.click()
    })
    await settle()
    const page = text()
    // The members' page, less what is kept for members: the roster, and
    // not the public summary's staff list or its membership notes.
    expect(page).includes('PLAYERS')
    expect(page).includes('Alfonso S')
    expect(page).not.includes('Standalone team')
    expect(page).not.includes('membership is required')
    expect(control('Follow Demo Hawks')).not.equals(undefined)
    const stats = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(
      node => (node.getAttribute('aria-label') ?? node.textContent) === 'Stats'
    )
    await act(async () => {
      stats!.click()
    })
    await settle()
    expect(text()).includes(
      'You need to be a member of this team to see individual player stats.'
    )
    expect(asked).deep.equals([])
  })

  it('says it needs a connection while the socket is down, and searches again once it is back', async () => {
    const server = new FakeSearchServer(() => ({ results: [hawks] }))
    await openSearch(server)
    await type('hawks')
    expect(rows()).deep.equals(['Open Demo Hawks'])
    await act(async () => {
      server.disconnect()
    })
    await settle(20)
    expect(text()).includes('Search needs a connection.')
    expect(rows()).deep.equals([])
    const asked = server.frames.length
    server.online = true
    // The socket's first retry is a second later; it asks the same again.
    await settle(1200)
    expect(text()).not.includes('Search needs a connection.')
    expect(server.frames.length).greaterThan(asked)
    expect(server.last!.text).equals('hawks')
    expect(rows()).deep.equals(['Open Demo Hawks'])
  })

  it('says to sign in again once the server closes for a session it no longer takes, and asks no more with it', async () => {
    const server = new FakeSearchServer(() => ({ results: [hawks] }))
    await openSearch(server)
    await type('hawks')
    expect(rows()).deep.equals(['Open Demo Hawks'])
    const sockets = server.sockets.length
    await act(async () => {
      server.signOut()
    })
    await settle(20)
    expect(text()).includes(SEARCH_SIGNED_OUT_MESSAGE)
    expect(text()).not.includes('Search needs a connection.')
    expect(rows()).deep.equals([])
    // Past the first reconnect's second, no socket opens with the session.
    await type('hawks b')
    await settle(1200)
    expect(server.sockets.length).equals(sockets)
  })

  it('shows a refused search, and signed out searches with no token', async () => {
    signedIn = false
    const server = new FakeSearchServer()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    window.history.replaceState(null, '', '/discover')
    await act(async () => {
      root!.render(<App searchSocketFactory={server.factory} />)
    })
    await settle(350)
    expect(server.made.length).greaterThan(0)
    expect(server.made.at(-1)!.token).equals(undefined)
    await type('hawks')
    await act(async () => {
      server.refuse('internal', 'Search failed. Try again.')
    })
    expect(text()).includes('Search failed. Try again.')
    await act(async () => {
      server.reply({ results: [{ ...hawks, follow: null }] })
    })
    expect(text()).not.includes('Search failed. Try again.')
    expect(control('Follow Demo Hawks')).equals(undefined)
  })

  it('offers following on a follow address only to a signed-in reader', async () => {
    const FOLLOW_HINT =
      'Follow leagues, seasons and teams to keep them on your Home.'
    const FIND_HINT = 'Find leagues, seasons, teams and people.'
    for (const reader of [false, true]) {
      signedIn = reader
      const server = new FakeSearchServer()
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      window.history.replaceState(null, '', '/discover?kind=team&follow=1')
      await act(async () => {
        root!.render(<App searchSocketFactory={server.factory} />)
      })
      await settle(350)
      if (reader) {
        expect(text(), 'signed in').includes(FOLLOW_HINT)
      } else {
        // Signed out, no row can be followed: the page says what it finds.
        expect(text(), 'signed out').includes(FIND_HINT)
        expect(text(), 'signed out').not.includes(FOLLOW_HINT)
      }
      await act(async () => root?.unmount())
      root = undefined
      host.remove()
      host = undefined
    }
  })

  it('opens a discovery address on the Search tab, and following on Home', () => {
    expect(stackFor({ name: 'discover' })).deep.equals({})
    expect(
      stackFor({ name: 'discover', kind: 'team', follow: true })
    ).deep.equals({ home: [{ name: 'discover', kind: 'team', follow: true }] })
  })
})
