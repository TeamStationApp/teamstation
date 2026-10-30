import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  asSessionUser,
  type Health,
  type SeasonSummary,
  TeamStationClient,
  type TeamSummary,
  type TessMessage,
  type TessScreen
} from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { fakeSockets } from '../test/fakeScoreboardSocket'
import { fill, mount, press, settle, unmount } from '../test/gameFormDom'
import { pageOf, pageOfGames } from '../test/pageOf'
import { manualClock, windowSize } from '../test/tessTestKit'
import { App, screenTitle } from './App'
import { ChatListNavigationCapture } from './chat/chatWorkspaceModel'
import { currentRoute, showRoute } from './navigation/useAddressBar'
import { gameFixture } from './scoring/isUnscoredGame.test'
import { TESS_HEALTH_RETRY_MS } from './tess/useTessAvailable'
import webMusic from './walkup/walkUpMusic'

/**
 * Settles until `done` holds, up to five seconds: a browser Back is a
 * `popstate` the page hears when the event loop gets to it, which a busy
 * machine can delay well past any fixed pause.
 */
async function settleUntil(done: () => boolean): Promise<void> {
  for (let waited = 0; waited < 5000 && !done(); waited += 50) await settle(50)
}

const RUTH = asSessionUser({
  id: userIdOfGumbo(101),
  displayName: 'Babe Ruth',
  isAdmin: false
})

const health = (tess?: boolean): Health => ({
  status: 'ok',
  version: '1',
  database: 'ok',
  migrations: 1,
  dictation: false,
  dictationModels: [],
  ...(tess == null ? {} : { tess })
})

/** Tess's last answer, carrying the links a test follows. */
const answer = (text: string): TessMessage => ({
  id: 'm2',
  role: 'assistant',
  text,
  attachments: [],
  changes: [],
  createdAt: '2027-04-03T12:00:00Z'
})

const LINKS = [
  '[Your account](/account)',
  '[DJ](/games/g1/dj)',
  '[Settings](/account "path")'
].join(' ')

const button = (label: string): HTMLElement | null =>
  document.querySelector(`[role="button"][aria-label="${label}"]`)
const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`)
const link = (text: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="link"]')
  ].find(node => node.textContent === text)
  if (found == null) throw new Error(`No link ${text}`)
  return found
}
const tap = async (node: HTMLElement): Promise<void> => {
  await act(async () => {
    node.click()
  })
  await settle(60)
}
/** The breakpoint the screen on show laid out at. */
const breakpoint = (): string | null =>
  document
    .querySelector('[data-breakpoint]')
    ?.getAttribute('data-breakpoint') ?? null

describe("Tess in the app's shell", () => {
  let originals: PropertyDescriptorMap
  let healthAnswers: Array<Health | Error>
  let signedIn: boolean
  let sent: Array<{ text: string; screen?: TessScreen }>
  let restoreWindow: (() => Promise<void>) | undefined
  const originalSocket = globalThis.WebSocket
  const dj = webMusic.djSupported

  beforeEach(() => {
    const api = TeamStationClient.prototype
    originals = Object.getOwnPropertyDescriptors(api)
    healthAnswers = [health(true)]
    signedIn = true
    sent = []
    globalThis.WebSocket = fakeSockets().Impl as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: window.location
    })
    api.health = async () => {
      const next =
        healthAnswers.length > 1 ? healthAnswers.shift()! : healthAnswers[0]
      if (next instanceof Error) throw next
      return next
    }
    api.whoAmI = async () => (signedIn ? RUTH : null)
    api.signOut = async () => {
      signedIn = false
    }
    api.myRoles = async () => ({ teams: {}, guardianOf: [] })
    api.umpireLeagues = async () => []
    api.hasNotifications = async () => false
    api.teams = async () => []
    api.seasons = async () => []
    api.ownGroups = async () => []
    api.follows = async () => []
    api.guardedPlayers = async () => []
    api.recentGame = async () => null
    api.liveNow = async () => []
    api.gamesPage = async () => pageOf([])
    api.roster = async () => []
    api.defaultLineup = async () => ({
      lineup: null,
      fromGameId: null,
      setAt: null
    })
    api.gameEvents = async () => ({ plays: [], currentPlay: null })
    api.serverTime = async () => Date.now()
    api.highlights = async () => ({
      withheld: null,
      droppedCount: 0,
      highlights: []
    })
    api.game = async () => ({
      ...gameFixture,
      videos: [],
      nonMemberView: false,
      canScore: true,
      scoreboard: { open: true, mayOverride: true }
    })
    api.gameScheduling = async () => {
      throw new Error('not a scheduler')
    }
    api.tess = async () => ({
      available: true,
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'Where is my account?',
          attachments: [],
          changes: [],
          createdAt: '2027-04-03T11:59:00Z'
        },
        answer(LINKS)
      ],
      contextTokens: 0
    })
    api.streamTessMessage = async (text, options) => {
      sent.push({ text, screen: options.screen })
      return [
        {
          id: `u${sent.length}`,
          role: 'user',
          text,
          attachments: [],
          changes: [],
          createdAt: '2027-04-03T12:01:00Z'
        }
      ]
    }
  })
  afterEach(async () => {
    await unmount()
    window.localStorage.removeItem('tess.columnWidth')
    await restoreWindow?.()
    restoreWindow = undefined
    webMusic.djSupported = dj
    Object.defineProperties(TeamStationClient.prototype, originals)
    globalThis.WebSocket = originalSocket
    delete (globalThis as { location?: unknown }).location
  })

  const open = async (
    width: number,
    route: Parameters<typeof showRoute>[0] = { name: 'home' }
  ): Promise<void> => {
    restoreWindow = (await windowSize(width, 900)).restore
    showRoute(route, true)
    await mount(<App initialToken="token-one" />)
    await settle(60)
  }
  const openTess = async (): Promise<void> => {
    await tap(button('Tess')!)
    await settle(60)
  }

  describe('availability', () => {
    it('shows no button while health fails, and the button once a retry says tess: true', async () => {
      healthAnswers = [new Error('offline'), health(true)]
      const clock = manualClock(TESS_HEALTH_RETRY_MS)
      try {
        await open(1280)
        expect(button('Tess'), 'not while health fails').equals(null)
        await clock.advance(TESS_HEALTH_RETRY_MS)
        await settle(30)
        expect(button('Tess'), 'after the retry').not.equals(null)
      } finally {
        clock.restore()
      }
    })

    it('shows no button when the server says tess: false, or says nothing', async () => {
      for (const answered of [health(false), health()]) {
        healthAnswers = [answered]
        await open(1280)
        expect(button('Tess'), JSON.stringify(answered)).equals(null)
        await unmount()
        await restoreWindow?.()
        restoreWindow = undefined
      }
    })

    it('takes the button and the chat away on sign-out', async () => {
      await open(1280, { name: 'account' })
      await openTess()
      expect(byTestId('Tess column')).not.equals(null)
      await press('Sign out')
      await settle(100)
      expect(button('Tess')).equals(null)
      expect(byTestId('Tess chat')).equals(null)
    })
  })

  describe('narrow, at 1024', () => {
    it('covers the app with the chat; a link closes it and goes there', async () => {
      await open(1024)
      expect(byTestId('Tess chat'), 'closed').equals(null)
      await openTess()
      expect(byTestId('Tess layer')).not.equals(null)
      expect(byTestId('Tess column')).equals(null)
      expect(byTestId('Tess chat')).not.equals(null)
      expect(byTestId('Tess divider'), 'no divider over the app').equals(null)
      await tap(link('Your account'))
      expect(byTestId('Tess chat'), 'closed by the link').equals(null)
      expect(currentRoute().name).equals('account')
      // Reopened, it is the same conversation, and a way bubble goes too.
      await openTess()
      await tap(
        document.querySelector<HTMLElement>(
          '[role="link"][aria-label="Go to Settings"]'
        )!
      )
      expect(byTestId('Tess chat')).equals(null)
      expect(currentRoute().name).equals('account')
    })

    it('hides the app beneath from screen readers, the keyboard and the pointer, and the floating destinations with it', async () => {
      await open(390)
      const pane = (): HTMLElement =>
        document.querySelector<HTMLElement>('[data-breakpoint]')!
      const covered = (): HTMLElement | null =>
        pane().closest<HTMLElement>('[aria-hidden="true"]')
      // The phone's floating destinations, outside the pane.
      const destinations = (): Element | null =>
        [...document.querySelectorAll('[role="tablist"]')].find(
          node => !pane().parentElement!.contains(node)
        ) ?? null
      expect(covered()).equals(null)
      expect(destinations(), 'the floating destinations').not.equals(null)
      await openTess()
      const layer = byTestId('Tess layer')!
      expect(layer.getAttribute('aria-modal')).equals('true')
      expect(covered(), 'the pane is hidden').not.equals(null)
      expect(covered()!.hasAttribute('inert')).equals(true)
      expect(covered()!.contains(layer)).equals(false)
      expect(destinations()).equals(null)
      // Nothing in the chat is hidden or inert.
      expect(layer.closest('[aria-hidden="true"], [inert]')).equals(null)

      await tap(button('Close Tess')!)
      expect(covered()).equals(null)
      expect(pane().closest('[inert]'), 'the pane takes focus again').equals(
        null
      )
      expect(destinations()).not.equals(null)
    })

    it('sends no screen with a message', async () => {
      await open(1024)
      await openTess()
      await fill('Ask Tess', 'Where are my team settings?')
      await press('Send')
      await settle(60)
      expect(sent).deep.equals([
        { text: 'Where are my team settings?', screen: undefined }
      ])
    })

    it("closes on the browser's Back, leaving the route and the history as they were", async () => {
      await open(1024)
      await press('Account, Babe Ruth')
      await settle(60)
      expect(currentRoute().name).equals('account')
      const index = window.history.state?.tsRouteIndex as number
      await openTess()
      await act(async () => {
        window.history.back()
      })
      await settleUntil(() => byTestId('Tess chat') == null)
      expect(byTestId('Tess chat'), 'Back closed the chat').equals(null)
      expect(currentRoute().name).equals('account')
      expect(window.history.state?.tsRouteIndex).equals(index)
      // Closed, Back is the page's again.
      await act(async () => {
        window.history.back()
      })
      await settleUntil(() => currentRoute().name === 'home')
      expect(currentRoute().name).equals('home')
    })
  })

  describe('leaving an open chat by a link', () => {
    /**
     * An open chat with a reader that keeps its position when asked: each
     * navigation waits on `kept` until the test releases it.
     */
    const withChatReader = async (
      run: (held: { asked: () => number; release: () => void }) => Promise<void>
    ): Promise<void> => {
      const capture = ChatListNavigationCapture.prototype
      const saved = Object.getOwnPropertyDescriptors(capture)
      let asked = 0
      let release = (): void => {}
      capture.hasReader = () => true
      capture.navigate = async (change: () => void): Promise<void> => {
        asked += 1
        await new Promise<void>(resolve => {
          release = resolve
        })
        change()
      }
      try {
        await run({
          asked: () => asked,
          release: () => {
            release()
          }
        })
      } finally {
        Object.defineProperties(capture, saved)
      }
    }

    it('keeps the chat’s place before a narrow link closes Tess and goes there', async () => {
      await withChatReader(async held => {
        await open(1024)
        await openTess()
        await tap(link('Your account'))
        expect(held.asked(), 'the chat was asked to keep its place').equals(1)
        expect(currentRoute().name, 'not before it has').equals('home')
        expect(byTestId('Tess chat'), 'still open meanwhile').not.equals(null)
        await act(async () => {
          held.release()
        })
        await settle(60)
        expect(currentRoute().name).equals('account')
        expect(byTestId('Tess chat'), 'closed by the link').equals(null)
      })
    })

    it('keeps the chat’s place before a wide link moves the pane', async () => {
      await withChatReader(async held => {
        await open(1025)
        await openTess()
        await tap(link('Your account'))
        expect(held.asked()).equals(1)
        expect(currentRoute().name).equals('home')
        await act(async () => {
          held.release()
        })
        await settle(60)
        expect(currentRoute().name).equals('account')
        expect(byTestId('Tess chat'), 'the column stays').not.equals(null)
      })
    })
  })

  describe('wide, at 1025 and up', () => {
    it('leaves the pane beside the column as it is on a wide window', async () => {
      await open(1280)
      await openTess()
      expect(byTestId('Tess column')!.getAttribute('aria-modal')).not.equals(
        'true'
      )
      expect(
        document
          .querySelector('[data-breakpoint]')!
          .closest('[aria-hidden="true"], [inert]')
      ).equals(null)
    })

    it('puts the chat in a column beside the pane, which lays out at its own width', async () => {
      await open(1280)
      expect(breakpoint(), 'closed: the whole window').equals('desktop')
      expect(byTestId('Tess column')).equals(null)
      await openTess()
      expect(byTestId('Tess column')).not.equals(null)
      expect(byTestId('Tess layer')).equals(null)
      expect(breakpoint(), 'open: the 880-point pane').equals('tablet')
      expect(button('Tess')?.getAttribute('aria-expanded')).equals('true')
      // The header's button closes it again, and the pane is the window.
      await tap(button('Tess')!)
      expect(byTestId('Tess column')).equals(null)
      expect(breakpoint()).equals('desktop')
    })

    it('resizes the column and the pane beside it from the divider, and keeps the width', async () => {
      await open(1280)
      await openTess()
      const column = (): HTMLElement => byTestId('Tess column')!
      const divider = (): HTMLElement => byTestId('Tess divider')!
      const drag = async (from: number, to: number): Promise<void> => {
        await act(async () => {
          divider().dispatchEvent(
            new window.MouseEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              clientX: from
            })
          )
          window.dispatchEvent(
            new window.MouseEvent('pointerup', { bubbles: true, clientX: to })
          )
        })
        await settle(60)
      }
      expect(column().style.width).equals('400px')
      expect(divider().getAttribute('aria-valuenow')).equals('400')
      expect(breakpoint(), 'an 880-point pane').equals('tablet')
      // As far as it goes: the pane keeps 560, a phone's width.
      await drag(400, 1100)
      expect(column().style.width).equals('720px')
      expect(breakpoint(), 'a 560-point pane').equals('phone')
      await act(async () => {
        divider().dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            bubbles: true,
            cancelable: true
          })
        )
      })
      await settle(60)
      expect(column().style.width).equals('704px')
      await drag(704, 100)
      expect(column().style.width).equals('320px')
      expect(breakpoint(), 'a 960-point pane').equals('tablet')
      expect(window.localStorage.getItem('tess.columnWidth')).equals('320')
      // Closed and opened again, the column is as wide as it was left.
      await tap(button('Tess')!)
      await openTess()
      expect(column().style.width).equals('320px')
    })

    it('navigates the pane from a link and keeps the chat open', async () => {
      await open(1025)
      await openTess()
      await tap(link('Your account'))
      expect(currentRoute().name).equals('account')
      expect(byTestId('Tess column')).not.equals(null)
      expect(byTestId('Tess chat')).not.equals(null)
    })

    it('closes a chart open over the pane when a link goes somewhere', async () => {
      TeamStationClient.prototype.tess = async () => ({
        available: true,
        messages: [
          { ...answer(LINKS), id: 'm1' },
          { ...answer('<svg viewBox="0 0 10 10"><rect width="4" /></svg>') }
        ],
        contextTokens: 0
      })
      await open(1280)
      await openTess()
      await tap(button('Open full screen')!)
      const overlay = byTestId('Tess overlay')!
      expect(
        overlay.querySelector('[data-testid="Tess rich viewer"]')
      ).not.equals(null)
      await tap(link('Your account'))
      expect(currentRoute().name).equals('account')
      expect(byTestId('Tess overlay'), 'the viewer gave way').equals(null)
      expect(byTestId('Tess rich viewer')).equals(null)
      expect(byTestId('Tess chat')).not.equals(null)
      // The chart opens again from its card, and a way bubble closes it too.
      await tap(button('Open full screen')!)
      expect(byTestId('Tess overlay')).not.equals(null)
      await tap(
        document.querySelector<HTMLElement>(
          '[role="link"][aria-label="Go to Settings"]'
        )!
      )
      expect(byTestId('Tess overlay')).equals(null)
    })

    it("sends the pane's screen and the steps that led there", async () => {
      await open(1280, { name: 'account' })
      await openTess()
      await fill('Ask Tess', 'What is on this page?')
      await press('Send')
      await settle(60)
      expect(sent).deep.equals([
        {
          text: 'What is on this page?',
          screen: {
            path: '/account',
            title: 'Account',
            stack: [{ path: '/', title: 'Your Home' }]
          }
        }
      ])
      await act(async () => {
        window.history.back()
      })
      await settle(100)
      expect(currentRoute().name).equals('home')
      await fill('Ask Tess', 'And here?')
      await press('Send')
      await settle(60)
      expect(sent[1].screen).deep.equals({
        path: '/',
        title: 'Your Home',
        stack: []
      })
    })

    it('names a team reached by its address by the name its page loads', async () => {
      const api = TeamStationClient.prototype
      api.group = async () =>
        asGroupDetail({
          nonMemberView: false,
          group: {
            kind: 'team',
            id: 't1',
            name: 'Demo Hawks',
            imageUrl: null,
            locality: null
          },
          parents: [],
          children: [],
          participatingSeasons: [],
          competingTeams: [],
          games: [],
          staff: [],
          canViewPrivate: false,
          canManage: false
        })
      api.gameProposals = async () => []
      api.teamGamesPage = async (_id, query) => pageOfGames([], query)
      api.teamStats = async () => []
      api.teamPitchingStats = async () => []
      await open(1280, { name: 'team', teamId: 't1', tab: 'schedule' })
      await openTess()
      await fill('Ask Tess', 'What is on this page?')
      await press('Send')
      await settle(60)
      expect(sent[0].screen).deep.equals({
        path: '/teams/t1?tab=schedule',
        title: 'Demo Hawks',
        stack: [{ path: '/', title: 'Your Home' }]
      })
    })

    it('follows the window across 1024 with the conversation kept', async () => {
      await open(1280)
      await openTess()
      await windowSize(1024, 900)
      await settle(60)
      expect(byTestId('Tess layer'), 'full screen at 1024').not.equals(null)
      expect(byTestId('Tess column')).equals(null)
      await windowSize(1280, 900)
      await settle(60)
      expect(byTestId('Tess column'), 'the split again').not.equals(null)
      expect(link('Your account')).not.equals(null)
      await windowSize(1024, 900)
      await settle(60)
      await tap(button('Close Tess')!)
      expect(byTestId('Tess chat')).equals(null)
      expect(byTestId('Tess layer')).equals(null)
    })

    it('keeps the chat itself across 1024: a reply on its way, the draft and its files', async () => {
      const api = TeamStationClient.prototype
      const load = api.tess.bind(api)
      let loads = 0
      api.tess = async () => {
        loads += 1
        return await load()
      }
      let reply: (messages: TessMessage[]) => void = () => undefined
      api.streamTessMessage = async text => {
        sent.push({ text })
        return await new Promise<TessMessage[]>(resolve => {
          reply = resolve
        })
      }
      api.uploadTessAttachment = async file => ({
        id: '00000000-0000-4000-8000-000000000001',
        name: file.name,
        kind: 'csv'
      })
      await open(1280)
      await openTess()
      const chat = byTestId('Tess chat')
      await fill('Ask Tess', 'Where is the schedule?')
      await press('Send')
      await settle(60)
      expect(byTestId('Tess thinking'), 'a reply on its way').not.equals(null)
      // The next message, written while Tess answers: a file and a draft.
      await tap(button('Attach a file')!)
      await act(async () => {
        const drop = new window.Event('drop', {
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(drop, 'dataTransfer', {
          value: {
            files: [
              new window.File(['a,b\n'], 'runs.csv', { type: 'text/csv' })
            ]
          }
        })
        byTestId('Tess drop zone')!.dispatchEvent(drop)
      })
      await settle(60)
      await fill('Ask Tess', 'And chart these')
      const field = (): HTMLTextAreaElement =>
        document.querySelector('[aria-label="Ask Tess"]')!
      const chips = (): string[] =>
        [...document.querySelectorAll('[data-testid="Tess attachment"]')].map(
          chip => chip.textContent ?? ''
        )
      expect(chips()).deep.equals(['attach_fileruns.csvclose'])

      for (const [width, shown] of [
        [1024, 'Tess layer'],
        [1280, 'Tess column'],
        [800, 'Tess layer']
      ] as const) {
        await windowSize(width, 900)
        await settle(60)
        expect(byTestId(shown), `${width}`).not.equals(null)
        expect(byTestId('Tess chat'), `the same chat at ${width}`).equals(chat)
        expect(byTestId('Tess thinking'), `${width}`).not.equals(null)
        expect(field().value, `${width}`).equals('And chart these')
        expect(chips(), `${width}`).deep.equals(['attach_fileruns.csvclose'])
      }
      expect(loads, 'the conversation was read once').equals(1)
      await act(async () => {
        reply([
          {
            id: 'u1',
            role: 'user',
            text: 'Where is the schedule?',
            attachments: [],
            changes: [],
            createdAt: '2027-04-03T12:01:00Z'
          },
          answer('[Schedule](/teams/t1?tab=schedule)')
        ])
      })
      await settle(60)
      expect(byTestId('Tess thinking')).equals(null)
      expect(link('Schedule')).not.equals(null)
      expect(field().value).equals('And chart these')
    })
  })

  it('names each screen for Tess by its title, or by what it shows', () => {
    // Only the names are read.
    const seasonName = { id: 's1', name: 'Demo Regular' }
    const teamName = { id: 't1', name: 'Demo Hawks' }
    const season = seasonName as unknown as SeasonSummary
    const team = teamName as unknown as TeamSummary
    const unnamed = { id: 't1', name: '' } as unknown as TeamSummary
    expect([
      screenTitle('home', undefined),
      screenTitle('videos', undefined),
      screenTitle('schedule', undefined),
      screenTitle('search', undefined),
      screenTitle('home', { name: 'account' }),
      screenTitle('home', { name: 'team', team }),
      screenTitle('home', { name: 'season', season }),
      screenTitle('home', {
        name: 'game',
        gameId: 'g1',
        title: 'Hawks at Eagles'
      }),
      screenTitle('home', {
        name: 'player',
        userId: 'u1',
        title: 'Mike Trout'
      }),
      screenTitle('home', { name: 'gameReplay', gameId: 'g1' }),
      // A team reached by its address: its loaded name, else the route's.
      screenTitle(
        'home',
        { name: 'team', team: unnamed },
        new Map([['t1', 'Demo Hawks']])
      ),
      screenTitle('home', { name: 'team', team: unnamed }),
      screenTitle('home', { name: 'game', gameId: 'g1', title: '' }),
      screenTitle('home', {
        name: 'person',
        kind: 'team',
        id: 't1',
        userId: 'u1',
        title: 'x'.repeat(300)
      }).length
    ]).deep.equals([
      'Your Home',
      'Videos',
      'Schedule',
      'Search',
      'Account',
      'Demo Hawks',
      'Demo Regular',
      'Hawks at Eagles',
      'Mike Trout',
      'gameReplay',
      'Demo Hawks',
      'team',
      'game',
      200
    ])
  })

  describe('screens that take the whole window', () => {
    it('hides the column and the button while scoring, and brings them back on leaving', async () => {
      await open(1280, { name: 'game', gameId: 'g1' })
      await openTess()
      expect(byTestId('Tess column')).not.equals(null)
      await press('Score')
      await press('Full game scoring')
      await settle(100)
      expect(currentRoute().name).equals('scoreGame')
      expect(byTestId('Tess column'), 'scoring has the window').equals(null)
      expect(button('Tess')).equals(null)
      expect(breakpoint()).not.equals('tablet')
      await act(async () => {
        window.history.back()
      })
      await settleUntil(() => currentRoute().name === 'scoreOptions')
      expect(currentRoute().name).equals('scoreOptions')
      expect(byTestId('Tess column'), 'back on leaving').not.equals(null)
      expect(button('Tess')).not.equals(null)
    })

    it('draws no full-screen chat over scoring at 1024, and leaves its Back to scoring', async () => {
      await open(1280, { name: 'game', gameId: 'g1' })
      await openTess()
      await press('Score')
      await press('Full game scoring')
      await settle(100)
      await windowSize(1024, 900)
      await settle(60)
      expect(currentRoute().name).equals('scoreGame')
      expect(byTestId('Tess chat'), 'none over scoring').equals(null)
      expect(byTestId('Tess layer')).equals(null)
      // Scoring's own guard still answers Back: it saves and returns to the
      // scoring choices, rather than Tess's closing a chat nobody can see.
      await act(async () => {
        window.history.back()
      })
      await settle(200)
      expect(currentRoute().name).equals('scoreOptions')
      expect(byTestId('Tess layer'), 'the chat was kept open').not.equals(null)
    })

    it('hides them on the scoreboard override, which keeps its header', async () => {
      await open(1280, { name: 'game', gameId: 'g1' })
      await openTess()
      await press('Score')
      await press('Scoreboard')
      await settle(100)
      expect(currentRoute().name).equals('scoreboardOverride')
      expect(byTestId('Tess column')).equals(null)
      expect(button('Tess')).equals(null)
      expect(button('Notifications'), 'the header is there').not.equals(null)
    })

    it('hides them on DJ Game where the phone can DJ', async () => {
      webMusic.djSupported = true
      await open(1280)
      await openTess()
      await tap(link('DJ'))
      expect(currentRoute().name).equals('djGame')
      expect(byTestId('Tess column')).equals(null)
      expect(button('Tess')).equals(null)
    })

    it("keeps them on DJ Game's address where it shows the game", async () => {
      await open(1280)
      await openTess()
      await tap(link('DJ'))
      expect(currentRoute().name).equals('djGame')
      expect(byTestId('Tess column')).not.equals(null)
      expect(button('Tess')).not.equals(null)
    })
  })
})
