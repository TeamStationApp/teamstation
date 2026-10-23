import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'

import {
  asSeasonGame,
  type SeasonGame,
  type TeamStationClient
} from '../../common/api'
import { ACK_GIVE_UP_MS } from '../../common/screenScope'
import {
  FakeScopeSocket,
  heldTimers,
  revisionStamps
} from '../../test/fakeScreenScope'
import { type FrameClock, installFrameClock } from '../../test/frameClock'
import { PAGE_MS } from '../components/TabPages'
import { ScreenScopeProvider } from '../hooks/useScreenScope'
import { ThemeProvider } from '../theme/ThemeContext'
import { shortDate, shortDateNoWeekday } from './format'
import { GamesFeedScreen } from './GamesFeedScreen'
import type { When } from './whenFilter'

let root: Root | undefined
let host: HTMLElement | undefined
let applyWhen: ((when: When) => Promise<void>) | undefined

const START = '2026-10-04T23:45:00.000Z'

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function game(id: string, patch: Partial<SeasonGame> = {}): SeasonGame {
  return asSeasonGame({
    id,
    homeTeamId: 'tem_sox',
    awayTeamId: 'tem_badgers',
    homeTeamName: 'Sox',
    awayTeamName: 'Badgers',
    homeTeamExternal: false,
    awayTeamExternal: false,
    seasonId: 'sea_spring',
    startAt: START,
    venue: 'Field 2',
    status: 'final',
    homeScore: 0,
    awayScore: 4,
    ingestStatus: 'done',
    videoCount: 1,
    durationSec: 5400,
    posterUrl: null,
    homeLogoUrl: null,
    awayLogoUrl: null,
    isLive: false,
    externalIds: [],
    ...patch
  })
}

interface Opened {
  gameId: string
  title: string
  options?: { autoPlay?: boolean }
}

async function mount(
  mode: 'videos' | 'schedule',
  games: SeasonGame[],
  initialWhen?: When,
  onWhen?: (when: When) => void,
  load?: TeamStationClient['games']
): Promise<Opened[]> {
  const opened: Opened[] = []
  const client = {
    games: load ?? (async () => games)
  } as unknown as TeamStationClient
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const draw = async (when: When | undefined): Promise<void> => {
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <GamesFeedScreen
            client={client}
            mode={mode}
            initialWhen={when}
            onWhenChange={onWhen}
            onOpenGame={(gameId, title, options) => {
              opened.push({ gameId, title, options })
            }}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
  }
  applyWhen = async (when: When) => {
    await draw(when)
  }
  await draw(initialWhen)
  return opened
}

/** What the page on show says: a pill's kept pages are in the DOM, hidden. */
function text(): string {
  const kept = [
    ...(host?.querySelectorAll('[data-page-role="kept"]') ?? [])
  ].map(node => node.textContent ?? '')
  return kept.reduce(
    (shown, hidden) => shown.replace(hidden, ''),
    host?.textContent ?? ''
  )
}

/** Whether the page on show spins, waiting for its games. */
function spinning(): boolean {
  return [
    ...(host?.querySelectorAll('[aria-label="Loading games"]') ?? [])
  ].some(node => node.closest('[data-page-role="kept"]') == null)
}

/** Frames turned by hand, in a test that lets the pill pages slide. */
let clock: FrameClock | undefined

/** Past the length of a pill page's slide, so the arriving page has landed. */
async function land(): Promise<void> {
  await act(async () => {
    clock?.advance(PAGE_MS + 32)
    await delay(20)
  })
}

function control(label: string): HTMLElement {
  const found = [
    ...(host?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])
  ].filter(node => (node.getAttribute('aria-label') ?? '').startsWith(label))
  expect(found, label).has.lengthOf(1)
  return found[0]
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

async function setWidth(width: number): Promise<void> {
  await act(async () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => width
    })
    window.dispatchEvent(new window.Event('resize'))
    await delay(10)
  })
}

describe('the games feed', function () {
  for (const failure of [new Error('Schedule unavailable'), 'offline'])
    it(`shows a useful schedule load error (${typeof failure})`, async () => {
      await mount('schedule', [], 'all', undefined, async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an untyped transport rejection.
        throw failure
      })
      expect(text()).includes(
        failure instanceof Error ? failure.message : 'Cannot load'
      )
      expect(host?.querySelector('[data-testid="schedule-date"]')).equals(null)
    })
  it('shows a pending schedule status instead of the score and opens its authorized request', async function () {
    const opened = await mount(
      'schedule',
      [
        game('gam_pending', {
          pendingApproval: true,
          pendingRequestId: 'req_private',
          videoCount: 0
        })
      ],
      'all'
    )
    expect(text()).includes('Pending approval')
    expect(text()).not.includes('4–0')
    await press(control('Badgers @ Sox'))
    expect(opened).deep.equals([
      {
        gameId: 'gam_pending',
        title: 'Badgers @ Sox',
        options: { pendingRequestId: 'req_private' }
      }
    ])
  })
  it('leaves pending schedule rows informational when request access is absent', async function () {
    const opened = await mount(
      'schedule',
      [
        game('gam_reserved', {
          pendingApproval: true,
          pendingRequestId: null,
          videoCount: 0,
          awayScore: null,
          homeScore: null,
          status: 'scheduled'
        })
      ],
      'all'
    )
    expect(text()).includes('Pending approval')
    expect(host!.querySelector('[role="button"]')).equals(null)
    expect(opened).deep.equals([])
  })
  it('preserves published video access while its scheduling revision is pending', async function () {
    const opened = await mount('videos', [
      game('gam_published', { pendingApproval: true, pendingRequestId: null })
    ])
    expect(text()).includes('Pending approval')
    expect(text()).not.includes('4–0')
    await press(control('Badgers @ Sox'))
    expect(opened[0]).deep.equals({
      gameId: 'gam_published',
      title: 'Badgers @ Sox',
      options: { tab: 'watch', autoPlay: true }
    })
  })
  it('forwards cancellation history to the shared schedule row', async function () {
    await mount(
      'schedule',
      [
        game('gam_cancelled', {
          status: 'cancelled',
          cancellationReason: 'withdrawal',
          withdrawnByTeamName: 'Sox'
        })
      ],
      'all'
    )
    expect(text()).includes('Canceled')
    expect(text()).includes('Sox withdrew')
    expect(text()).not.includes('4–0')
  })
  it('keeps canceled recorded games labeled in the video library', async function () {
    const opened = await mount('videos', [
      game('gam_cancelled', { status: 'cancelled' })
    ])
    expect(text()).includes('Canceled')
    expect(text()).not.includes('4–0')
    await press(control('Badgers @ Sox'))
    expect(opened[0].gameId).equals('gam_cancelled')
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
      delete (document.documentElement as unknown as Record<string, unknown>)
        .clientWidth
      window.dispatchEvent(new window.Event('resize'))
    })
    root = undefined
    host?.remove()
    host = undefined
    applyWhen = undefined
  })

  it('opens a schedule row, with and without a recording', async function () {
    const opened = await mount(
      'schedule',
      [
        game('gam_final'),
        game('gam_now', {
          awayTeamName: 'Comets',
          homeTeamName: 'Hawks',
          status: 'inProgress',
          isGameLive: true,
          awayScore: 2,
          homeScore: 1,
          videoCount: 0
        })
      ],
      'all'
    )
    expect(host?.querySelector('img')).equals(null)
    expect(text()).includes('4–0')
    expect(text()).includes('LIVE')
    expect(text()).not.includes('2–1')
    await press(control('Badgers @ Sox'))
    await press(control('Comets @ Hawks'))
    expect(opened).deep.equals([
      {
        gameId: 'gam_final',
        title: 'Badgers @ Sox',
        options: { autoPlay: false }
      },
      {
        gameId: 'gam_now',
        title: 'Comets @ Hawks',
        options: { autoPlay: false }
      }
    ])
  })

  it('opens a video row for a live game, a score, and a game with no date', async function () {
    const opened = await mount(
      'videos',
      [
        game('gam_live', {
          isLive: true,
          durationSec: 90,
          awayTeamName: 'Comets',
          homeTeamName: 'Hawks'
        }),
        game('gam_plain', {
          awayTeamName: 'Rivals',
          homeTeamName: 'Oaks',
          awayScore: 3,
          homeScore: 2,
          durationSec: null
        }),
        game('gam_open', {
          awayTeamName: 'Aces',
          homeTeamName: 'Bats',
          awayScore: null,
          homeScore: null,
          startAt: null,
          durationSec: null
        })
      ],
      'all'
    )
    expect(text()).includes('live')
    expect(text()).includes('3–2')
    expect(text()).includes('1:30')
    expect(text()).includes('Date to be confirmed')
    expect(text()).includes(shortDateNoWeekday(START))
    await press(control('Comets @ Hawks'))
    await press(control('Rivals @ Oaks'))
    expect(opened.map(item => item.gameId)).deep.equals([
      'gam_live',
      'gam_plain'
    ])
    expect(opened[0].options).deep.equals({ tab: 'watch', autoPlay: true })
    await setWidth(1440)
    expect(text()).includes(shortDate(START))
  })

  it('opens the schedule on Upcoming, then Past, then All', async function () {
    const chosen: When[] = []
    await mount('schedule', [game('gam_final')], undefined, when => {
      chosen.push(when)
    })
    const lists = [...(host?.querySelectorAll('[role="tablist"]') ?? [])]
    expect(lists.length).greaterThan(0)
    for (const list of lists) {
      const labels = [...list.querySelectorAll('[role="tab"]')].map(node =>
        node.getAttribute('aria-label')
      )
      expect(labels).deep.equals(['Upcoming', 'Past', 'All'])
    }
    const selected = [
      ...(host?.querySelectorAll('[aria-selected="true"]') ?? [])
    ].map(node => node.getAttribute('aria-label'))
    expect(selected.length).greaterThan(0)
    expect(selected.every(label => label === 'Upcoming')).equals(true)
    const past = host?.querySelector<HTMLElement>('[aria-label="Past"]')
    expect(past).not.equals(null)
    if (past != null) await press(past)
    expect(chosen).deep.equals(['past'])
  })

  it('draws each pill from its own games, never the last pill’s', async function () {
    // The pages slide here, which the test page's reduced motion would stop.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored after.
    const query = AccessibilityInfo.isReduceMotionEnabled
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    clock = installFrameClock()
    try {
      let answer!: (games: SeasonGame[]) => void
      const asked: Array<string | undefined> = []
      const past = game('gam_past', { venue: 'Past field' })
      const later = game('gam_later', { venue: 'All field' })
      await mount('schedule', [], 'past', undefined, async options => {
        asked.push(options?.when)
        if (options?.when === 'past') return [past]
        return await new Promise(resolve => {
          answer = resolve
        })
      })
      const frame = (key: string): HTMLElement | null =>
        host?.querySelector<HTMLElement>(`[data-page="schedule-${key}"]`) ??
        null
      const page = (key: string): string => frame(key)?.textContent ?? ''
      const spins = (key: string): boolean =>
        frame(key)?.querySelector(
          '[aria-label="Loading games"], [aria-label="Loading"]'
        ) != null
      const pill = (label: string): HTMLElement =>
        host!.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
      expect(page('past')).includes('Past field')
      const pastPage = frame('past')
      await press(pill('All'))
      // All's read has not answered: its page slides in spinning, rather than
      // showing Past's games as All's and swapping them under the slide.
      expect(asked.at(-1)).equals(undefined)
      expect(frame('all')?.dataset.pageRole).equals('incoming')
      expect(spins('all')).equals(true)
      expect(page('all')).not.includes('Past field')
      // Its games in mid-slide wait for it to land: drawn now, they would hold
      // the slide up. The page is not drawn at all until then.
      await act(async () => {
        answer([past, later])
        await delay(20)
      })
      expect(spins('all')).equals(true)
      await land()
      expect(page('all')).includes('All field')
      expect(spins('all')).equals(false)
      // Past's page stayed built, hidden, and comes back as it was.
      expect(frame('past')).equals(pastPage)
      expect(frame('past')?.dataset.pageRole).equals('kept')
      const allCards = frame('all')?.querySelector('[data-testid]') ?? null
      const reads = asked.length
      await press(pill('Past'))
      expect(frame('past')).equals(pastPage)
      expect(page('past')).includes('Past field')
      expect(page('past')).not.includes('All field')
      expect(spins('past')).equals(false)
      await land()
      // Read moments ago, Past's list is not read again for a change of pill.
      expect(asked.length).equals(reads)
      // And All's, drawn once, is not drawn again.
      await press(pill('All'))
      expect(spins('all')).equals(false)
      expect(page('all')).includes('All field')
      expect(allCards).not.equals(null)
      expect(frame('all')?.querySelector('[data-testid]')).equals(allCards)
    } finally {
      clock.restore()
      clock = undefined
      AccessibilityInfo.isReduceMotionEnabled = query
    }
  })

  it('reads a pill whose read failed again when it is chosen again', async function () {
    const asked: Array<string | undefined> = []
    let fail = true
    await mount('schedule', [], 'upcoming', undefined, async options => {
      asked.push(options?.when)
      if (options?.when === 'upcoming' && fail) throw new Error('Offline')
      return [
        game('gam_next', {
          venue: 'Next field',
          awayScore: null,
          homeScore: null,
          status: 'scheduled',
          startAt: '2027-01-02T20:00:00.000Z',
          videoCount: 0
        })
      ]
    })
    const pill = (label: string): HTMLElement =>
      host!.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
    expect(text()).includes('Offline')
    fail = false
    await press(pill('Past'))
    await press(pill('Upcoming'))
    // Within the half minute, but with no list to show: read at once.
    expect(asked.filter(when => when === 'upcoming')).has.lengthOf(2)
    expect(text()).includes('Next field')
  })

  it('leaves the last pill’s failure behind when the address changes the pill', async function () {
    let failing = false
    await mount('schedule', [], 'upcoming', undefined, async options => {
      if (options?.when === 'past' && failing) throw new Error('Past failed')
      return [
        game('gam_next', {
          venue: 'Next field',
          awayScore: null,
          homeScore: null,
          status: 'scheduled',
          startAt: '2027-01-02T20:00:00.000Z',
          videoCount: 0
        })
      ]
    })
    failing = true
    await applyWhen!('past')
    expect(text()).includes('Past failed')
    // Browser Back to Upcoming, read moments ago: no read clears it.
    await applyWhen!('upcoming')
    expect(text()).not.includes('Past failed')
    expect(text()).includes('Next field')
  })

  it('lands no failure from the last pill’s read on a pill chosen again within the half minute', async function () {
    const held: Array<() => void> = []
    await mount('schedule', [], 'upcoming', undefined, async options => {
      if (options?.when === 'past') {
        // Past's read is slow, and fails.
        await new Promise<void>(resolve => {
          held.push(resolve)
        })
        throw new Error('Past failed')
      }
      return [
        game('gam_next', {
          venue: 'Next field',
          awayScore: null,
          homeScore: null,
          status: 'scheduled',
          startAt: '2027-01-02T20:00:00.000Z',
          videoCount: 0
        })
      ]
    })
    const pill = (label: string): HTMLElement =>
      host!.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
    expect(text()).includes('Next field')
    await press(pill('Past'))
    // Upcoming again, read moments ago: not read again.
    await press(pill('Upcoming'))
    await act(async () => {
      held[0]()
      await delay(50)
    })
    expect(text()).not.includes('Past failed')
    expect(text()).includes('Next field')
  })

  it('counts a pill’s read as fresh only once the server has answered it', async function () {
    const asked: Array<string | undefined> = []
    const held: Array<() => void> = []
    await mount('schedule', [], 'upcoming', undefined, async options => {
      asked.push(options?.when)
      if (options?.when === 'past' && held.length === 0)
        // Past's first read is slow.
        await new Promise<void>(resolve => {
          held.push(resolve)
        })
      return []
    })
    const pill = (label: string): HTMLElement =>
      host!.querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
    await press(pill('Past'))
    await press(pill('All'))
    // Back to Past before its read has answered: nothing has confirmed what
    // it shows, so it asks again rather than counting the read in flight.
    await press(pill('Past'))
    await act(async () => {
      held[0]()
      await delay(50)
    })
    expect(asked.filter(when => when === 'past')).has.lengthOf(2)
  })

  it('follows a schedule address that changes without remounting', async function () {
    await mount(
      'schedule',
      [
        game('gam_next', {
          awayTeamName: 'Aces',
          homeTeamName: 'Bats',
          awayScore: null,
          homeScore: null,
          status: 'scheduled',
          startAt: '2026-12-01T20:00:00.000Z',
          videoCount: 0
        }),
        game('gam_done')
      ],
      'upcoming'
    )
    expect(text()).includes('Aces')
    expect(text()).not.includes('Sox')
    const upcoming = [
      ...(host?.querySelectorAll('[aria-selected="true"]') ?? [])
    ].map(node => node.getAttribute('aria-label'))
    expect(upcoming.every(label => label === 'Upcoming')).equals(true)

    await applyWhen?.('past')
    await land()
    expect(text()).includes('Sox')
    expect(text()).not.includes('Aces')
    const past = [
      ...(host?.querySelectorAll('[aria-selected="true"]') ?? [])
    ].map(node => node.getAttribute('aria-label'))
    expect(past.length).greaterThan(0)
    expect(past.every(label => label === 'Past')).equals(true)
  })

  it('does not offer a when filter on the videos list', async function () {
    await mount('videos', [game('gam_final')])
    expect(host?.querySelector('[aria-label="Upcoming"]')).equals(null)
    expect(text()).includes('GAME VIDEOS')
  })
})

describe('the games feed’s screen scope', function () {
  let timers: ReturnType<typeof heldTimers> | undefined
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    host = undefined
    timers?.restore()
    timers = undefined
  })

  /** As the shell draws it: Schedule holds its scope, Videos holds none. */
  async function mountScoped(
    mode: 'videos' | 'schedule',
    socket: FakeScopeSocket,
    asked: Array<{ when?: string }>,
    offline = false
  ): Promise<void> {
    const stamps = revisionStamps()
    stamps.offline = offline
    const client = Object.assign(stamps, {
      games: async (query: { when?: string }) => {
        asked.push(query)
        socket.log.push('client.games')
        return [game('gam_final', { startAt: START })]
      }
    }) as unknown as TeamStationClient
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <ScreenScopeProvider
            socket={socket}
            scope={mode === 'schedule' ? { scope: 'schedule' } : undefined}
          >
            <GamesFeedScreen
              client={client}
              mode={mode}
              onOpenGame={() => undefined}
            />
          </ScreenScopeProvider>
        </ThemeProvider>
      )
      await delay(20)
    })
  }

  it('paints the stored schedule before subscribed (Cache first paint)', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const socket = new FakeScopeSocket()
    const asked: Array<{ when?: string }> = []
    const keys: string[] = []
    const stamps = revisionStamps()
    const client = Object.assign(stamps, {
      games: async (query: { when?: string }) => {
        asked.push(query)
        return [game('gam_final', { startAt: START })]
      },
      cached: async (key: string, cleaner: (raw: unknown) => unknown) => {
        keys.push(key)
        return cleaner([game('gam_stored', { startAt: START })])
      }
    }) as unknown as TeamStationClient
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <ScreenScopeProvider socket={socket} scope={{ scope: 'schedule' }}>
            <GamesFeedScreen
              client={client}
              mode="schedule"
              onOpenGame={() => undefined}
            />
          </ScreenScopeProvider>
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(asked).deep.equals([])
    expect(keys).deep.equals(['games.upcoming'])
    expect(spinning()).equals(false)
  })

  it('does not let the foreground refresh’s first call read the schedule before subscribed', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const socket = new FakeScopeSocket()
    const asked: Array<{ when?: string }> = []
    await mountScoped('schedule', socket, asked)
    expect(asked, 'client.games before subscribed').deep.equals([])
    expect(spinning()).equals(true)
    await act(async () => {
      socket.ack('2')
      await delay(20)
    })
    expect(socket.log).deep.equals([
      'subscribe schedule',
      'subscribed 2',
      'client.games'
    ])
    expect(asked).deep.equals([{ when: 'upcoming' }])
    expect(spinning()).equals(false)
  })

  it('reads the schedule at once while offline', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const socket = new FakeScopeSocket()
    const asked: Array<{ when?: string }> = []
    await mountScoped('schedule', socket, asked, true)
    expect(asked).deep.equals([{ when: 'upcoming' }])
    expect(timers.pending()).equals(0)
  })

  it('reads the videos at once from the foreground refresh’s first call, holding no scope', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const socket = new FakeScopeSocket()
    const asked: Array<{ when?: string }> = []
    await mountScoped('videos', socket, asked)
    expect(asked, 'client.games with no ack').deep.equals([{}])
    expect(socket.asked()).deep.equals([])
    expect(timers.pending()).equals(0)
    expect(text()).includes('GAME VIDEOS')
  })
})
