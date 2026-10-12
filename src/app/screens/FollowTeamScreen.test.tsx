import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { FollowableTeam, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
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
    follow: async (teamId: string) => {
      calls.follows.push(teamId)
      return true
    },
    unfollow: async (teamId: string) => {
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
      follow: async () => {
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
      follow: async () => {
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

  /** The API as a signed-in Eagles parent who follows nothing yet. */
  function fakeApi(): { asked: string[] } {
    const asked: string[] = []
    let following = false
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const path = url.split('?')[0].replace(/^.*\/api\/v1/, '')
      const method = init?.method ?? 'GET'
      asked.push(`${method} ${path}`)
      const user = { id: 100, displayName: 'Drew Dalton', isAdmin: false }
      if (path === '/auth/me') return Response.json(user)
      if (path === '/me/roles') return Response.json({ teams: {} })
      if (path === '/teams/search') {
        return Response.json([{ ...hawks, following }])
      }
      if (path === '/teams/tem_hawks/follow') {
        following = method === 'PUT'
        return Response.json({ following })
      }
      if (path === '/me/follows') {
        return Response.json(following ? [{ ...hawks, following }] : [])
      }
      if (path === '/teams') {
        return Response.json(
          following
            ? [
                {
                  id: 'tem_hawks',
                  name: 'Hawks',
                  shortName: null,
                  logoPath: null,
                  logoUrl: null,
                  record: null,
                  externalIds: [],
                  access: 'fan',
                  following: true,
                  onTeam: false
                }
              ]
            : []
        )
      }
      if (path === '/teams/tem_hawks/schedule') {
        return Response.json([
          {
            gameId: 'gam_final',
            startsAt: '2027-04-03T17:00:00.000Z',
            homeTeam: { id: 'tem_hawks', name: 'Hawks' },
            awayTeam: { id: 'tem_owls', name: 'Owls' },
            venue: 'Northpoint Field 1'
          }
        ])
      }
      if (path === '/teams/tem_hawks/staff') {
        return Response.json([
          { userId: 12, shortName: 'Hank C', avatarUrl: null, roles: ['coach'] }
        ])
      }
      return Response.json([])
    }
    return { asked }
  }

  it('goes from home to the follow screen, follows Hawks and opens it as a fan', async function () {
    const { asked } = fakeApi()
    showRoute({ name: 'home' }, true)
    await render(<App />)
    await settle()
    await press('Follow a team')
    expect(currentRoute()).deep.equals({ name: 'followTeam' })
    expect(text()).contains('Follow a team')
    await type('Haw')
    await settle()
    await press('Follow Hawks')
    expect(asked).to.include('PUT /teams/tem_hawks/follow')
    await press('Hawks, QPLL Spring 2027')
    await settle()
    // A fan's team page opens on its schedule, at the team's own address.
    expect(currentRoute()).deep.include({ name: 'team', teamId: 'tem_hawks' })
    expect(routePath(currentRoute())).equals('/teams/tem_hawks')
    expect(text()).contains('vs Owls')
    expect(text()).contains('Following')
    expect(asked).not.to.include('GET /teams/tem_hawks/games')
    expect(asked).not.to.include('GET /teams/tem_hawks/stats')
    await press('Back')
    expect(currentRoute()).deep.equals({ name: 'followTeam' })
  })

  it('opens the follow screen from its address', async function () {
    fakeApi()
    showRoute({ name: 'discover', kind: 'team', follow: true }, true)
    await render(<App />)
    expect(currentRoute()).deep.equals({ name: 'followTeam' })
    expect(text()).contains('You follow no teams yet')
  })
})
