import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asPersonProfile,
  asPlayerDetail,
  asRosterEntry,
  type MyRoles,
  type PlayerHighlights,
  type PlayerStats,
  type PlayerTeam,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type {
  PersonSettings,
  PlayerSettings
} from '../../common/playerSettings'
import type { Role } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'
import { App } from '../App'
import { parseRoute, routePath } from '../navigation/routes'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import type { WalkUpMusic } from '../walkup/walkUpMusicTypes'
import { PlayerScreen, type PlayerTab } from './PlayerScreen'

/**
 * The tabs and filters of a player's page. Opened from a team, both filters
 * start on it and Settings is that team's jersey and positions, for its
 * coaching staff or the player's guardian; opened from anywhere else, the
 * page is a career and Settings is how they bat and throw. Teams is always
 * there. On the web and on a phone alike, because both draw this screen.
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
      '[role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]'
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
/** Each tab pill's side padding, which a strip of five draws narrower. */
const tabSides = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[aria-label="Player sections"] [role="tab"] > div'
    )
  ].map(node => getComputedStyle(node).paddingLeft)
const px = (rem: number): string => `${tsBallpark.rem(rem)}px`
/**
 * Which tab's content is on the screen. PillTabs says which is selected only
 * through `accessibilityState`, which the web build does not render, so the
 * page is read instead.
 */
const selectedTab = (): string | undefined =>
  document.querySelector('[aria-label="Jersey number"]') != null ||
  document.querySelector('[aria-label="Bats Right"]') != null
    ? 'Settings'
    : text().includes('Set walk-up songs in')
      ? 'Walk-up'
      : document.querySelector('[aria-label="Filter videos"]') != null
        ? 'Videos'
        : text().includes('Not on any team yet') || text().includes('#')
          ? 'Teams'
          : text().includes('3 games')
            ? 'Stats'
            : undefined
const text = (): string => document.body.textContent ?? ''

async function typeName(label: string, value: string): Promise<void> {
  await act(async () => {
    const field = document.querySelector<HTMLInputElement>(
      `[aria-label="${label}"]`
    )!
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(field, value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

const roles = (
  teams: Record<string, Role[]>,
  guardianOf: number[] = []
): MyRoles => ({ teams, guardianOf: guardianOf.map(userIdOfGumbo) })
const coach = roles({ t1: ['coach'] })

const jordan = asRosterEntry({
  userId: userIdOfGumbo(7),
  gumboId: 7,
  shortName: 'Jordan P',
  jersey: '4',
  positions: ['CF'],
  bats: 'right',
  throws: 'right',
  isPlayer: true,
  role: 'member',
  section: 'player',
  staffRoles: [],
  inheritedFrom: null
})

const stats: PlayerStats = {
  userId: userIdOfGumbo(7),
  filter: { seasonId: null, teamId: null, year: null },
  games: 3,
  batting: null,
  pitching: null,
  options: {
    seasons: [{ seasonId: 's1', name: 'Spring 2026', year: 2026 }],
    teams: [
      { teamId: 't1', name: 'Hawks' },
      { teamId: 'tem_other', name: 'Owls' }
    ],
    years: [2026]
  }
}

const hawks: PlayerTeam = {
  teamId: 't1',
  teamName: 'Hawks',
  seasonId: 's1',
  seasonName: 'Spring 2026',
  seasonYear: 2026,
  jersey: '4',
  positions: ['CF', 'LF'],
  current: true,
  logoUrl: null
}
const owls: PlayerTeam = {
  teamId: 'tem_other',
  teamName: 'Owls',
  seasonId: null,
  seasonName: null,
  seasonYear: null,
  jersey: null,
  positions: [],
  current: true,
  logoUrl: null
}
/** The Owls, once the player has left them: only their stats are there. */
const owlsLeft: PlayerTeam = { ...owls, current: false }

interface Asked {
  highlights: unknown[]
  stats: unknown[]
}

function playerClient(
  saves: Array<{ teamId: string | null; settings: PlayerSettings }> = [],
  rosters: string[] = [],
  options: {
    teams?: PlayerTeam[]
    asked?: Asked
    pages?: (asked: Record<string, unknown>) => PlayerHighlights
    inviteAs?: 'guardian' | 'team' | null
  } = {}
): TeamStationClient {
  return {
    player: async () =>
      asPlayerDetail({
        userId: userIdOfGumbo(7),
        name: 'Jordan P',
        bats: 'right',
        throws: 'right',
        teams: options.teams ?? [],
        guardianInviteAs: options.inviteAs ?? null
      }),
    playerHighlights: async (
      _userId: string,
      asked: Record<string, unknown>
    ) => {
      options.asked?.highlights.push(asked)
      return (
        options.pages?.(asked) ?? {
          highlights: [],
          nextBefore: null,
          withoutVideo: 0
        }
      )
    },
    playerStats: async (_userId: string, filter: unknown) => {
      options.asked?.stats.push(filter)
      return stats
    },
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
    },
    setPlayerBatsThrows: async (_userId: string, settings: PersonSettings) => {
      saves.push({ teamId: null, settings })
      return {
        userId: userIdOfGumbo(7),
        bats: 'right',
        throws: 'right',
        ...settings
      }
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

describe('a player’s tabs', function () {
  it('reads Videos, Stats, Walk-up, Teams, Settings beside a team', async function () {
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={roles({ t1: ['coach', 'songkeeper'] })}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up', 'Teams'])
    // Dense strips keep the same clearance and scroll when necessary.
    expect(tabSides()).deep.equals(Array(4).fill(px(1.125)))
  })

  it('offers Teams to anybody, and Settings and Walk-up to nobody else', async function () {
    for (const props of [
      { forTeam: undefined, roles: undefined },
      { forTeam: undefined, roles: roles({}) },
      { forTeam: 't1', roles: roles({ t1: ['videographer'] }) },
      { forTeam: 't1', roles: undefined },
      // A guardian of somebody else.
      { forTeam: 't1', roles: roles({}, [8]) }
    ]) {
      await render(
        <PlayerScreen
          client={playerClient()}
          userId={userIdOfGumbo(7)}
          {...props}
        />
      )
      expect(tabNames(), JSON.stringify(props)).deep.equals([
        'Videos',
        'Stats',
        'Teams'
      ])
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('offers Settings from Home to a coach of any of the player’s teams', async function () {
    await render(
      <PlayerScreen
        client={playerClient([], [], { teams: [hawks, owls] })}
        userId={userIdOfGumbo(7)}
        roles={roles({ tem_other: ['assistant'] })}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    expect(tabSides()).deep.equals(Array(3).fill(px(1.125)))
    await act(async () => {
      root?.unmount()
    })
    // Coaching a team the player is not on is no right over the player.
    await render(
      <PlayerScreen
        client={playerClient([], [], { teams: [hawks] })}
        userId={userIdOfGumbo(7)}
        roles={roles({ tem_other: ['coach'] })}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
  })

  it('offers no Settings from Home to a coach of a team the player has left', async function () {
    // The Owls are still among their teams, for the stats played there.
    await render(
      <PlayerScreen
        client={playerClient([], [], { teams: [hawks, owlsLeft] })}
        userId={userIdOfGumbo(7)}
        roles={roles({ tem_other: ['coach'] })}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    await press('Teams')
    expect(text()).includes('Owls')
  })

  it('gives a guardian Settings and Walk-up for their own child', async function () {
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={roles({}, [7])}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up', 'Teams'])
    await press('Player settings')
    expect(document.querySelector('[aria-label="Jersey number"]')).not.equals(
      null
    )
    await act(async () => {
      root?.unmount()
    })
    // From Home: Settings, and no Walk-up without a team for the song.
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(7)}
        roles={roles({}, [7])}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
  })

  it('knows a guardian by the row the player is now, from an address made before a merge', async function () {
    // The address names row 3, since closed into 7, which the server answers
    // as; the guardian's roles name the child by 7.
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(3)}
        forTeam="t1"
        roles={roles({}, [7])}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up', 'Teams'])
  })
})

describe('a player’s profile the viewer may not see', function () {
  /** A client whose profile read fails with `error`. */
  const refusing = (error: Error): TeamStationClient => {
    const client = playerClient()
    client.player = async () => {
      throw error
    }
    return client
  }
  for (const [code, status] of [
    ['notFound', 404],
    ['forbidden', 403]
  ] as const)
    it(`says so on a page of its own, with Back, when the server answers ${status}`, async function () {
      let back = 0
      await render(
        <PlayerScreen
          client={refusing(new HttpError(code, 'Not found'))}
          userId={userIdOfGumbo(8)}
          onBack={() => {
            back++
          }}
        />
      )
      const page = document.querySelector('[data-testid="Player unavailable"]')
      expect(page).not.equals(null)
      expect(page!.querySelector('[role="heading"]')!.textContent).equals(
        'Profile not available'
      )
      expect(text()).includes(
        'You don\u2019t have access to this player\u2019s profile, or it no longer exists.'
      )
      expect(tabNames(), 'no tabs').deep.equals([])
      expect(text()).not.includes('Not found')
      await press('Back')
      expect(back).equals(1)
    })

  it('keeps the error line for any other failure', async function () {
    await render(
      <PlayerScreen
        client={refusing(
          new HttpError('internal', 'The server is having a moment')
        )}
        userId={userIdOfGumbo(8)}
        onBack={() => undefined}
      />
    )
    expect(document.querySelector('[data-testid="Player unavailable"]')).equals(
      null
    )
    expect(text()).includes('The server is having a moment')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
  })
})

describe('a player’s filters', function () {
  it('start both tabs on the team the page was opened for', async function () {
    const asked: Asked = { highlights: [], stats: [] }
    await render(
      <PlayerScreen
        client={playerClient([], [], { asked })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
      />
    )
    expect(asked.highlights).deep.equals([{ before: undefined, teamId: 't1' }])
    expect(asked.stats).deep.equals([{ teamId: 't1' }])
    // The pill says what the list is narrowed to.
    expect(find('Filter videos')?.textContent).equals('filter_altHawks')
    await press('Stats')
    expect(find('Filter stats')?.textContent).equals('filter_altHawks')
  })

  it('start on a career from anywhere else', async function () {
    const asked: Asked = { highlights: [], stats: [] }
    await render(
      <PlayerScreen
        client={playerClient([], [], { asked })}
        userId={userIdOfGumbo(7)}
        initialFilter={{}}
        initialVideoFilter={{}}
      />
    )
    expect(asked.highlights).deep.equals([{ before: undefined }])
    expect(asked.stats).deep.equals([{}])
    expect(find('Filter videos')?.textContent).equals('filter_altCareer')
    await press('Stats')
    expect(find('Filter stats')?.textContent).equals('filter_altCareer')
  })

  it('start on what the address or the tap asked for, over the team', async function () {
    const asked: Asked = { highlights: [], stats: [] }
    await render(
      <PlayerScreen
        client={playerClient([], [], { asked })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        // A box score: the game's season and side.
        initialFilter={{ seasonId: 's1', teamId: 't1' }}
        initialVideoFilter={{ year: 2026 }}
      />
    )
    expect(asked.highlights).deep.equals([{ before: undefined, year: 2026 }])
    expect(asked.stats).deep.equals([{ seasonId: 's1', teamId: 't1' }])
  })

  it('narrows Videos from the pill, and pages through what it narrowed to', async function () {
    const asked: Asked = { highlights: [], stats: [] }
    const chosen: unknown[] = []
    const highlight = (id: string): PlayerHighlights['highlights'][number] => ({
      eventId: id,
      gameId: 'g1',
      videoId: 'v1',
      teamId: 't1',
      teamName: 'Hawks',
      outcome: `Single ${id}`,
      title: `Single ${id}`,
      playAt: '2026-04-01T18:00:00Z',
      startOffsetSec: 60,
      playOffsetSec: 62,
      stillUrl: '/still.jpg'
    })
    await render(
      <PlayerScreen
        client={playerClient([], [], {
          asked,
          pages: request =>
            request.seasonId == null
              ? { highlights: [], nextBefore: null, withoutVideo: 0 }
              : request.before == null
                ? {
                    highlights: [highlight('e1')],
                    nextBefore: 'c1',
                    withoutVideo: 0
                  }
                : {
                    highlights: [highlight('e2')],
                    nextBefore: null,
                    withoutVideo: 0
                  }
        })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        onVideoFilter={filter => {
          chosen.push(filter)
        }}
      />
    )
    expect(text()).includes('No highlights under this filter.')
    await press('Filter videos')
    await press('Spring 2026')
    await press('Show these')
    expect(chosen).deep.equals([{ seasonId: 's1' }])
    expect(find('Filter videos')?.textContent).equals('filter_altSpring 2026')
    expect(text()).includes('Single e1')
    await press('Show more')
    expect(asked.highlights).deep.equals([
      { before: undefined, teamId: 't1' },
      { before: undefined, seasonId: 's1' },
      { before: 'c1', seasonId: 's1' }
    ])
    expect(text()).includes('Single e1')
    expect(text()).includes('Single e2')
    // The Stats tab keeps its own filter.
    expect(asked.stats).deep.equals([{ teamId: 't1' }])
  })

  it('clears an empty Videos filter back to a career', async function () {
    const asked: Asked = { highlights: [], stats: [] }
    const chosen: unknown[] = []
    await render(
      <PlayerScreen
        client={playerClient([], [], { asked })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        onVideoFilter={filter => {
          chosen.push(filter)
        }}
      />
    )
    await press('Show every game')
    expect(chosen).deep.equals([{}])
    expect(asked.highlights).deep.equals([
      { before: undefined, teamId: 't1' },
      { before: undefined }
    ])
    expect(text()).includes('No highlights of this player yet.')
  })
})

describe('a player’s Teams tab', function () {
  it('lists each team and season with the number and positions worn there', async function () {
    const opened: Array<[string, string]> = []
    const tabs: PlayerTab[] = []
    await render(
      <PlayerScreen
        client={playerClient([], [], { teams: [hawks, owls] })}
        userId={userIdOfGumbo(7)}
        onTab={tab => {
          tabs.push(tab)
        }}
        onOpenTeam={(teamId, name) => {
          opened.push([teamId, name])
        }}
      />
    )
    await press('Teams')
    expect(tabs).deep.equals(['teams'])
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].filter(node => /Hawks|Owls/.test(node.textContent ?? ''))
    expect(rows.map(row => row.textContent)).deep.equals([
      'HAHawksSpring 2026 · CF · LF#4chevron_right',
      'OWOwlschevron_right'
    ])
    await act(async () => {
      rows[1].click()
      await delay(20)
    })
    expect(opened).deep.equals([['tem_other', 'Owls']])
  })

  it('draws each team’s logo, and its initials when it has none', async function () {
    await render(
      <PlayerScreen
        client={playerClient([], [], {
          teams: [{ ...hawks, logoUrl: 'https://img.example/hawks.png' }, owls]
        })}
        userId={userIdOfGumbo(7)}
        initialTab="teams"
        onOpenTeam={() => {}}
      />
    )
    expect(
      document.querySelector('img[src="https://img.example/hawks.png"]')
    ).not.equals(null)
    expect(document.querySelectorAll('img')).length(1)
    const owlsRow = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => (node.textContent ?? '').includes('Owls'))
    expect(owlsRow?.textContent).equals('OWOwlschevron_right')
  })

  it('says so when there are none', async function () {
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(7)}
        initialTab="teams"
      />
    )
    expect(text()).includes('Not on any team yet.')
  })
})

describe('a player’s Settings tab', function () {
  it('abbreviates collision-expanded roster names on ordinary tabs, including delayed profiles', async function () {
    for (const delayed of [false, true]) {
      const client = playerClient()
      const entry = {
        ...jordan,
        shortName: 'Paul Goldschmidt',
        nameDetails: {
          firstName: 'Paul',
          lastName: 'Goldschmidt',
          displayName: 'Paul Goldschmidt'
        }
      }
      let release:
        ((player: ReturnType<typeof asPlayerDetail>) => void) | undefined
      client.player = async () =>
        delayed
          ? await new Promise(resolve => {
              release = resolve
            })
          : asPlayerDetail({
              userId: userIdOfGumbo(7),
              name: 'Paul G',
              teams: []
            })
      client.roster = async () => [entry]
      client.setPlayerSettings = async () => ({ ...entry, jersey: '9' })
      await render(
        <PlayerScreen
          client={client}
          userId={userIdOfGumbo(7)}
          forTeam="t1"
          roles={coach}
          initialTab="settings"
        />
      )
      await typeName('Jersey number', '9')
      await press('Save')
      expect(text()).includes('Paul Goldschmidt')
      await press('Videos')
      expect(text()).includes('Paul G').and.not.includes('Goldschmidt')
      await act(async () => {
        release?.(
          asPlayerDetail({
            userId: userIdOfGumbo(7),
            name: 'Paul G',
            teams: []
          })
        )
        await delay(20)
      })
      expect(text()).includes('Paul G').and.not.includes('Goldschmidt')
      await press('Stats')
      expect(text()).not.includes('Goldschmidt')
      await act(async () => {
        root?.unmount()
      })
      root = undefined
    }
  })
  it('recovers the full header name after a failed independent header lookup and successful Save', async function () {
    const client = playerClient()
    const entry = {
      ...jordan,
      nameDetails: {
        firstName: 'Mookie',
        lastName: 'Betts',
        displayName: 'Mookie Betts'
      }
    }
    let calls = 0
    client.roster = async () => {
      if (++calls > 1) throw new Error('temporary refusal')
      return [entry]
    }
    client.setPlayerSettings = async () => ({
      ...entry,
      shortName: 'Paul G',
      nameDetails: {
        firstName: 'Paul',
        lastName: 'Goldschmidt',
        displayName: 'Paul Goldschmidt'
      }
    })
    await render(
      <PlayerScreen
        client={client}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={coach}
        initialTab="settings"
      />
    )
    expect(text()).not.includes('Mookie Betts')
    await typeName('First name', 'Paul')
    await typeName('Last name', 'Goldschmidt')
    await press('Save')
    expect(text()).includes('Paul Goldschmidt')
  })

  it('retains the saved public name while the initial player profile is delayed', async function () {
    const client = playerClient()
    const entry = {
      ...jordan,
      nameDetails: {
        firstName: 'Mookie',
        lastName: 'Betts',
        displayName: 'Mookie Betts'
      }
    }
    let release:
      ((player: ReturnType<typeof asPlayerDetail>) => void) | undefined
    client.player = async () =>
      await new Promise(resolve => {
        release = resolve
      })
    client.roster = async () => [entry]
    client.setPlayerSettings = async () => ({
      ...entry,
      shortName: 'Paul G',
      nameDetails: {
        firstName: 'Paul',
        lastName: 'Goldschmidt',
        displayName: 'Paul Goldschmidt'
      }
    })
    await render(
      <PlayerScreen
        client={client}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={coach}
        initialTab="settings"
      />
    )
    await typeName('First name', 'Paul')
    await typeName('Last name', 'Goldschmidt')
    await press('Save')
    await press('Videos')
    expect(text()).includes('Paul G').and.not.includes('Goldschmidt')
    await act(async () => {
      release?.(
        asPlayerDetail({
          userId: userIdOfGumbo(7),
          name: 'Mookie B',
          teams: []
        })
      )
      await delay(20)
    })
    expect(text()).includes('Paul G').and.not.includes('Mookie B')
  })
  it('shows the saved name and rejects an older header-name response', async function () {
    const client = playerClient()
    const entry = {
      ...jordan,
      nameDetails: {
        firstName: 'Mookie',
        lastName: 'Betts',
        displayName: 'Mookie Betts'
      }
    }
    let calls = 0
    let release: ((rows: Array<typeof entry>) => void) | undefined
    client.roster = async () =>
      ++calls === 1
        ? [entry]
        : await new Promise(resolve => {
            release = resolve
          })
    client.setPlayerSettings = async () => ({
      ...entry,
      shortName: 'Paul G',
      nameDetails: {
        firstName: 'Paul',
        lastName: 'Goldschmidt',
        displayName: 'Paul Goldschmidt'
      }
    })
    await render(
      <PlayerScreen
        client={client}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={coach}
        initialTab="settings"
      />
    )
    for (const [label, value] of [
      ['First name', 'Paul'],
      ['Last name', 'Goldschmidt']
    ]) {
      await act(async () => {
        const field = document.querySelector<HTMLInputElement>(
          `[aria-label="${label}"]`
        )!
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(field, value)
        field.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }
    await press('Save')
    expect(text()).includes('Paul Goldschmidt')
    await act(async () => {
      release?.([entry])
      await delay(20)
    })
    expect(text()).includes('Paul Goldschmidt').and.not.includes('Mookie Betts')
    await press('Videos')
    expect(text()).includes('Paul G').and.not.includes('Goldschmidt')
  })
  it('shows authorized full names only in Settings and forwards completed saves', async function () {
    const client = playerClient()
    client.roster = async () => [
      {
        ...jordan,
        nameDetails: {
          firstName: 'Mookie',
          lastName: 'Betts',
          displayName: 'Mookie Betts'
        }
      }
    ]
    let saved = false
    await render(
      <PlayerScreen
        client={client}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={coach}
        initialTab="settings"
        onSettingsSaved={() => {
          saved = true
        }}
      />
    )
    expect(text()).includes('Mookie Betts')
    await press('SS')
    await press('Save')
    expect(saved).equals(true)
    await press('Videos')
    expect(text()).includes('Jordan P').and.not.includes('Mookie Betts')
  })
  it('edits the jersey and positions on the team the page was opened for', async function () {
    const saves: Array<{ teamId: string | null; settings: PlayerSettings }> = []
    const tabs: PlayerTab[] = []
    await render(
      <PlayerScreen
        client={playerClient(saves)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={coach}
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    await press('Player settings')
    expect(tabs).deep.equals(['settings'])
    expect(selectedTab()).equals('Settings')
    expect(document.querySelector('[aria-label="Bats Right"]')).equals(null)
    await press('SS')
    await press('Save')
    expect(saves).deep.equals([
      { teamId: 't1', settings: { positions: ['SS', 'CF'] } }
    ])
  })

  it('edits how they bat and throw from anywhere else', async function () {
    const saves: Array<{ teamId: string | null; settings: PlayerSettings }> = []
    await render(
      <PlayerScreen
        client={playerClient(saves)}
        userId={userIdOfGumbo(7)}
        initialTab="settings"
        roles={roles({}, [7])}
      />
    )
    expect(selectedTab()).equals('Settings')
    expect(document.querySelector('[aria-label="Jersey number"]')).equals(null)
    await press('Bats Left')
    await press('Save')
    expect(saves).deep.equals([{ teamId: null, settings: { bats: 'left' } }])
    // The card above says how they bat, and says it right away.
    expect(text()).includes('B: L')
  })

  it('sends an address that asks for it without the right back to Videos', async function () {
    for (const props of [
      { forTeam: 't1', roles: roles({ t1: ['songkeeper', 'videographer'] }) },
      { forTeam: undefined, roles: roles({}) }
    ]) {
      const tabs: Array<[PlayerTab, boolean | undefined]> = []
      await render(
        <PlayerScreen
          client={playerClient()}
          userId={userIdOfGumbo(7)}
          initialTab="settings"
          {...props}
          onTab={(tab, correcting) => {
            tabs.push([tab, correcting])
          }}
        />
      )
      expect(selectedTab(), JSON.stringify(props)).equals('Videos')
      expect(tabs).deep.equals([['videos', true]])
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('waits for the roles before correcting the address', async function () {
    const tabs: PlayerTab[] = []
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(7)}
        initialTab="settings"
        forTeam="t1"
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(selectedTab()).equals(undefined)
    expect(document.querySelector('[aria-label="Jersey number"]')).equals(null)
    expect(tabNames()).not.includes('Settings')
    expect(tabs).deep.equals([])
  })

  it('keeps the tab, and its team, through the Stats filter', async function () {
    const filters: unknown[] = []
    const rosters: string[] = []
    await render(
      <PlayerScreen
        client={playerClient([], rosters)}
        userId={userIdOfGumbo(7)}
        initialTab="stats"
        initialFilter={{ teamId: 't1' }}
        forTeam="t1"
        roles={coach}
        onFilter={filter => {
          filters.push(filter)
        }}
      />
    )
    await press('Filter stats')
    await press('Owls')
    await press('Show these')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    await press('Show every game')
    expect(filters).deep.equals([{ teamId: 'tem_other' }, {}])
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    await press('Player settings')
    // The roster of the team the page was opened for, and no other: for the
    // form, and for the whole name a roster manager reads in the header.
    expect(rosters.length).greaterThan(0)
    expect(new Set(rosters)).deep.equals(new Set(['t1']))
  })
})

describe('taking a player off the team from Settings', function () {
  function removeClient(
    asked: unknown[],
    options: {
      canHoldRoles?: boolean
      refuse?: string
      teams?: PlayerTeam[]
      removed?: boolean
    } = {}
  ): TeamStationClient {
    return Object.assign(
      playerClient([], [], { teams: options.teams ?? [hawks] }),
      {
        personProfile: async () =>
          asPersonProfile({
            context: { kind: 'team', id: 't1', name: 'Hawks' },
            person: {
              userId: userIdOfGumbo(7),
              gumboId: 7,
              shortName: 'Jordan P',
              fullName: 'Jordan Pacheco',
              avatarUrl: null,
              canHoldRoles: options.canHoldRoles ?? true
            },
            guardianOf: [],
            sections: [
              {
                level: 'team',
                groups: [{ id: 't1', name: 'Hawks' }],
                roles: ['scorekeeper'],
                member: true,
                follower: false,
                editable: true
              }
            ],
            viewer: { manages: true, admin: true }
          }),
        removePerson: async (kind: string, id: string, userId: string) => {
          asked.push(['remove', kind, id, userId])
          if (options.refuse != null)
            throw new HttpError('conflict', options.refuse)
          return { removed: options.removed ?? true }
        }
      }
    )
  }
  const removeButton = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[data-testid="playerRemoveFromTeam"] [role="button"]'
    )

  it('is last on Settings for the team’s administrator, whether or not the player can sign in', async function () {
    for (const canHoldRoles of [true, false]) {
      await render(
        <PlayerScreen
          client={removeClient([], { canHoldRoles })}
          userId={userIdOfGumbo(7)}
          forTeam="t1"
          initialTab="settings"
          roles={roles({ t1: ['admin'] })}
        />
      )
      expect(removeButton()?.textContent, String(canHoldRoles)).equals(
        'Remove from Hawks'
      )
      // Below the Team roles, which only a player who can sign in has.
      expect(text().endsWith('Remove from Hawks'), String(canHoldRoles)).equals(
        true
      )
      expect(text().includes('TEAM ROLES')).equals(canHoldRoles)
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('is not there for a coach, an assistant, a guardian, or without the team', async function () {
    for (const props of [
      { forTeam: 't1', roles: roles({ t1: ['coach'] }) },
      { forTeam: 't1', roles: roles({ t1: ['assistant', 'scorekeeper'] }) },
      { forTeam: 't1', roles: roles({}, [7]) },
      // An administrator of another team.
      { forTeam: 't1', roles: roles({ t1: ['coach'], tem_other: ['admin'] }) },
      { forTeam: undefined, roles: roles({ t1: ['admin'] }) }
    ]) {
      await render(
        <PlayerScreen
          client={removeClient([])}
          userId={userIdOfGumbo(7)}
          initialTab="settings"
          {...props}
        />
      )
      expect(selectedTab(), JSON.stringify(props)).equals('Settings')
      expect(removeButton(), JSON.stringify(props)).equals(null)
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('is not there for a team the player has left', async function () {
    await render(
      <PlayerScreen
        client={removeClient([], { teams: [{ ...hawks, current: false }] })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={roles({ t1: ['admin'] })}
      />
    )
    expect(selectedTab()).equals('Settings')
    expect(removeButton()).equals(null)
    expect(text()).not.includes('Remove from Hawks')
  })

  it('says nothing was changed, and stays, when the server took nobody off', async function () {
    const asked: unknown[] = []
    const removed: unknown[] = []
    await render(
      <PlayerScreen
        client={removeClient(asked, { removed: false })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={roles({ t1: ['admin'] })}
        onRemovedFromTeam={() => {
          removed.push('gone')
        }}
      />
    )
    await press('Remove from Hawks')
    await press('Remove Jordan P')
    expect(asked).deep.equals([['remove', 'team', 't1', userIdOfGumbo(7)]])
    expect(removed).deep.equals([])
    expect(text()).not.includes('Removed Jordan P from Hawks')
    expect(
      document.querySelector(
        '[data-testid="playerRemoveFromTeam"] [role="alert"]'
      )?.textContent
    ).equals('Jordan P is not on Hawks. Nothing was changed.')
    expect(removeButton()?.getAttribute('aria-disabled')).not.equals('true')
  })

  it('asks first, then takes them off through the whole-person route and says so', async function () {
    const asked: unknown[] = []
    const removed: unknown[] = []
    await render(
      <PlayerScreen
        client={removeClient(asked)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={roles({ t1: ['admin'] })}
        onRemovedFromTeam={(teamId, teamName, notice) => {
          removed.push([teamId, teamName, notice])
        }}
      />
    )
    await press('Remove from Hawks')
    expect(text()).includes('Remove Jordan P from Hawks?')
    expect(text()).includes(
      'Jordan P leaves Hawks: off the roster, and every role they hold on it.'
    )
    // Cancel takes nothing away.
    await press('Cancel')
    expect(asked).deep.equals([])
    expect(text()).not.includes('Remove Jordan P from Hawks?')
    await press('Remove from Hawks')
    await press('Remove Jordan P')
    expect(asked).deep.equals([['remove', 'team', 't1', userIdOfGumbo(7)]])
    expect(removed).deep.equals([
      ['t1', 'Hawks', 'Removed Jordan P from Hawks']
    ])
  })

  it('shows the server’s refusal and stays', async function () {
    const asked: unknown[] = []
    const removed: unknown[] = []
    await render(
      <PlayerScreen
        client={removeClient(asked, {
          refuse:
            'Add another active direct administrator before removing the last one'
        })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={roles({ t1: ['admin'] })}
        onRemovedFromTeam={() => {
          removed.push('gone')
        }}
      />
    )
    await press('Remove from Hawks')
    await press('Remove Jordan P')
    expect(asked).length(1)
    expect(removed).deep.equals([])
    expect(
      document.querySelector(
        '[data-testid="playerRemoveFromTeam"] [role="alert"]'
      )?.textContent
    ).equals(
      'Add another active direct administrator before removing the last one'
    )
    expect(removeButton()?.getAttribute('aria-disabled')).not.equals('true')
  })

  it('goes back to the team’s roster through the app, with a confirmation', async function () {
    const asked: string[] = []
    fixtureFetch({ t1: ['admin'] }, [], asked)
    await open('/players/usr_1111111111111111111118', 'tab=settings&onTeam=t1')
    expect(selectedTab()).equals('Settings')
    await press('Remove from Hawks')
    await press('Remove Jordan P')
    await act(async () => {
      await delay(50)
    })
    expect(asked).include(
      'DELETE /api/v1/manage/team/t1/people/usr_1111111111111111111118'
    )
    expect(routePath(currentRoute())).equals('/teams/t1?tab=team')
    expect(text()).includes('Removed Jordan P from Hawks')
  })
})

/** The app, answering from fixtures, with the roles given and every URL asked. */
function fixtureFetch(
  roles: Record<string, string[]>,
  guardianOf: number[] = [],
  asked: string[] = []
): void {
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const method = init?.method ?? 'GET'
    asked.push(method === 'GET' ? url : `${method} ${url}`)
    const path = url.split('?')[0]
    const data = path.endsWith(
      '/manage/team/t1/people/usr_1111111111111111111118'
    )
      ? { removed: true }
      : path.endsWith('/auth/me')
        ? { id: userIdOfGumbo(100), displayName: 'Coach', isAdmin: false }
        : path.endsWith('/me/roles')
          ? { teams: roles, guardianOf: guardianOf.map(userIdOfGumbo) }
          : path.endsWith('/players/usr_1111111111111111111118')
            ? { userId: userIdOfGumbo(7), name: 'Jordan P', teams: [hawks] }
            : path.endsWith('/players/usr_1111111111111111111118/highlights')
              ? { highlights: [], nextBefore: null, withoutVideo: 0 }
              : path.endsWith('/players/usr_1111111111111111111118/stats')
                ? stats
                : path.endsWith('/teams/t1/roster')
                  ? [{ ...jordan, userId: userIdOfGumbo(7) }]
                  : []
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function open(path: string, search = ''): Promise<void> {
  showRoute(parseRoute(path, search), true)
  await render(<App />)
  await act(async () => {
    await delay(50)
  })
}

describe('a player’s Settings address, through the app', function () {
  it('opens Settings for a coach of the team, and keeps it on the address', async function () {
    fixtureFetch({ t1: ['coach'] })
    await open('/players/usr_1111111111111111111118', 'tab=settings&onTeam=t1')
    expect(selectedTab()).equals('Settings')
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?tab=settings&onTeam=t1'
    )
    await press('Stats')
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?tab=stats&onTeam=t1'
    )
  })

  it('opens Videos for anybody else, and says so on the address', async function () {
    fixtureFetch({ t1: ['videographer'] })
    await open('/players/usr_1111111111111111111118', 'tab=settings&onTeam=t1')
    expect(selectedTab()).equals('Videos')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?onTeam=t1'
    )
  })

  it('opens a guardian’s Settings with no team, for how the child bats', async function () {
    fixtureFetch({}, [7])
    await open('/players/usr_1111111111111111111118', 'tab=settings')
    expect(selectedTab()).equals('Settings')
    expect(document.querySelector('[aria-label="Jersey number"]')).equals(null)
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?tab=settings'
    )
  })
})

describe('a player’s Teams and Videos addresses, through the app', function () {
  it('reopens Teams, and opens a team from it', async function () {
    fixtureFetch({})
    await open('/players/usr_1111111111111111111118', 'tab=teams')
    expect(selectedTab()).equals('Teams')
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?tab=teams'
    )
    await press('Hawks')
    expect(routePath(currentRoute())).equals('/teams/t1')
  })

  it('reads the Videos filter from the address, and writes the one chosen', async function () {
    const asked: string[] = []
    fixtureFetch({}, [], asked)
    await open('/players/usr_1111111111111111111118', 'vseason=s1&onTeam=t1')
    expect(
      asked.filter(url =>
        url.includes('/players/usr_1111111111111111111118/highlights')
      )
    ).deep.equals([
      '/api/v1/players/usr_1111111111111111111118/highlights?seasonId=s1'
    ])
    expect(find('Filter videos')?.textContent).equals('filter_altSpring 2026')
    await press('Filter videos')
    await press('2026')
    await press('Show these')
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?vyear=2026&onTeam=t1'
    )
    expect(asked.filter(url => url.includes('/highlights')).at(-1)).equals(
      '/api/v1/players/usr_1111111111111111111118/highlights?year=2026'
    )
  })
})

describe('a player’s Walk-up tab', function () {
  it('shows for a keeper of the team’s songs, before Teams', async function () {
    const tabs: PlayerTab[] = []
    const rosters: string[] = []
    await render(
      <PlayerScreen
        client={playerClient([], rosters)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        roles={roles({ t1: ['songkeeper'] })}
        onTab={tab => {
          tabs.push(tab)
        }}
      />
    )
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up', 'Teams'])
    await press('Walk-up')
    expect(tabs).deep.equals(['walkup'])
    expect(selectedTab()).equals('Walk-up')
    expect(rosters).deep.equals(['t1'])
    expect(text()).includes('No walk-up song yet')
  })

  it('titles the picker with the loaded player’s name, even from a link', async function () {
    // A phone's music, so the tab offers Set.
    const music: WalkUpMusic = {
      available: true,
      djSupported: false,
      providerName: 'Files',
      access: async () => 'authorized',
      search: async () => [],
      pickFile: async () => null,
      play: async () => undefined,
      stop: async () => undefined,
      onState: () => () => undefined,
      prepareOffline: async () => null
    }
    const picked: Array<[unknown, string]> = []
    // An address parsed from a link carries no title.
    await render(
      <PlayerScreen
        client={playerClient()}
        userId={userIdOfGumbo(7)}
        initialTab="walkup"
        forTeam="t1"
        music={music}
        roles={roles({ t1: ['scorekeeper'] })}
        walkUp={{
          onPick: (song, playerName) => {
            picked.push([song, playerName])
          }
        }}
      />
    )
    // A scorekeeper has Settings too, so `Set` is pressed by its whole label.
    const set = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent === 'Set')
    expect(set).not.equals(undefined)
    await act(async () => {
      set!.click()
      await delay(20)
    })
    expect(picked).deep.equals([[null, 'Jordan P']])
  })

  it('is not there without the team, or without the right to its songs', async function () {
    for (const props of [
      { forTeam: undefined, roles: roles({ t1: ['songkeeper'] }) },
      { forTeam: 't1', roles: roles({ t1: ['coach'] }) },
      { forTeam: 't1', roles: undefined }
    ]) {
      await render(
        <PlayerScreen
          client={playerClient()}
          userId={userIdOfGumbo(7)}
          {...props}
        />
      )
      expect(tabNames(), JSON.stringify(props)).not.includes('Walk-up')
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
        userId={userIdOfGumbo(7)}
        initialTab="walkup"
        forTeam="t1"
        roles={coach}
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
        userId={userIdOfGumbo(7)}
        initialTab="walkup"
        forTeam="t1"
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
  it('opens Walk-up for a songkeeper, with the short name and nothing to edit it', async function () {
    fixtureFetch({ t1: ['songkeeper'] })
    await open('/players/usr_1111111111111111111118', 'tab=walkup&onTeam=t1')
    expect(selectedTab()).equals('Walk-up')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Walk-up', 'Teams'])
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?tab=walkup&onTeam=t1'
    )
    expect(text()).includes('Jordan P')
    expect(document.querySelector('input')).equals(null)
  })

  it('opens Videos for anybody else, and says so on the address', async function () {
    fixtureFetch({ t1: ['coach'] })
    await open('/players/usr_1111111111111111111118', 'tab=walkup&onTeam=t1')
    expect(selectedTab()).equals('Videos')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
    expect(routePath(currentRoute())).equals(
      '/players/usr_1111111111111111111118?onTeam=t1'
    )
  })
})

/** What the page sent to `POST /relationship-requests`. */
type Sent = Array<Record<string, unknown>>

/**
 * The player's client, with invitations answered by `answer`, and the
 * viewer invited to invite a guardian as `inviteAs` says.
 */
function guardianClient(
  sent: Sent,
  answer: (body: Record<string, unknown>) => Promise<unknown> = async () => ({
    id: 'req_1',
    status: 'pending'
  }),
  teams: PlayerTeam[] = [hawks],
  inviteAs: 'guardian' | 'team' | null = 'team'
): TeamStationClient {
  const client = playerClient([], [], { teams, inviteAs })
  client.inviteRelationship = (async (body: Record<string, unknown>) => {
    sent.push(body)
    return await answer(body)
  }) as unknown as TeamStationClient['inviteRelationship']
  return client
}

async function typeInto(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input!.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay(10)
  })
}

const stranger = { userId: userIdOfGumbo(100), isAdmin: false }
const requestButton = (): HTMLElement | undefined =>
  find('Request to be a guardian') ?? find('Guardian request sent')

describe('inviting a guardian from a player’s Settings', function () {
  it('is offered to a guardian anywhere, and beside the team to its staff while the server allows it', async function () {
    for (const [props, inviteAs, shown] of [
      [{ forTeam: 't1', roles: roles({ t1: ['coach'] }) }, 'team', true],
      [{ forTeam: 't1', roles: roles({ t1: ['assistant'] }) }, 'team', true],
      [{ forTeam: 't1', roles: roles({ t1: ['admin'] }) }, 'team', true],
      // Once the player has a guardian, the staff invite nobody.
      [{ forTeam: 't1', roles: roles({ t1: ['coach'] }) }, null, false],
      // From Home there is no team to send it from.
      [{ forTeam: undefined, roles: roles({ t1: ['coach'] }) }, 'team', false],
      // A guardian invites another beside a team and from Home alike.
      [{ forTeam: 't1', roles: roles({}, [7]) }, 'guardian', true],
      [{ forTeam: undefined, roles: roles({}, [7]) }, 'guardian', true]
    ] as const) {
      const about = JSON.stringify({ ...props, inviteAs })
      await render(
        <PlayerScreen
          client={guardianClient([], undefined, [hawks], inviteAs)}
          userId={userIdOfGumbo(7)}
          initialTab="settings"
          {...props}
        />
      )
      expect(selectedTab(), about).equals('Settings')
      expect(text().includes('Invite a guardian'), about).equals(shown)
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('sends the team’s invitation, retries under the same key and confirms', async function () {
    const sent: Sent = []
    let fail = true
    await render(
      <PlayerScreen
        client={guardianClient(sent, async () => {
          if (fail) throw new Error('Network request failed')
          return { id: 'req_1', status: 'pending' }
        })}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={coach}
      />
    )
    expect(text()).includes(
      'A guardian sees every team Jordan P plays on and manages their number'
    )
    await typeInto('E-mail address', ' Parent@Example.com ')
    await press('Send invitation')
    expect(text()).includes('Network request failed')
    fail = false
    await press('Send invitation')
    expect(sent).has.length(2)
    const [first, second] = sent
    expect(first).deep.include({
      kind: 'guardian',
      playerUserId: userIdOfGumbo(7),
      guardian: { email: 'parent@example.com' },
      sender: { kind: 'team', id: 't1' }
    })
    expect(first.idempotencyKey).a('string')
    expect(second).deep.equals(first)
    expect(text()).includes(
      'An invitation is on its way to Parent@Example.com.'
    )
    expect(text()).not.includes('Network request failed')
    // The next invitation is a new send, with a key of its own.
    await typeInto('E-mail address', 'other@example.com')
    await press('Send invitation')
    expect(sent[2].idempotencyKey).not.equals(first.idempotencyKey)
    expect(text()).includes('An invitation is on its way to other@example.com.')
  })

  it('sends a guardian’s invitation in their own name, with no team, wherever it opens', async function () {
    for (const forTeam of ['t1', undefined]) {
      const sent: Sent = []
      await render(
        <PlayerScreen
          client={guardianClient(sent, undefined, [hawks], 'guardian')}
          userId={userIdOfGumbo(7)}
          forTeam={forTeam}
          initialTab="settings"
          roles={roles({}, [7])}
        />
      )
      await typeInto('E-mail address', 'Second@Example.com')
      await press('Send invitation')
      expect(sent, String(forTeam)).has.length(1)
      expect(sent[0]).deep.include({
        kind: 'guardian',
        playerUserId: userIdOfGumbo(7),
        guardian: { email: 'second@example.com' }
      })
      expect(sent[0]).not.has.property('sender')
      expect(text()).includes(
        'An invitation is on its way to Second@Example.com.'
      )
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('sends nothing for an empty address', async function () {
    const sent: Sent = []
    await render(
      <PlayerScreen
        client={guardianClient(sent)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={coach}
      />
    )
    await typeInto('E-mail address', '   ')
    await press('Send invitation')
    expect(sent).deep.equals([])
  })
})

describe('asking to be a player’s guardian', function () {
  it('is offered to somebody signed in with no say over the player', async function () {
    for (const [props, shown] of [
      [{ viewer: stranger, roles: roles({}) }, true],
      [{ viewer: stranger, roles: roles({ t1: ['scorekeeper'] }) }, true],
      [{ viewer: stranger, roles: roles({}), forTeam: 't1' }, true],
      // Signed out, or the roles not known yet.
      [{ viewer: undefined, roles: roles({}) }, false],
      [{ viewer: stranger, roles: undefined }, false],
      // The player themselves, and their guardian.
      [
        {
          viewer: { userId: userIdOfGumbo(7), isAdmin: false },
          roles: roles({})
        },
        false
      ],
      [{ viewer: stranger, roles: roles({}, [7]) }, false],
      // Their guardian from an address made before a merge, which names a
      // row since closed into 7.
      [
        { viewer: stranger, roles: roles({}, [7]), userId: userIdOfGumbo(3) },
        false
      ],
      // Their coaches, beside the team or from Home, and a site admin.
      [
        { viewer: stranger, roles: roles({ t1: ['coach'] }), forTeam: 't1' },
        false
      ],
      [{ viewer: stranger, roles: roles({ t1: ['assistant'] }) }, false],
      [
        {
          viewer: { userId: userIdOfGumbo(100), isAdmin: true },
          roles: roles({})
        },
        false
      ]
    ] as const) {
      await render(
        <PlayerScreen
          client={guardianClient([])}
          userId={userIdOfGumbo(7)}
          {...props}
        />
      )
      expect(requestButton() != null, JSON.stringify(props)).equals(shown)
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('is offered to a coach of a team the player has left, with no Settings', async function () {
    await render(
      <PlayerScreen
        client={guardianClient([], undefined, [hawks, owlsLeft])}
        userId={userIdOfGumbo(7)}
        viewer={stranger}
        roles={roles({ tem_other: ['coach'] })}
      />
    )
    expect(requestButton()?.textContent).equals('Request to be a guardian')
    expect(tabNames()).deep.equals(['Videos', 'Stats', 'Teams'])
  })

  it('asks in a sheet, sends the request for the viewer, and then says it is sent', async function () {
    const sent: Sent = []
    await render(
      <PlayerScreen
        client={guardianClient(sent)}
        userId={userIdOfGumbo(7)}
        viewer={stranger}
        roles={roles({})}
      />
    )
    await press('Request to be a guardian')
    expect(text()).includes('Ask to be Jordan P’s guardian?')
    expect(text()).includes(
      'Jordan P or a guardian of theirs decides, or a coach of one of their teams if they have no guardian.'
    )
    // Closing the sheet sends nothing.
    await press('Cancel')
    expect(sent).deep.equals([])
    expect(text()).not.includes('Ask to be Jordan P’s guardian?')
    await press('Request to be a guardian')
    await press('Send request')
    expect(sent).has.length(1)
    expect(sent[0]).deep.include({
      kind: 'guardian',
      playerUserId: userIdOfGumbo(7),
      guardian: { userId: userIdOfGumbo(100) }
    })
    expect(sent[0]).not.has.property('sender')
    expect(sent[0].idempotencyKey).a('string')
    const button = requestButton()
    expect(button?.textContent).equals('Guardian request sent')
    expect(button?.getAttribute('aria-disabled')).equals('true')
  })

  it('shows the server’s refusal, and retries under the same key', async function () {
    const sent: Sent = []
    const refusals = [
      'You have 5 guardian requests waiting. Wait for an answer before asking again.',
      'Three guardian requests were declined. You can ask again on October 13, 2026.'
    ]
    await render(
      <PlayerScreen
        client={guardianClient(sent, async () => {
          const message = refusals.shift()
          if (message != null) throw new HttpError('rateLimited', message)
          return { id: 'req_1', status: 'pending' }
        })}
        userId={userIdOfGumbo(7)}
        viewer={stranger}
        roles={roles({})}
      />
    )
    await press('Request to be a guardian')
    await press('Send request')
    expect(text()).includes(
      'You have 5 guardian requests waiting. Wait for an answer before asking again.'
    )
    expect(requestButton()?.textContent).equals('Request to be a guardian')
    await press('Request to be a guardian')
    await press('Send request')
    expect(text()).includes('You can ask again on October 13, 2026.')
    expect(text()).not.includes('You have 5 guardian requests waiting')
    await press('Request to be a guardian')
    await press('Send request')
    expect(requestButton()?.textContent).equals('Guardian request sent')
    expect(text()).not.includes('You can ask again')
    expect(new Set(sent.map(body => body.idempotencyKey)).size).equals(1)
  })

  it('is offered through the app to the signed-in viewer', async function () {
    fixtureFetch({})
    await open('/players/usr_1111111111111111111118')
    expect(requestButton()?.textContent).equals('Request to be a guardian')
  })
})

describe('a player’s Team roles on Settings', function () {
  function rolesClient(
    canHoldRoles: boolean,
    asked: unknown[],
    admin = false,
    given: Role[] = ['scorekeeper'],
    member = true
  ): TeamStationClient {
    let held: Role[] = given
    return Object.assign(playerClient(), {
      personProfile: async (kind: string, id: string, userId: string) => {
        asked.push(['profile', kind, id, userId])
        return asPersonProfile({
          context: { kind: 'team', id: 't1', name: 'Hawks' },
          person: {
            userId: userIdOfGumbo(7),
            gumboId: 7,
            shortName: 'Jordan P',
            fullName: 'Jordan Pacheco',
            avatarUrl: null,
            canHoldRoles
          },
          guardianOf: [],
          sections: [
            {
              level: 'team',
              groups: [{ id: 't1', name: 'Hawks' }],
              roles: held,
              member,
              follower: false,
              editable: true
            },
            {
              level: 'season',
              groups: [{ id: 's1', name: 'Spring 2026' }],
              roles: [],
              member: false,
              follower: false,
              editable: false
            }
          ],
          viewer: { manages: true, admin }
        })
      },
      addRole: async (kind: string, id: string, userId: string, role: Role) => {
        asked.push(['add', kind, id, userId, role])
        held = [...held, role]
        return { userId, roles: held, member: true }
      }
    })
  }

  it('lists the team’s roles at the very bottom for a coach, with toggles, team level only', async function () {
    const asked: unknown[] = []
    await render(
      <PlayerScreen
        client={rolesClient(true, asked)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={coach}
      />
    )
    expect(asked[0]).deep.equals(['profile', 'team', 't1', userIdOfGumbo(7)])
    const section = document.querySelector('[data-testid="playerTeamRoles"]')
    expect(section).not.equals(null)
    // Last on the tab, after the player's own settings.
    expect(text().lastIndexOf('TEAM ROLES')).greaterThan(
      text().indexOf('Jersey')
    )
    expect(text()).not.includes('SEASON ROLES')
    // A coach changes everything but Admin.
    expect(
      section!.querySelector('[data-testid="role-team-admin"] [role="switch"]')
    ).equals(null)
    expect(
      section!
        .querySelector('[data-testid="role-team-scorekeeper"] [role="switch"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    // Songkeeper can be assigned explicitly even while Scorekeeper is held.
    const songkeeper = section!.querySelector(
      '[data-testid="role-team-songkeeper"]'
    )
    expect(
      songkeeper?.querySelector('[role="switch"]')?.getAttribute('aria-checked')
    ).equals('false')
    // Their place on the team is the roster's: Member reads Player.
    const member = section!.querySelector('[data-testid="role-team-member"]')
    expect(member?.querySelector('[role="switch"]')).equals(null)
    expect(member?.textContent).equals('MemberPlayer')
    await press('Assistant')
    expect(asked).deep.include([
      'add',
      'team',
      't1',
      userIdOfGumbo(7),
      'assistant'
    ])
    expect(
      section!
        .querySelector('[data-testid="role-team-assistant"] [role="switch"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
  })

  it('keeps player membership fixed while allowing explicit staff roles beside Admin', async function () {
    const asked: unknown[] = []
    await render(
      <PlayerScreen
        client={rolesClient(true, asked, true, ['admin'])}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={roles({ t1: ['admin'] })}
      />
    )
    const section = document.querySelector('[data-testid="playerTeamRoles"]')
    expect(
      section!
        .querySelector('[data-testid="role-team-admin"] [role="switch"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    for (const role of [
      'coach',
      'assistant',
      'scorekeeper',
      'songkeeper',
      'videographer'
    ]) {
      const row = section!.querySelector(`[data-testid="role-team-${role}"]`)
      expect(
        row?.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
        role
      ).equals('false')
    }
    await press('Coach')
    expect(asked).deep.include(['add', 'team', 't1', userIdOfGumbo(7), 'coach'])
    expect(
      section!
        .querySelector('[data-testid="role-team-coach"] [role="switch"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    expect(
      section!
        .querySelector('[data-testid="role-team-admin"] [role="switch"]')
        ?.getAttribute('aria-checked')
    ).equals('true')
    const member = section!.querySelector('[data-testid="role-team-member"]')
    expect(member?.querySelector('[role="switch"]')).equals(null)
    expect(member?.textContent).includes('Player')
  })

  it('reads the usual Member row for somebody not on the team now', async function () {
    await render(
      <PlayerScreen
        client={rolesClient(true, [], false, [], false)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={coach}
      />
    )
    const member = document.querySelector(
      '[data-testid="playerTeamRoles"] [data-testid="role-team-member"]'
    )
    expect(member?.textContent).not.includes('Player')
    expect(
      member?.querySelector('[role="switch"]')?.getAttribute('aria-checked')
    ).equals('false')
  })

  it('shows no roles for a player who cannot sign in, nor to anybody but the team’s staff', async function () {
    const asked: unknown[] = []
    await render(
      <PlayerScreen
        client={rolesClient(false, asked)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={coach}
      />
    )
    expect(asked).length(1)
    expect(document.querySelector('[data-testid="playerTeamRoles"]')).equals(
      null
    )
    await act(async () => {
      root?.unmount()
    })
    // A guardian sees the child's Settings, and not their roles.
    const guardian: unknown[] = []
    await render(
      <PlayerScreen
        client={rolesClient(true, guardian)}
        userId={userIdOfGumbo(7)}
        forTeam="t1"
        initialTab="settings"
        roles={roles({}, [7])}
      />
    )
    expect(selectedTab()).equals('Settings')
    expect(guardian).deep.equals([])
    expect(text()).not.includes('TEAM ROLES')
  })
})
