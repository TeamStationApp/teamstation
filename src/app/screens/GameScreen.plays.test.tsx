import { expect } from 'chai'
import { afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  type GameDetail,
  TeamStationClient
} from '../../common/api'
import type { GameSocketEvent } from '../../common/gameSocket'
import type { StoredGame } from '../../common/scoring/session'
import { finalGame, inProgressGame } from '../../test/replayGameFixture'
import { NoticesProvider, ScreenNotices } from '../../test/screenNotices'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

const notices = new ScreenNotices()

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

function fixture(fields: Partial<GameDetail> = {}): {
  client: TeamStationClient
  game: GameDetail
  reads: string[]
} {
  const game = {
    ...asGameDetail({
      id: 'g1',
      nonMemberView: false,
      homeTeamId: 'home',
      awayTeamId: 'away',
      homeTeamName: 'Valley Pines',
      awayTeamName: 'Harbor Hawks',
      seasonId: null,
      startAt: '2027-04-10T18:00:00Z',
      endAt: '2027-04-10T20:00:00Z',
      venue: null,
      status: 'final',
      homeScore: 2,
      awayScore: 3,
      ingestStatus: 'none',
      ingestMessage: null,
      videos: [],
      canScore: false,
      assignedRoles: { away: [], home: [] },
      hasScoringEvents: true
    }),
    ...fields
  }
  const reads: string[] = []
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({ ...game })
  client.teams = async () => []
  client.roster = async () => []
  client.boxScore = async () => ({
    batting: [],
    pitching: [],
    stats: undefined
  })
  client.gameEvents = async gameId => {
    reads.push(gameId)
    return stored
  }
  return { client, game, reads }
}

let stored: StoredGame

async function render(
  props: Omit<React.ComponentProps<typeof GameScreen>, 'signedIn'> & {
    signedIn?: boolean | null
  }
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <NoticesProvider notices={notices}>
          <GestureHandlerRootView>
            <GameScreen signedIn {...props} />
          </GestureHandlerRootView>
        </NoticesProvider>
      </ThemeProvider>
    )
  })
  await settle()
}

async function settle(milliseconds = 50): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
  })
}

const selected = (): string | null =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ??
  null

const pills = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')].map(
    tab => tab.textContent ?? ''
  )

async function choose(label: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
      .click()
  })
  await settle()
}

const shown = (testId: string): boolean =>
  document.querySelector(`[data-testid="${testId}"]`) != null

const MEMBERS_ONLY =
  "You need to be a member of one of these teams to see this game's Plays."

describe('the Plays tab', function () {
  this.timeout(20000)
  before(async () => {
    stored = await finalGame()
  })

  it('shows the stream from its pill, read once', async () => {
    const { client, reads } = fixture()
    const tabs: string[] = []
    await render({
      client,
      gameId: 'g1',
      onTab: tab => {
        tabs.push(tab)
      }
    })
    expect(pills()).deep.equals(['Box score', 'Videos', 'Plays', 'Info'])
    expect(selected()).equals('Box score')
    expect(reads).deep.equals([])
    await choose('Plays')
    expect(selected()).equals('Plays')
    expect(shown('plays-stream')).equals(true)
    expect(document.body.textContent).includes('Top 1st')
    expect(reads).deep.equals(['g1'])
    expect(tabs).deep.equals(['plays'])
    await choose('Info')
    await choose('Plays')
    expect(shown('plays-stream')).equals(true)
  })

  it('opens on Plays from the address', async () => {
    const { client, reads } = fixture()
    const tabs: string[] = []
    await render({
      client,
      gameId: 'g1',
      initialTab: 'plays',
      onTab: tab => {
        tabs.push(tab)
      }
    })
    expect(selected()).equals('Plays')
    expect(shown('plays-stream')).equals(true)
    expect(reads).deep.equals(['g1'])
    expect(tabs).deep.equals([])
  })

  it('shows the at-bat in progress of a game being scored', async () => {
    const live = await inProgressGame()
    const before = stored
    stored = live
    try {
      const { client } = fixture({ status: 'inProgress', homeScore: 0 })
      await render({ client, gameId: 'g1', initialTab: 'plays' })
      expect(
        document.querySelector(
          `[data-testid="plays-line-${live.currentPlay!.about.atBatIndex}"]`
        )
      ).not.equals(null)
      expect(document.body.textContent).includes('batting, ')
    } finally {
      stored = before
    }
  })

  it('asks a non-member to become a member, never reads the plays, and ignores the socket on Plays', async () => {
    const { client, reads } = fixture({ nonMemberView: true })
    let listener: ((event: GameSocketEvent) => void) | undefined
    await render({
      client,
      gameId: 'g1',
      socket: {
        subscribe: (_id, receive) => {
          listener = receive
          return () => undefined
        }
      }
    })
    expect(pills()).includes('Plays')
    await choose('Plays')
    expect(document.body.textContent).includes(MEMBERS_ONLY)
    expect(shown('plays-members-only')).equals(true)
    const before = document.querySelector(
      '[data-testid="eventTabContent"]'
    )!.textContent
    await act(async () => {
      listener?.({
        type: 'change',
        gameId: 'g1',
        kind: 'playEdits',
        at: new Date().toISOString(),
        data: {
          generation: 0,
          fromDigest: 'd0',
          digest: 'd1',
          namesDigest: 'n0',
          edits: [],
          currentPlay: stored.plays[0]
        }
      })
    })
    await settle()
    expect(shown('plays-stream')).equals(false)
    expect(
      document.querySelector('[data-testid="eventTabContent"]')!.textContent
    ).equals(before)
    expect(reads).deep.equals([])
  })

  it('asks a guest to sign in first, and never reads the plays', async () => {
    const { client, reads } = fixture({ nonMemberView: true })
    let signIns = 0
    await render({
      client,
      gameId: 'g1',
      signedIn: false,
      initialTab: 'plays',
      onSignIn: () => {
        signIns++
      }
    })
    expect(selected()).equals('Plays')
    expect(document.body.textContent).includes(MEMBERS_ONLY)
    expect(document.body.textContent).includes(
      'Log in or create an account first to request membership.'
    )
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(button => button.textContent === 'Log in / Sign up')!
        .click()
    })
    expect(signIns).equals(1)
    expect(reads).deep.equals([])
  })

  for (const [name, fields, fallback, label] of [
    [
      'a game nobody has pitched in',
      { status: 'scheduled', hasScoringEvents: false, homeScore: null },
      'info',
      'Info'
    ],
    [
      'a game stored wholly as imported plays',
      { status: 'final', hasScoringEvents: false },
      'boxScore',
      'Box score'
    ]
  ] as const)
    it(`falls back to the default tab for ?tab=plays on ${name}`, async () => {
      const { client, reads } = fixture({
        ...fields,
        startAt: '2099-04-10T18:00:00Z',
        endAt: '2099-04-10T20:00:00Z'
      })
      const tabs: string[] = []
      await render({
        client,
        gameId: 'g1',
        initialTab: 'plays',
        onTab: tab => {
          tabs.push(tab)
        }
      })
      expect(pills()).not.includes('Plays')
      expect(selected()).equals(label)
      expect(shown('plays-stream')).equals(false)
      expect(shown('plays-loading')).equals(false)
      expect(tabs).deep.equals([fallback])
      expect(reads).deep.equals([])
    })
})
