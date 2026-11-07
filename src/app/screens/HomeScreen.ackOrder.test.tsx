import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asTeamSummary,
  type TeamStationClient,
  type TeamSummary
} from '../../common/api'
import { ACK_GIVE_UP_MS, COALESCE_MS } from '../../common/screenScope'
import {
  FakeScopeSocket,
  heldTimers,
  testClock
} from '../../test/fakeScreenScope'
import { ScreenScopeProvider } from '../hooks/useScreenScope'
import { ThemeProvider } from '../theme/ThemeContext'
import { HomeScreen } from './HomeScreen'

const hawks: TeamSummary = asTeamSummary({
  id: 'tem_hawks',
  name: 'Alta Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null,
  kind: 'full',
  seasonCategory: 'inSeason'
})

const settle = async (ms = 10): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

/** What happened, in order, printed when `SCREEN_SCOPE_TRACE` is set. */
function trace(title: string, log: string[]): void {
  if (process.env.SCREEN_SCOPE_TRACE == null) return
  console.log(`      ${title}`)
  for (const line of log) console.log(`        ${line}`)
}

describe('S3: Home waits for the home scope before it reads', function () {
  let root: Root | undefined
  let timers: ReturnType<typeof heldTimers> | undefined
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
    document.body.replaceChildren()
  })

  /** Home's client, writing each REST call into `log`. */
  function homeClient(log: string[]): {
    client: TeamStationClient
    state: { offline: boolean }
  } {
    const state = { offline: false }
    const call =
      <T,>(name: string, answer: T) =>
      async (): Promise<T> => {
        log.push(`client.${name}`)
        await Promise.resolve()
        return answer
      }
    const client = Object.assign(state, {
      home: call('home', {
        teams: [{ ...hawks, direct: true, source: 'member' }],
        seasons: [],
        leagues: []
      }),
      recentGame: call('recentGame', null),
      liveNow: call('liveNow', []),
      cached: async () => undefined
    })
    return { client: client as unknown as TeamStationClient, state }
  }

  async function render(
    client: TeamStationClient,
    socket: FakeScopeSocket,
    clock?: ReturnType<typeof testClock>
  ): Promise<void> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScreenScopeProvider
            socket={socket}
            scope={{ scope: 'home' }}
            timers={clock}
          >
            <HomeScreen
              client={client}
              onOpenTeam={() => undefined}
              onOpenSeason={() => undefined}
              onOpenGame={() => undefined}
            />
          </ScreenScopeProvider>
        </ThemeProvider>
      )
    })
    await settle()
  }

  const homeCalls = (log: string[]): number =>
    log.filter(line => line === 'client.home').length

  it('asks for the teams only after subscribed, and again for a changed, at most every 3 s', async function () {
    const clock = testClock(0)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client } = homeClient(log)
    await render(client, socket, clock)
    expect(socket.asked()).deep.equals(['home'])
    // Rendered, and still waiting: inside the three seconds, nothing is read.
    expect(homeCalls(log), 'client.home before subscribed').equals(0)
    expect(log).deep.equals(['subscribe home'])
    expect(document.body.textContent).includes('Loading…')
    expect(clock.pending(), 'each load waits for the ack').deep.equals([
      ACK_GIVE_UP_MS,
      ACK_GIVE_UP_MS,
      ACK_GIVE_UP_MS
    ])

    await act(async () => {
      socket.ack()
    })
    await settle()
    expect(log.indexOf('subscribed')).lessThan(log.indexOf('client.home'))
    expect(homeCalls(log), 'client.home after subscribed').equals(1)
    expect(log).includes('client.recentGame').and.includes('client.liveNow')
    expect(document.body.textContent).includes('Alta Hawks')
    expect(clock.pending(), 'the give-up timers are cleared').deep.equals([])

    // A notice a second after that read waits for its 3 s.
    clock.advance(1000)
    await act(async () => {
      socket.changed()
    })
    await settle()
    expect(homeCalls(log)).equals(1)
    await act(async () => {
      clock.advance(COALESCE_MS - 1000)
    })
    await settle()
    expect(homeCalls(log), 'client.home 3 s after the read').equals(2)
    // One after the next 3 s reads at once.
    clock.advance(COALESCE_MS)
    await act(async () => {
      socket.changed()
    })
    await settle()
    expect(homeCalls(log), 'client.home at once').equals(3)
    trace('online: subscribe, ack, read, changed, read', log)
  })

  it('lets a notice of one game alone pass its lists, and reads the recent game and what is live again', async function () {
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client } = homeClient(log)
    const clock = testClock(0)
    await render(client, socket, clock)
    await act(async () => {
      socket.ack()
    })
    await settle()
    const count = (name: string): number =>
      log.filter(line => line === `client.${name}`).length
    expect([count('home'), count('recentGame'), count('liveNow')]).deep.equals([
      1, 1, 1
    ])
    // A play: the game's score moved, and no team or season did.
    clock.advance(COALESCE_MS)
    await act(async () => {
      socket.changed('g1')
    })
    await settle()
    expect(count('home'), 'the lists let it pass').equals(1)
    expect(count('recentGame'), 'the recent game reads it').equals(2)
    expect(count('liveNow'), 'what is live reads it').equals(2)
    // A notice of a list still reads the lists.
    clock.advance(COALESCE_MS)
    await act(async () => {
      socket.changed()
    })
    await settle()
    expect(count('home')).equals(2)
  })

  it('reads its teams again when a game goes final, and shows the record it moved', async function () {
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client } = homeClient(log)
    let record: TeamSummary['record'] = null
    Object.assign(client, {
      home: async () => {
        log.push('client.home')
        await Promise.resolve()
        return {
          teams: [{ ...hawks, record, direct: true, source: 'member' }],
          seasons: [],
          leagues: []
        }
      }
    })
    const clock = testClock(0)
    await render(client, socket, clock)
    await act(async () => {
      socket.ack()
    })
    await settle()
    expect(homeCalls(log)).equals(1)
    expect(document.body.textContent).not.include('1–0')
    // Going final, the server tells the game, and its teams and season: the
    // lists pass the first and read on the second.
    record = { w: 1, l: 0, t: 0, seasonName: null }
    clock.advance(COALESCE_MS)
    await act(async () => {
      socket.changed('g1')
      socket.changed()
    })
    await settle()
    expect(homeCalls(log), 'the lists are read again').equals(2)
    expect(document.body.textContent).include('1–0')
  })

  it('paints what the phone stored before the ack, and the read replaces it (Cache first paint)', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client } = homeClient(log)
    const stored: Record<string, unknown> = {
      'home.lists': {
        teams: [
          { ...hawks, name: 'Stored Hawks', direct: true, source: 'member' }
        ],
        seasons: [],
        leagues: []
      },
      'home.recent': []
    }
    let loaded = 0
    Object.assign(client, {
      cached: async (key: string, cleaner: (raw: unknown) => unknown) => {
        log.push(`cached ${key}`)
        return stored[key] == null ? undefined : cleaner(stored[key])
      }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScreenScopeProvider socket={socket} scope={{ scope: 'home' }}>
            <HomeScreen
              client={client}
              onOpenTeam={() => undefined}
              onOpenSeason={() => undefined}
              onOpenGame={() => undefined}
              onLoaded={() => {
                loaded++
              }}
            />
          </ScreenScopeProvider>
        </ThemeProvider>
      )
    })
    await settle()
    expect(homeCalls(log), 'client.home before subscribed').equals(0)
    expect(log).includes('cached home.lists')
    expect(document.body.textContent).includes('Stored Hawks')
    expect(document.body.textContent).not.includes('Loading…')
    expect(loaded).equals(0)

    await act(async () => {
      socket.ack()
    })
    await settle()
    expect(homeCalls(log)).equals(1)
    expect(document.body.textContent).includes('Alta Hawks')
    expect(document.body.textContent).not.includes('Stored Hawks')
    expect(loaded, 'the phone reads ahead after the load').equals(1)
  })

  it('stays loading on the web, which stores nothing, until the read', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client } = homeClient(log)
    Object.assign(client, { cached: async () => undefined })
    await render(client, socket)
    expect(document.body.textContent).includes('Loading…')
    await act(async () => {
      socket.ack()
    })
    await settle()
    expect(document.body.textContent).includes('Alta Hawks')
  })

  it('reads and paints at once while offline, without waiting for an ack', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client, state } = homeClient(log)
    state.offline = true
    await render(client, socket)
    expect(homeCalls(log), 'client.home with no ack').equals(1)
    expect(log).not.includes('subscribed')
    expect(document.body.textContent).includes('Alta Hawks')
    expect(document.body.textContent).not.includes('Loading…')
    expect(timers.pending(), 'nothing waits').equals(0)
    trace('offline: read with no ack', log)
  })
})
