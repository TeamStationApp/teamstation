import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameSummary,
  asHighlightsResponse,
  asRosterEntry,
  asVideoSummary,
  TeamStationClient
} from '../../common/api'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { GameScreen } from './GameScreen'
import { TeamScreen } from './TeamScreen'

/**
 * Somebody signed in who is not a member of a team, following it or not: the
 * members' page, less what the server keeps for members. Every name and no
 * photo; how the team is doing and not how each player is; the schedule with
 * its thumbnails and public video library; and on a game, the pictures of the
 * highlights without playback, nor a player box with nothing in it.
 */
let root: Root | undefined

const VIDEOS_MEMBERS_ONLY =
  "You need to be a member of one of the teams to watch this game's videos."

/** `#1A2116` as the browser reports it: `rgb(26, 33, 22)`. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`
}

/** Whether a notice is in the page's own text colour, not a hint's grey. */
function readable(node: Element | null): void {
  expect(node).not.equals(null)
  expect(getComputedStyle(node!).color).equals(rgb(tsBallpark.primaryTextColor))
}

/** Whether the player's box, which is black, is on the page. */
function playerBox(): boolean {
  return [...document.querySelectorAll<HTMLElement>('div')].some(
    node => getComputedStyle(node).backgroundColor === 'rgb(0, 0, 0)'
  )
}

function noPlayerBox(): void {
  expect(document.querySelector('video')).equals(null)
  expect(playerBox()).equals(false)
}

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>{element}</GestureHandlerRootView>
      </ThemeProvider>
    )
    await delay(10)
  })
}

async function press(label: string): Promise<void> {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].find(
    node =>
      (node.getAttribute('aria-label') ?? '').startsWith(label) ||
      (node.textContent ?? '').startsWith(label)
  )
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(10)
  })
}

const POSTER = 'https://example.com/stills/poster-150.jpg'

const game = asGameSummary({
  id: 'g1',
  homeTeamId: 'tem_hawks',
  awayTeamId: 'tem_visitors',
  homeTeamName: 'Demo Hawks',
  awayTeamName: 'Demo Visitors',
  seasonId: 'sea_1',
  startAt: '2026-05-02T18:30:00.000Z',
  venue: null,
  status: 'final',
  homeScore: 5,
  awayScore: 3,
  ingestStatus: 'ok',
  videoCount: 1,
  posterUrl: POSTER
})

const roster = [
  asRosterEntry({
    userId: 104,
    gumboId: 104,
    shortName: 'Ichiro',
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'staff',
    staffRoles: ['coach'],
    inheritedFrom: null,
    avatarUrl: null
  }),
  asRosterEntry({
    userId: 201,
    gumboId: 201,
    shortName: 'Alfonso S',
    jersey: '7',
    positions: ['SS', '2B'],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    avatarUrl: null
  }),
  // A family member as a non-member is answered: no `guardianOf`.
  asRosterEntry({
    userId: 106,
    gumboId: 106,
    shortName: 'Tim R',
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'family',
    staffRoles: [],
    inheritedFrom: null,
    avatarUrl: null
  })
]

/**
 * What a non-member's client is answered, and what it was asked. `follows`
 * says whether they follow the team, which changes the Follow button only.
 */
function nonMemberClient(follows = true): {
  client: TeamStationClient
  asked: string[]
} {
  const asked: string[] = []
  const refused = (name: string) => async () => {
    asked.push(name)
    throw new Error(`${name} is kept for members`)
  }
  const client = {
    teamGames: async () => [game],
    roster: async () => roster,
    teamStats: refused('teamStats'),
    teamPitchingStats: refused('teamPitchingStats'),
    standings: async () => [
      {
        teamId: 'tem_hawks',
        teamName: 'Demo Hawks',
        w: 2,
        l: 0,
        t: 0,
        runsFor: 9,
        runsAgainst: 4,
        played: 2,
        winningPct: 1,
        runDifferential: 5
      }
    ],
    follows: async () => (follows ? [{ kind: 'team', id: 'tem_hawks' }] : [])
  } as unknown as TeamStationClient
  return { client, asked }
}

describe('a non-member’s team page', function () {
  async function team(
    initialTab: string,
    follows = true
  ): Promise<{
    asked: string[]
    opened: Array<{ gameId: string; options: unknown }>
    players: number[]
  }> {
    const { client, asked } = nonMemberClient(follows)
    const opened: Array<{ gameId: string; options: unknown }> = []
    const players: number[] = []
    await render(
      <TeamScreen
        client={client}
        signedIn
        team={{
          id: 'tem_hawks',
          name: 'Demo Hawks',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: null,
          seasonCategory: 'unscheduled',
          canViewPrivate: false,
          kind: 'full'
        }}
        nonMemberView
        initialTab={initialTab}
        onOpenGame={(gameId, _title, options) => {
          opened.push({ gameId, options })
        }}
        onOpenPlayer={userId => {
          players.push(userId)
        }}
      />
    )
    return { asked, opened, players }
  }

  it('lists every name with initials and no photo, and opens nobody', async function () {
    const { players } = await team('team')
    for (const name of ['Ichiro', 'Alfonso S', 'Coach', 'SS · 2B', '#7'])
      expect(text()).includes(name)
    // A family member by name, without whom they are a guardian of.
    expect(text()).includes('Tim R')
    expect(text()).not.includes('Parent/guardian of')
    expect(text()).includes('AS')
    expect(document.querySelector('img')).equals(null)
    expect(text()).not.includes('chevron_right')
    expect(players).deep.equals([])
    // A follower can stop following from the card.
    expect(
      document.querySelector('[aria-label="Unfollow Demo Hawks"]')
    ).not.equals(null)
  })

  it('is the same page for somebody who does not follow the team, bar the Follow button', async function () {
    const { players } = await team('team', false)
    for (const name of ['Ichiro', 'Alfonso S', 'Coach', 'SS · 2B', '#7'])
      expect(text()).includes(name)
    expect(document.querySelector('img')).equals(null)
    expect(players).deep.equals([])
    expect(
      document.querySelector('[aria-label="Follow Demo Hawks"]')
    ).not.equals(null)
  })

  it('shows the season’s performance and keeps the batting and pitching for members, unasked', async function () {
    const { asked } = await team('stats')
    expect(text()).includes('SEASON PERFORMANCE')
    expect(text()).includes('2–0')
    expect(text()).includes(
      'You need to be a member of this team to see individual player stats.'
    )
    expect(text()).includes('Request membership')
    expect(document.querySelector('[data-testid="warningSheet"]')).equals(null)
    readable(document.querySelector('[role="alert"]'))
    expect(text()).not.includes('BATTING')
    expect(text()).not.includes('PITCHING')
    expect(asked).deep.equals([])
  })

  it('shows the public video library without starting playback', async function () {
    const { opened } = await team('videos')
    expect(document.querySelector('[role="alert"]')).equals(null)
    expect(text()).includes('GAME VIDEO LIBRARY')
    expect(document.body.innerHTML).includes(POSTER)
    expect(opened).deep.equals([])
    noPlayerBox()
  })

  it('marks recorded schedule rows and opens a game without playing it', async function () {
    const { opened } = await team('schedule')
    expect(document.querySelector('svg[aria-label="Video"]')).not.equals(null)
    expect(document.body.innerHTML).not.includes(POSTER)
    const row = document.querySelector<HTMLElement>(
      '[data-testid="schedule-display-row"][role="button"]'
    )
    expect(row).not.equals(null)
    await act(async () => {
      row!.click()
    })
    expect(opened).deep.equals([{ gameId: 'g1', options: { autoPlay: false } }])
  })
})

describe('the team card’s right-hand column', function () {
  /** The card for one kind of viewer, and what its end column holds. */
  async function card(viewer: 'admin' | 'non-member' | 'member'): Promise<{
    end: HTMLElement
    parts: string[]
  }> {
    const { client } = nonMemberClient()
    Object.assign(client, {
      teamStats: async () => [],
      teamPitchingStats: async () => [],
      invites: async () => ({ canInvite: true, invites: [] })
    })
    await render(
      <TeamScreen
        client={client}
        team={{
          id: 'tem_hawks',
          name: 'Demo Hawks',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: null,
          seasonCategory: 'unscheduled',
          canViewPrivate: viewer !== 'non-member',
          kind: 'full'
        }}
        nonMemberView={viewer === 'non-member'}
        onManage={viewer === 'admin' ? () => undefined : undefined}
        initialTab="team"
        onOpenGame={() => undefined}
      />
    )
    const end = document.querySelector<HTMLElement>(
      '[data-testid="team-card-end"]'
    )
    expect(end, viewer).not.equals(null)
    const parts = [...end!.children].map(child =>
      child.getAttribute('data-testid') === 'team-card-gear'
        ? child.querySelector('[aria-label="Manage"]') != null
          ? 'gear'
          : 'empty gear'
        : (child.textContent ?? '')
    )
    const hero = end!.parentElement!
    const placeLabels = [...hero.querySelectorAll('*')].filter(
      node => node.children.length === 0 && node.textContent === '1st Place'
    )
    expect(
      placeLabels,
      `${viewer} has exactly one place badge across the hero`
    ).length(1)
    return { end: end!, parts }
  }

  it('keeps the administrator gear in its top-right column beside the place', async function () {
    const { end, parts } = await card('admin')
    expect(parts).deep.equals(['gear'])
    const style = getComputedStyle(end)
    expect(style.alignSelf).equals('stretch')
    expect(style.justifyContent).equals('space-between')
    // Laid out in the column, not floated over the card.
    const gear = end.querySelector<HTMLElement>(
      '[data-testid="team-card-gear"]'
    )!
    expect(getComputedStyle(gear).position).not.equals('absolute')
    expect(getComputedStyle(gear).alignSelf).equals('flex-start')
    // The team's name keeps the rest of the row.
    const name = [...document.querySelectorAll<HTMLElement>('div')].find(
      node => node.textContent === 'Demo Hawks'
    )!
    expect(getComputedStyle(name.parentElement!).flexGrow).equals('1')
  })

  it('stacks the place over Follow for a non-member, and the place alone for a member', async function () {
    expect((await card('non-member')).parts).deep.equals([
      '1st Place',
      'Following'
    ])
    await act(async () => {
      root?.unmount()
    })
    document.body.replaceChildren()
    expect((await card('member')).parts).deep.equals(['1st Place'])
  })
})

describe('a non-member’s game page', function () {
  const video = asVideoSummary({
    id: 'v1',
    title: 'Game — Home plate',
    numCameras: 1,
    kind: 'primary',
    status: 'ready',
    storage: 'local',
    startAt: '2026-05-02T18:30:00Z',
    durationSec: 300,
    width: 1920,
    height: 1080,
    codecs: null,
    posterUrl: 'https://example.com/poster.jpg'
  })
  const STILL = 'https://example.com/stills/20.jpg'

  async function page(
    signedIn = true,
    onSignIn = () => undefined
  ): Promise<{
    asked: string[]
    moments: Array<[string, number]>
  }> {
    const asked: string[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      nonMemberView: true,
      canScore: false,
      status: 'final',
      awayScore: 3,
      homeScore: 5,
      awayRecord: '0–2',
      homeRecord: '2–0',
      linescore: {
        away: {
          runs: [1, 2],
          r: 3,
          h: null,
          e: null,
          bb: null,
          k: null,
          hr: null,
          hbp: null
        },
        home: {
          runs: [4, 1],
          r: 5,
          h: null,
          e: null,
          bb: null,
          k: null,
          hr: null,
          hbp: null
        }
      },
      // Two angles, so the strip under the picture is drawn.
      videos: [video, { ...video, id: 'v2', title: 'Game — Outfield' }]
    })
    client.teams = async () => []
    client.gameScheduling = async () => {
      throw new Error('not a scheduler')
    }
    client.highlights = async () =>
      asHighlightsResponse({
        withheld: null,
        droppedCount: 0,
        highlights: [
          {
            eventId: 'e1',
            atBatIndex: 1,
            title: 'Alfonso S doubles',
            startOffsetSec: 20,
            playOffsetSec: 23,
            eventType: 'double',
            isScoringPlay: true,
            stillUrl: STILL,
            description: 'Alfonso S doubles to left.'
          }
        ]
      })
    client.playback = async () => {
      asked.push('playback')
      throw new Error('kept for members')
    }
    client.boxScore = async () => {
      asked.push('boxScore')
      throw new Error('kept for members')
    }
    const moments: Array<[string, number]> = []
    await render(
      <GameScreen
        client={client}
        gameId="g1"
        autoPlay
        signedIn={signedIn}
        onSignIn={onSignIn}
        onMoment={(id, sec) => {
          moments.push([id, sec])
        }}
      />
    )
    await act(async () => {
      await delay(10)
    })
    return { asked, moments }
  }

  for (const signedIn of [false, true])
    it(`shows posters and blocks main and highlight playback for ${signedIn ? 'nonmembers' : 'guests'}`, async function () {
      let logins = 0
      const { asked, moments } = await page(signedIn, () => {
        logins += 1
      })
      for (const words of ['Owls', 'Hawks', '0–2', '2–0', '3', '5'])
        expect(text()).includes(words)
      expect(document.querySelector('video')).equals(null)
      expect(document.body.innerHTML).includes('https://example.com/poster.jpg')
      expect(document.body.innerHTML).includes(STILL)
      expect(document.querySelector('[data-testid="warningSheet"]')).equals(
        null
      )
      expect(text()).not.includes('All angles')
      await press('Play game video')
      expect(text()).includes(VIDEOS_MEMBERS_ONLY)
      const sheet = document.querySelector('[data-testid="warningSheet"]')!
      expect(getComputedStyle(sheet).backgroundColor).equals(
        'rgb(255, 213, 79)'
      )
      expect(text()).includes(
        signedIn ? 'Request membership' : 'Log in / Sign up'
      )
      await press('Close warning')
      await press('Play highlight:')
      expect(document.querySelector('[data-testid="warningSheet"]')).not.equals(
        null
      )
      expect(text()).not.includes('Alfonso S doubles to left.')
      if (!signedIn) {
        expect(text()).includes(
          'Log in or create an account first to request membership.'
        )
        await press('Log in / Sign up')
        expect(logins).equals(1)
      } else await press('Close warning')
      await act(async () => {
        await delay(350)
      })
      expect(moments).deep.equals([])
      expect(asked).deep.equals([])
    })

  it('switches angles without asking for the video', async function () {
    const { asked } = await page()
    await press('Outfield')
    expect(document.querySelector('video')).equals(null)
    expect(
      document.querySelector('[data-testid="gameVideoPreview"]')
    ).not.equals(null)
    expect(asked).deep.equals([])
  })
})

describe('a member’s game Videos tab', function () {
  async function page(
    videos: Array<ReturnType<typeof asVideoSummary>>
  ): Promise<string[]> {
    const asked: string[] = []
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      status: 'final',
      awayScore: 3,
      homeScore: 5,
      videos
    })
    client.highlights = async () =>
      asHighlightsResponse({ withheld: null, droppedCount: 0, highlights: [] })
    client.teams = async () => []
    client.gameScheduling = async () => {
      throw new Error('not a scheduler')
    }
    client.playback = async () => {
      asked.push('playback')
      // Still on its way: the box shows its spinner meanwhile.
      return await new Promise(() => undefined)
    }
    await render(<GameScreen client={client} gameId="g1" autoPlay />)
    await act(async () => {
      await delay(10)
    })
    return asked
  }

  it('keeps the player box for a game with a video', async function () {
    const asked = await page([
      asVideoSummary({
        id: 'v1',
        title: 'Game — Home plate',
        numCameras: 1,
        kind: 'primary',
        status: 'ready',
        storage: 'local',
        startAt: '2026-05-02T18:30:00Z',
        durationSec: 300,
        width: 1920,
        height: 1080,
        codecs: null
      })
    ])
    expect(playerBox()).equals(true)
    expect(document.querySelector('[data-testid="gameVideoNotice"]')).equals(
      null
    )
    expect(asked).deep.equals(['playback'])
  })

  it('says there are no videos, readably, with no player box, for a game without one', async function () {
    const asked = await page([])
    noPlayerBox()
    const notice = document.querySelector('[data-testid="gameVideoNotice"]')
    expect(notice?.textContent).equals('No videos.')
    readable(notice!.querySelector('[role="alert"]'))
    expect(text()).not.includes(VIDEOS_MEMBERS_ONLY)
    // Nothing recorded, so no highlights to list, nor a heading over none.
    expect(text()).not.includes('Highlights')
    expect(asked).deep.equals([])
  })
})
