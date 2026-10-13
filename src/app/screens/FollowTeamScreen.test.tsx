import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { FollowableTeam, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import { App } from '../App'
import { routePath } from '../navigation/routes'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import { FollowTeamScreen, SEARCH_PAUSE_MS } from './FollowTeamScreen'

/** U1: finding a team and following it, against a fake client. */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
  // The list is asked for once the screen is up, outside the render.
  await act(async () => {
    await delay(10)
  })
}

function labelled(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(found, label).not.equals(null)
  return found!
}

async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(labelled('Team name'), value)
    labelled('Team name').dispatchEvent(
      new window.Event('input', { bubbles: true })
    )
  })
}

/** A button by its label, or by the words on it after any icon. */
function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node =>
      (node.getAttribute('aria-label') ?? '').startsWith(label) ||
      (node.getAttribute('aria-label') == null &&
        (node.textContent ?? '').endsWith(label))
  )
}

async function press(label: string): Promise<void> {
  const found = button(label)
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(10)
  })
}

/** Long enough for the pause before a search, and its answer. */
async function settle(): Promise<void> {
  await act(async () => {
    await delay(SEARCH_PAUSE_MS + 30)
  })
}

const hawks: FollowableTeam = {
  id: 'tem_hawks',
  name: 'Hawks',
  logoUrl: null,
  seasons: [{ id: 'sea_spring', title: 'QPLL Spring 2027' }],
  following: false
}
const owls: FollowableTeam = {
  id: 'tem_owls',
  name: 'Owls',
  logoUrl: null,
  seasons: [],
  following: true
}

interface Calls {
  searches: string[]
  follows: string[]
  unfollows: string[]
  myFollows: number
}

function fakeClient(
  patch: Partial<Record<keyof TeamStationClient, unknown>> = {}
): { client: TeamStationClient; calls: Calls } {
  const calls: Calls = {
    searches: [],
    follows: [],
    unfollows: [],
    myFollows: 0
  }
  const client = {
    searchTeams: async (query: string) => {
      calls.searches.push(query)
      return [hawks]
    },
    myFollows: async () => {
      calls.myFollows += 1
      return [owls]
    },
    followTeam: async (teamId: string) => {
      calls.follows.push(teamId)
      return true
    },
    unfollowTeam: async (teamId: string) => {
      calls.unfollows.push(teamId)
      return false
    },
    ...patch
  } as unknown as TeamStationClient
  return { client, calls }
}

describe('FollowTeamScreen', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('lists the teams already followed until two characters are typed', async function () {
    const { client, calls } = fakeClient()
    const opened: string[] = []
    await render(
      <FollowTeamScreen
        client={client}
        onOpenTeam={teamId => {
          opened.push(teamId)
        }}
      />
    )
    expect(text()).contains('TEAMS YOU FOLLOW')
    expect(text()).contains('Owls')
    // A followed team opens.
    await press('Owls')
    expect(opened).deep.equals(['tem_owls'])

    await type('H')
    await settle()
    expect(calls.searches).deep.equals([])
    expect(text()).contains('TEAMS YOU FOLLOW')

    await type('Ha')
    await settle()
    expect(calls.searches).deep.equals(['Ha'])
    expect(text()).contains('QPLL Spring 2027')
    expect(text()).not.contains('TEAMS YOU FOLLOW')
    // A team not followed does not open: its page is not the caller's yet.
    expect(button('Hawks, QPLL Spring 2027')).equals(undefined)
  })

  it('waits for typing to pause before it searches', async function () {
    const { client, calls } = fakeClient()
    await render(
      <FollowTeamScreen client={client} onOpenTeam={() => undefined} />
    )
    await type('Ha')
    await type('Haw')
    await type('Hawk')
    await settle()
    expect(calls.searches).deep.equals(['Hawk'])
  })

  it('toggles Follow and Following', async function () {
    const { client, calls } = fakeClient()
    const opened: string[] = []
    await render(
      <FollowTeamScreen
        client={client}
        onOpenTeam={teamId => {
          opened.push(teamId)
        }}
      />
    )
    await type('Haw')
    await settle()
    await press('Follow Hawks')
    expect(calls.follows).deep.equals(['tem_hawks'])
    expect(button('Following Hawks')).not.equals(undefined)
    expect(button('Follow Hawks')).equals(undefined)

    await press('Hawks, QPLL Spring 2027')
    expect(opened).deep.equals(['tem_hawks'])

    await press('Following Hawks')
    expect(calls.unfollows).deep.equals(['tem_hawks'])
    expect(button('Follow Hawks')).not.equals(undefined)
  })

  it('says when nothing matches, when nothing is followed, and what went wrong', async function () {
    const { client } = fakeClient({
      searchTeams: async () => [],
      myFollows: async () => [],
      followTeam: async () => {
        throw new HttpError('notFound', 'Not found')
      }
    })
    await render(
      <FollowTeamScreen client={client} onOpenTeam={() => undefined} />
    )
    expect(text()).contains('You follow no teams yet')
    await type('Z')
    await settle()
    expect(text()).contains('Type at least two letters')
    await type('Zz')
    await settle()
    expect(text()).contains('No team has that in its name.')
  })

  it('shows a failed search or follow', async function () {
    let failSearch = true
    const { client } = fakeClient({
      searchTeams: async () => {
        if (failSearch)
          throw new HttpError('offline', 'Cannot reach TeamStation')
        return [hawks]
      },
      followTeam: async () => {
        throw new HttpError('notFound', 'Not found')
      }
    })
    await render(
      <FollowTeamScreen client={client} onOpenTeam={() => undefined} />
    )
    await type('Ha')
    await settle()
    expect(text()).contains('Cannot reach TeamStation')
    failSearch = false
    await type('Haw')
    await settle()
    expect(text()).not.contains('Cannot reach TeamStation')
    await press('Follow Hawks')
    expect(text()).contains('Not found')
    expect(button('Follow Hawks')).not.equals(undefined)
  })
})

describe('following a team in the app', function () {
  const originalFetch = globalThis.fetch

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    globalThis.fetch = originalFetch
  })

  /** Current public discovery/follow APIs; team membership remains private. */
  function fakeApi(): { asked: string[] } {
    const asked: string[] = []
    let following = false
    const group = asPublicGroup({
      id: 'tem_hawks',
      kind: 'team',
      name: 'Hawks',
      imageUrl: null,
      locality: null,
      parentNames: ['QPLL Spring 2027']
    })
    const detail = asGroupDetail({
      group,
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      staff: [],
      games: [],
      canViewPrivate: false,
      nonMemberView: true,
      canManage: false
    })
    globalThis.fetch = async (input, init) => {
      const raw =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const parsed = new URL(raw, 'http://localhost')
      const path = parsed.pathname.replace(/^.*\/api\/v1/, '')
      const method = init?.method ?? 'GET'
      asked.push(`${method} ${path}`)
      if (path === '/auth/me')
        return Response.json({
          id: 100,
          displayName: 'Drew Dalton',
          isAdmin: false
        })
      if (path === '/me/roles') return Response.json({ teams: {} })
      if (path === '/me/groups') return Response.json([])
      if (path === '/me/follows') return Response.json(following ? [group] : [])
      if (path === '/me/follows/team/tem_hawks') {
        following = method === 'PUT'
        return Response.json(method === 'PUT' ? group : { ok: true })
      }
      if (path === '/teams' && parsed.searchParams.get('view') === 'public')
        return Response.json([group])
      if (path === '/teams/tem_hawks') return Response.json(detail)
      return Response.json([])
    }
    return { asked }
  }

  async function search(value: string): Promise<void> {
    await act(async () => {
      const input = labelled('Search by name or city')
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await settle()
  }

  it('goes from Home to Search, follows Hawks, opens its public team page and returns', async function () {
    const { asked } = fakeApi()
    showRoute({ name: 'home' }, true)
    await render(<App />)
    await settle()
    const tabs = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="tab"][aria-label="Search"]'
      )
    ]
    expect(tabs).length(1)
    await act(async () => {
      tabs[0].click()
      await delay(10)
    })
    await settle()
    expect(currentRoute()).deep.equals({ name: 'discover' })
    expect(text()).contains('Discover')
    await search('Haw')
    await press('Follow Hawks')
    expect(asked).includes('PUT /me/follows/team/tem_hawks')
    expect(asked).not.includes('PUT /teams/tem_hawks/follow')
    await press('Open Hawks')
    await settle()
    expect(routePath(currentRoute())).equals('/groups/team/tem_hawks')
    expect(text()).contains('Hawks')
    expect(asked).includes('GET /teams/tem_hawks')
    expect(asked).not.includes('GET /teams/tem_hawks/stats')
    await press('Back')
    await settle()
    expect(currentRoute()).deep.equals({ name: 'discover' })
    expect(button('Unfollow Hawks')).not.equals(undefined)
  })

  it('opens the current following discovery address and uses its current APIs', async function () {
    const { asked } = fakeApi()
    const route = {
      name: 'discover' as const,
      kind: 'team' as const,
      follow: true
    }
    showRoute(route, true)
    await render(<App />)
    await settle()
    expect(currentRoute()).deep.equals(route)
    expect(text()).contains('Discover')
    expect(text()).contains('Follow leagues, seasons and teams')
    expect(labelled('Search by name or city')).not.equals(null)
    expect(asked).includes('GET /me/follows')
    expect(asked).includes('GET /me/groups')
    expect(asked).not.includes('GET /teams/search')
  })
})
