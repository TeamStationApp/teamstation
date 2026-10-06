import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asPlayerDetail,
  asRosterEntry,
  type PlayerStats,
  type TeamStationClient
} from '../../common/api'
import type { PlayerSettings } from '../../common/playerSettings'
import { App } from '../App'
import { parseRoute, routePath } from '../navigation/routes'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import type { WalkUpMusic } from '../walkup/walkUpMusicTypes'
import { PlayerScreen, type PlayerTab } from './PlayerScreen'

/**
 * The Settings tab: offered with the team the page was opened for and a
 * coach's right on it, and never otherwise — on the web and on a phone
 * alike, because both draw this screen. The Stats filter is a different
 * team and never moves it.
 */
let root: Root | undefined
const originalFetch = globalThis.fetch

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
}

function find(label: string): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="button"], [role="tab"], [role="radio"], [role="checkbox"]'
    )
  ].find(
    node =>
      (node.getAttribute('aria-label') ?? '').startsWith(label) ||
      (node.textContent ?? '').startsWith(label)
  )
}

async function press(label: string): Promise<void> {
  const found = find(label)
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(20)
  })
}

const tabNames = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[aria-label="Player sections"] [role="tab"]'
    )
  ].map(node => node.textContent ?? '')
/**
 * Which tab's content is on the screen. PillTabs says which is selected only
 * through `accessibilityState`, which the web build does not render, so the
 * page is read instead.
 */
const selectedTab = (): string | undefined =>
  document.querySelector('[aria-label="Jersey number"]') != null
    ? 'Settings'
    : (document.body.textContent ?? '').includes('Set walk-up songs in')
      ? 'Walk-up'
      : (document.body.textContent ?? '').includes('No highlights')
        ? 'Videos'
        : (document.body.textContent ?? '').includes('Filter')
          ? 'Stats'
          : undefined
const text = (): string => document.body.textContent ?? ''

const jordan = asRosterEntry({
  userId: 7,
  shortName: 'Jordan P',
  jersey: '4',
  positions: ['CF'],
  bats: 'right',
  throws: 'right',
  isPlayer: true,
  role: 'member',
  group: 'player'
})

const stats: PlayerStats = {
  userId: 7,
  filter: { seasonId: null, teamId: null, year: null },
  games: 3,
  batting: null,
  pitching: null,
  options: {
    seasons: [],
    teams: [{ teamId: 'tem_other', name: 'Owls' }],
    years: []
  }
}

function playerClient(
  saves: Array<{ teamId: string; settings: PlayerSettings }> = [],
  rosters: string[] = []
): TeamStationClient {
  return {
    player: async () =>
      asPlayerDetail({
        userId: 7,
        name: 'Jordan P',
        bats: 'right',
        throws: 'right',
        teams: []
      }),
    playerHighlights: async () => ({
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    }),
    playerStats: async () => stats,
    guardians: async () => [],
    roster: async (teamId: string) => {
      rosters.push(teamId)
      return [jordan]
    },
    setPlayerSettings: async (
      teamId: string,
      _userId: string,
      settings: PlayerSettings
    ) => {
      saves.push({ teamId, settings })
      return { ...jordan, ...settings }
    }
  } as unknown as TeamStationClient
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  globalThis.fetch = originalFetch
})

describe('a player’s Settings tab', function () {
  it('shows for a coach of the team the page was opened for, and saves to it', async function () {
    const saves: Array<{ teamId: string; settings: PlayerSettings }> = []
    const tabs: PlayerTab[] = []
    await render(
      <PlayerScreen
        client={playerClient(saves)}
        userId="7"
        forTeam="t1"
        canCoach
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Settings'])
    await press('Settings')
    expect(tabs).deep.equals(['settings'])
    expect(selectedTab()).equals('Settings')
    await press('Bats Left')
    await press('Save')
    expect(saves).deep.equals([{ teamId: 't1', settings: { bats: 'left' } }])
    // The card above says how they bat, and says it right away.
    expect(text()).includes('B: L')
  })

  it('is not there without the team, or without the right to coach it', async function () {
    for (const props of [
      { forTeam: undefined, canCoach: true },
      { forTeam: 't1', canCoach: false },
      { forTeam: 't1', canCoach: undefined }
    ]) {
      await render(
        <PlayerScreen client={playerClient()} userId="7" {...props} />
      )
      expect(tabNames(), JSON.stringify(props)).deep.equals(['Videos', 'Stats'])
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('sends an address that asks for it without the right back to Videos', async function () {
    const tabs: Array<[PlayerTab, boolean | undefined]> = []
    await render(
      <PlayerScreen
        client={playerClient()}
        userId="7"
        initialTab="settings"
        forTeam="t1"
        canCoach={false}
        onTab={(tab, correcting) => {
          tabs.push([tab, correcting])
        }}
      />
    )
    expect(selectedTab()).equals('Videos')
    expect(tabs).deep.equals([['videos', true]])
  })

  it('waits for the roles before correcting the address', async function () {
    const tabs: PlayerTab[] = []
    await render(
      <PlayerScreen
        client={playerClient()}
        userId="7"
        initialTab="settings"
        forTeam="t1"
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(selectedTab()).equals('Videos')
    expect(tabs).deep.equals([])
  })

  it('keeps the tab, and its team, through the Stats filter', async function () {
    const filters: unknown[] = []
    const rosters: string[] = []
    await render(
      <PlayerScreen
        client={playerClient([], rosters)}
        userId="7"
        initialTab="stats"
        initialFilter={{ teamId: 't1' }}
        forTeam="t1"
        canCoach
        onFilter={filter => {
          filters.push(filter)
        }}
      />
    )
    await press('Filter')
    await press('Owls')
    await press('Show these')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Settings'])
    await press('Show every game')
    expect(filters).deep.equals([{ teamId: 'tem_other' }, {}])
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Settings'])
    await press('Settings')
    expect(rosters).deep.equals(['t1'])
  })
})

describe('a player’s Settings address, through the app', function () {
  function fixtureFetch(roles: Record<string, string[]>): void {
    globalThis.fetch = async input => {
      const path = (
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      ).split('?')[0]
      const data = path.endsWith('/auth/me')
        ? { id: 100, displayName: 'Coach', isAdmin: false }
        : path.endsWith('/me/roles')
          ? { teams: roles }
          : path.endsWith('/players/7')
            ? { userId: 7, name: 'Jordan P', teams: [] }
            : path.endsWith('/players/7/highlights')
              ? { highlights: [], nextBefore: null, withoutVideo: 0 }
              : path.endsWith('/teams/t1/roster')
                ? [{ ...jordan, userId: 7 }]
                : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  it('opens Settings for a coach of the team, and keeps it on the address', async function () {
    fixtureFetch({ t1: ['coach'] })
    showRoute(parseRoute('/players/7', 'tab=settings&onTeam=t1'), true)
    await render(<App />)
    await act(async () => {
      await delay(50)
    })
    expect(selectedTab()).equals('Settings')
    expect(routePath(currentRoute())).equals(
      '/players/7?tab=settings&onTeam=t1'
    )
    await press('Stats')
    expect(routePath(currentRoute())).equals('/players/7?tab=stats&onTeam=t1')
  })

  it('opens Videos for anybody else, and says so on the address', async function () {
    fixtureFetch({ t1: ['scorekeeper'] })
    showRoute(parseRoute('/players/7', 'tab=settings&onTeam=t1'), true)
    await render(<App />)
    await act(async () => {
      await delay(50)
    })
    expect(selectedTab()).equals('Videos')
    expect(tabNames()).deep.equals(['Videos', 'Stats'])
    expect(routePath(currentRoute())).equals('/players/7?onTeam=t1')
  })
})

describe('a player’s Walk-up tab', function () {
  it('shows for a keeper of the team’s songs, before Settings', async function () {
    const tabs: PlayerTab[] = []
    const rosters: string[] = []
    await render(
      <PlayerScreen
        client={playerClient([], rosters)}
        userId="7"
        forTeam="t1"
        walkUp={{ canEdit: true }}
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up'])
    await press('Walk-up')
    expect(tabs).deep.equals(['walkup'])
    expect(selectedTab()).equals('Walk-up')
    expect(rosters).deep.equals(['t1'])
    expect(text()).includes('No walk-up song yet')
    await act(async () => {
      root?.unmount()
    })
    await render(
      <PlayerScreen
        client={playerClient()}
        userId="7"
        forTeam="t1"
        canCoach
        walkUp={{ canEdit: true }}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up', 'Settings'])
  })

  it('titles the picker with the loaded player’s name, even from a link', async function () {
    // A phone's music, so the tab offers Set.
    const music: WalkUpMusic = {
      available: true,
      providerName: 'Files',
      access: async () => 'authorized',
      search: async () => [],
      pickFile: async () => null,
      play: async () => undefined,
      stop: async () => undefined,
      onState: () => () => undefined
    }
    const picked: Array<[unknown, string]> = []
    // An address parsed from a link carries no title.
    await render(
      <PlayerScreen
        client={playerClient()}
        userId="7"
        initialTab="walkup"
        forTeam="t1"
        music={music}
        walkUp={{
          canEdit: true,
          onPick: (song, playerName) => {
            picked.push([song, playerName])
          }
        }}
      />
    )
    await press('Set')
    expect(picked).deep.equals([[null, 'Jordan P']])
  })

  it('is not there without the team, or without the right to its songs', async function () {
    for (const props of [
      { forTeam: undefined, walkUp: { canEdit: true } },
      { forTeam: 't1', walkUp: { canEdit: false } },
      { forTeam: 't1', walkUp: { canEdit: undefined } },
      { forTeam: 't1', walkUp: undefined }
    ]) {
      await render(
        <PlayerScreen client={playerClient()} userId="7" {...props} />
      )
      expect(tabNames(), JSON.stringify(props)).deep.equals(['Videos', 'Stats'])
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('sends an address that asks for it without the right back to Videos', async function () {
    const tabs: Array<[PlayerTab, boolean | undefined]> = []
    await render(
      <PlayerScreen
        client={playerClient()}
        userId="7"
        initialTab="walkup"
        forTeam="t1"
        canCoach
        walkUp={{ canEdit: false }}
        onTab={(tab, correcting) => {
          tabs.push([tab, correcting])
        }}
      />
    )
    expect(selectedTab()).equals('Videos')
    expect(tabs).deep.equals([['videos', true]])
  })

  it('waits for the roles before correcting the address', async function () {
    const tabs: PlayerTab[] = []
    await render(
      <PlayerScreen
        client={playerClient()}
        userId="7"
        initialTab="walkup"
        forTeam="t1"
        walkUp={{}}
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(selectedTab()).equals('Videos')
    expect(tabs).deep.equals([])
  })
})

describe('a player’s Walk-up address, through the app', function () {
  function fixtureFetch(roles: Record<string, string[]>): void {
    globalThis.fetch = async input => {
      const path = (
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      ).split('?')[0]
      const data = path.endsWith('/auth/me')
        ? { id: 101, displayName: 'Songs', isAdmin: false }
        : path.endsWith('/me/roles')
          ? { teams: roles }
          : path.endsWith('/players/7')
            ? { userId: 7, name: 'Jordan P', teams: [] }
            : path.endsWith('/players/7/highlights')
              ? { highlights: [], nextBefore: null, withoutVideo: 0 }
              : path.endsWith('/teams/t1/roster')
                ? [{ ...jordan, userId: 7 }]
                : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  it('opens Walk-up for a songkeeper, with the short name and nothing to edit it', async function () {
    fixtureFetch({ t1: ['songkeeper'] })
    showRoute(parseRoute('/players/7', 'tab=walkup&onTeam=t1'), true)
    await render(<App />)
    await act(async () => {
      await delay(50)
    })
    expect(selectedTab()).equals('Walk-up')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up'])
    expect(routePath(currentRoute())).equals('/players/7?tab=walkup&onTeam=t1')
    expect(text()).includes('Jordan P')
    expect(document.querySelector('input')).equals(null)
  })

  it('opens Videos for anybody else, and says so on the address', async function () {
    fixtureFetch({ t1: ['coach'] })
    showRoute(parseRoute('/players/7', 'tab=walkup&onTeam=t1'), true)
    await render(<App />)
    await act(async () => {
      await delay(50)
    })
    expect(selectedTab()).equals('Videos')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Settings'])
    expect(routePath(currentRoute())).equals('/players/7?onTeam=t1')
  })
})
