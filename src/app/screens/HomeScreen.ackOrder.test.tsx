import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asTeamSummary,
  type TeamStationClient,
  type TeamSummary
} from '../../common/api'
import { ACK_GIVE_UP_MS } from '../../common/screenScope'
import {
  FakeScopeSocket,
  heldTimers,
  revisionStamps
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

  /**
   * Home's client, writing each REST call into `log` and stamping it with
   * the revision the test sets for its path, as `x-teamstation-revision`
   * would.
   */
  function homeClient(log: string[]): {
    client: TeamStationClient
    stamps: ReturnType<typeof revisionStamps>
  } {
    const stamps = revisionStamps()
    const call =
      <T,>(name: string, path: string, answer: T) =>
      async (): Promise<T> => {
        log.push(`client.${name}`)
        await Promise.resolve()
        stamps.answer(path)
        return answer
      }
    const client = Object.assign(stamps, {
      teams: call('teams', '/teams', [hawks]),
      seasons: call('seasons', '/seasons', []),
      recentGame: call('recentGame', '/events?played=1&limit=1', null),
      liveNow: call('liveNow', '/live/now', [])
    })
    return { client: client as unknown as TeamStationClient, stamps }
  }

  async function render(
    client: TeamStationClient,
    socket: FakeScopeSocket
  ): Promise<void> {
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
            />
          </ScreenScopeProvider>
        </ThemeProvider>
      )
    })
    await settle()
  }

  const teamsCalls = (log: string[]): number =>
    log.filter(line => line === 'client.teams').length

  it('asks for the teams only after subscribed, and again for a newer changed', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client, stamps } = homeClient(log)
    for (const path of ['/teams', '/seasons', '/events?played=1&limit=1'])
      stamps.revisions.set(path, '3')
    await render(client, socket)
    expect(socket.asked()).deep.equals(['home'])
    // Rendered, and still waiting: inside the three seconds, nothing is read.
    expect(teamsCalls(log), 'client.teams before subscribed').equals(0)
    expect(log).deep.equals(['subscribe home'])
    expect(document.body.textContent).includes('Loading…')
    expect(timers.pending(), 'each load waits for the ack').equals(3)

    await act(async () => {
      socket.ack('3')
    })
    await settle()
    expect(log.indexOf('subscribed 3')).lessThan(log.indexOf('client.teams'))
    expect(teamsCalls(log), 'client.teams after subscribed').equals(1)
    expect(log).includes('client.recentGame').and.includes('client.liveNow')
    expect(document.body.textContent).includes('Alta Hawks')
    expect(timers.pending(), 'the give-up timers are cleared').equals(0)

    // A notice no newer than what Home read does not read again.
    await act(async () => {
      socket.changed('3')
    })
    await settle()
    expect(teamsCalls(log)).equals(1)

    stamps.revisions.set('/teams', '4')
    await act(async () => {
      socket.changed('4')
    })
    await settle()
    expect(teamsCalls(log), 'client.teams after a newer changed').equals(2)
    trace('online: subscribe, ack, read, newer changed, read', log)
  })

  it('lets a notice of one game alone pass its lists, and reads the recent game and what is live again', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client } = homeClient(log)
    await render(client, socket)
    await act(async () => {
      socket.ack('3')
    })
    await settle()
    const count = (name: string): number =>
      log.filter(line => line === `client.${name}`).length
    expect([count('teams'), count('recentGame'), count('liveNow')]).deep.equals(
      [1, 1, 1]
    )
    // A play: the game's score moved, and no team or season did.
    await act(async () => {
      socket.deliver({ type: 'changed', revision: '9', gameId: 'g1' })
    })
    await settle()
    expect(count('teams'), 'the lists let it pass').equals(1)
    expect(count('seasons')).equals(1)
    expect(count('recentGame'), 'the recent game reads it').equals(2)
    expect(count('liveNow'), 'what is live reads it').equals(2)
    // A notice of a team still reads the lists.
    await act(async () => {
      socket.changed('10')
    })
    await settle()
    expect(count('teams')).equals(2)
  })

  it('reads its teams again when a game goes final, and shows the record it moved', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client, stamps } = homeClient(log)
    let record: TeamSummary['record'] = null
    Object.assign(client, {
      teams: async (): Promise<TeamSummary[]> => {
        log.push('client.teams')
        await Promise.resolve()
        stamps.answer('/teams')
        return [{ ...hawks, record }]
      }
    })
    await render(client, socket)
    await act(async () => {
      socket.ack('3')
    })
    await settle()
    expect(teamsCalls(log)).equals(1)
    expect(document.body.textContent).not.include('1–0')
    // Going final, the server tells the game, and its teams and season at
    // the same revision: the lists pass the first and read on the second.
    record = { w: 1, l: 0, t: 0, seasonName: null }
    await act(async () => {
      socket.deliver({ type: 'changed', revision: '9', gameId: 'g1' })
      socket.changed('9')
    })
    await settle()
    expect(teamsCalls(log), 'the teams are read again').equals(2)
    expect(document.body.textContent).include('1–0')
  })

  it('reads and paints at once while offline, without waiting for an ack', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    const { client, stamps } = homeClient(log)
    stamps.offline = true
    await render(client, socket)
    expect(teamsCalls(log), 'client.teams with no ack').equals(1)
    expect(log).not.includes('subscribed 1')
    expect(document.body.textContent).includes('Alta Hawks')
    expect(document.body.textContent).not.includes('Loading…')
    expect(timers.pending(), 'nothing waits').equals(0)
    trace('offline: read with no ack', log)
  })
})
