import { expect } from 'chai'
import { describe, it } from 'mocha'

import { REVISION_HEADER, TeamStationClient } from './api'
import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from './gameSocket'
import {
  ACK_GIVE_UP_MS,
  leastRevision,
  ScreenScopeGate,
  type ScreenScopeSocket
} from './screenScope'

/** A socket whose scope frames the test delivers by hand. */
class FakeScopes implements ScreenScopeSocket {
  held: Array<{
    scope: ScreenScope
    listener: ScreenScopeListener
    released: boolean
  }> = []

  /** Answers a subscribe at once, as a stopped socket does. */
  answer: ScreenScopeEvent | undefined

  subscribeScope(
    scope: ScreenScope,
    listener: ScreenScopeListener
  ): () => void {
    const entry = { scope, listener, released: false }
    this.held.push(entry)
    if (this.answer != null) listener(this.answer)
    return () => {
      entry.released = true
    }
  }

  /** Delivers to the newest subscription. */
  deliver(event: ScreenScopeEvent): void {
    this.held[this.held.length - 1].listener(event)
  }
}

function manualTimers(): {
  delays: number[]
  fire: () => void
  pending: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
} {
  const waiting = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  return {
    delays,
    fire: () => {
      const [id, run] = [...waiting.entries()][0]
      waiting.delete(id)
      run()
    },
    pending: () => waiting.size,
    setTimer: (run, ms) => {
      delays.push(ms)
      const id = next++
      waiting.set(id, run)
      return id
    },
    clearTimer: timer => {
      waiting.delete(timer as number)
    }
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
}

/** A client whose answers carry the revisions the test sets per path. */
function revisionClient(): {
  client: TeamStationClient
  revisions: Map<string, string>
  calls: string[]
} {
  const revisions = new Map<string, string>()
  const calls: string[] = []
  const fake = async (url: unknown): Promise<Response> => {
    const path = String(url).replace('http://api.test/api/v1', '')
    calls.push(path)
    const revision = revisions.get(path)
    return new Response('[]', {
      status: 200,
      headers: revision == null ? {} : { [REVISION_HEADER]: revision }
    })
  }
  const client = new TeamStationClient({
    baseUrl: 'http://api.test/api/v1',
    fetch: fake
  })
  return { client, revisions, calls }
}

function makeGate(
  options: {
    socket?: FakeScopes | null
    load?: () => Promise<void>
    client?: TeamStationClient
    onError?: (error: unknown) => void
  } = {}
): {
  gate: ScreenScopeGate
  socket: FakeScopes
  timers: ReturnType<typeof manualTimers>
  loads: () => number
} {
  const socket = options.socket ?? new FakeScopes()
  const timers = manualTimers()
  let count = 0
  const gate = new ScreenScopeGate({
    socket: options.socket === null ? undefined : socket,
    client: options.client,
    onError: options.onError,
    load: async () => {
      count++
      await options.load?.()
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  })
  return { gate, socket, timers, loads: () => count }
}

describe('the screen scope gate', function () {
  it('reads nothing until the scope is acknowledged, then reads (Ack barrier)', async function () {
    const { gate, socket, timers, loads } = makeGate()
    gate.enter({ scope: 'home' })
    gate.refresh()
    await settle()
    expect(socket.held.map(entry => entry.scope)).deep.equals([
      { scope: 'home' }
    ])
    expect(loads()).equals(0)
    expect(gate.acknowledged).equals(false)
    expect(timers.delays).deep.equals([ACK_GIVE_UP_MS])
    socket.deliver({ type: 'subscribed', revision: '4' })
    await settle()
    expect(loads()).equals(1)
    expect(gate.acknowledged).equals(true)
    expect(timers.pending()).equals(0)
    // Acknowledged, a refresh reads at once.
    gate.refresh()
    await settle()
    expect(loads()).equals(2)
    gate.leave()
    expect(socket.held[0].released).equals(true)
  })

  it('reads after 3 seconds without an ack, and again when it arrives (Give-up)', async function () {
    const { gate, socket, timers, loads } = makeGate()
    expect(ACK_GIVE_UP_MS).equals(3000)
    gate.enter({ scope: 'schedule' })
    timers.fire()
    await settle()
    expect(loads()).equals(1)
    socket.deliver({ type: 'subscribed', revision: '9' })
    await settle()
    expect(loads()).equals(2)
  })

  it('holds the least revision of a load, and reads again only for a newer notice (Overlap)', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '5')
    revisions.set('/seasons', '7')
    const { gate, socket, loads } = makeGate({
      client,
      load: async () => {
        await client.teams()
        await client.seasons()
      }
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed', revision: '5' })
    await settle()
    expect(loads()).equals(1)
    expect(gate.revision).equals('5')
    expect(client.revisionFor('/seasons')).equals('7')
    // At or below the least: the screen already has it.
    socket.deliver({ type: 'changed', revision: '5' })
    socket.deliver({ type: 'changed', revision: '4' })
    await settle()
    expect(loads()).equals(1)
    // Above the least, though below the later answer's: read again.
    socket.deliver({ type: 'changed', revision: '6' })
    await settle()
    expect(loads()).equals(2)
    expect(gate.revision).equals('5')

    // A prefetch of the same path moves revisionFor, not what is held.
    revisions.set('/teams', '9')
    await client.teams()
    expect(client.revisionFor('/teams')).equals('9')
    expect(gate.revision).equals('5')
    socket.deliver({ type: 'changed', revision: '6' })
    await settle()
    expect(loads()).equals(3)
    expect(gate.revision).equals('7')
  })

  it('compares notices heard during a load with what it read, and reads once more', async function () {
    const { client, revisions } = revisionClient()
    let release: (() => void) | undefined
    revisions.set('/teams', '10')
    const { gate, socket, loads } = makeGate({
      client,
      load: async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        await client.teams()
      }
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed', revision: '8' })
    await settle()
    // Older than what the load will read: nothing more.
    socket.deliver({ type: 'changed', revision: '9' })
    release?.()
    await settle()
    expect(loads()).equals(1)
    // Newer, twice, during the next load: one more read.
    gate.refresh()
    await settle()
    socket.deliver({ type: 'changed', revision: '11' })
    socket.deliver({ type: 'changed', revision: '12' })
    socket.deliver({ type: 'changed', revision: '11' })
    gate.refresh()
    release?.()
    await settle()
    expect(loads()).equals(3)
    release?.()
    await settle()
    expect(loads()).equals(3)
  })

  it('drops the notices of a scope it left, and waits for the new one’s ack (Replaced scope)', async function () {
    const { gate, socket, loads } = makeGate()
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed', revision: '1' })
    await settle()
    expect(loads()).equals(1)
    gate.enter({ scope: 'event', gameId: 'g1' })
    expect(socket.held[0].released).equals(true)
    socket.held[0].listener({ type: 'changed', revision: '50' })
    socket.held[0].listener({ type: 'subscribed', revision: '50' })
    gate.refresh()
    await settle()
    expect(loads()).equals(1)
    expect(gate.revision).equals(undefined)
    socket.deliver({ type: 'subscribed', revision: '50' })
    await settle()
    expect(loads()).equals(2)
  })

  it('ignores a notice before the ack, which the ack’s read already covers', async function () {
    const { gate, socket, loads } = makeGate()
    gate.enter({ scope: 'schedule' })
    socket.deliver({ type: 'changed', revision: '3' })
    await settle()
    expect(loads()).equals(0)
  })

  it('waits for a new ack after resync (Reconnect)', async function () {
    const { gate, socket, timers, loads } = makeGate()
    gate.enter({ scope: 'schedule' })
    socket.deliver({ type: 'subscribed', revision: '1' })
    await settle()
    socket.deliver({ type: 'resync' })
    expect(gate.acknowledged).equals(false)
    gate.refresh()
    await settle()
    expect(loads()).equals(1)
    expect(timers.pending()).equals(1)
    socket.deliver({ type: 'subscribed', revision: '2' })
    await settle()
    expect(loads()).equals(2)
    expect(timers.pending()).equals(0)
  })

  it('reads at once once the scope stops for its token, or is refused (Reconnect)', async function () {
    const stopped = makeGate()
    stopped.gate.enter({ scope: 'home' })
    stopped.gate.refresh()
    stopped.socket.deliver({ type: 'stopped' })
    await settle()
    expect(stopped.loads()).equals(1)
    stopped.gate.refresh()
    await settle()
    expect(stopped.loads()).equals(2)
    // Notices still count once nothing waits for an ack.
    stopped.socket.deliver({ type: 'changed', revision: '1' })
    await settle()
    expect(stopped.loads()).equals(3)

    // A socket already stopped answers the subscribe itself.
    const socket = new FakeScopes()
    socket.answer = { type: 'stopped' }
    const early = makeGate({ socket })
    early.gate.enter({ scope: 'home' })
    await settle()
    expect(early.loads()).equals(1)
    expect(early.timers.pending()).equals(0)

    const refused = makeGate()
    refused.gate.enter({ scope: 'event', gameId: 'hidden' })
    refused.socket.deliver({
      type: 'error',
      code: 'notFound',
      message: 'No such game'
    })
    await settle()
    expect(refused.loads()).equals(1)
    // Refused after the give-up already read: nothing more until asked.
    const late = makeGate()
    late.gate.enter({ scope: 'home' })
    late.timers.fire()
    late.socket.deliver({ type: 'error', code: 'internal', message: 'x' })
    await settle()
    expect(late.loads()).equals(1)
  })

  it('reads at once with no socket or no scope (No socket)', async function () {
    const bare = makeGate({ socket: null })
    bare.gate.enter({ scope: 'event', gameId: 'g1' })
    await settle()
    expect(bare.loads()).equals(1)
    const none = makeGate()
    none.gate.enter(undefined)
    await settle()
    expect(none.loads()).equals(1)
    expect(none.socket.held).deep.equals([])
  })

  it('reads at once while the client is offline, and again on the ack', async function () {
    const { client } = revisionClient()
    client.offline = true
    const { gate, socket, timers, loads } = makeGate({ client })
    gate.enter({ scope: 'home' })
    await settle()
    expect(loads()).equals(1)
    expect(timers.pending()).equals(0)
    client.offline = false
    socket.deliver({ type: 'subscribed', revision: '2' })
    await settle()
    expect(loads()).equals(2)
  })

  it('keeps the revision it held when a load fails, and says so', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '3')
    const errors: unknown[] = []
    let fail = false
    const { gate, socket, loads } = makeGate({
      client,
      onError: error => errors.push(error),
      load: async () => {
        if (fail) throw new Error('offline')
        await client.teams()
      }
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed', revision: '3' })
    await settle()
    fail = true
    socket.deliver({ type: 'changed', revision: '4' })
    await settle()
    expect(loads()).equals(2)
    expect(errors.map(String)).deep.equals(['Error: offline'])
    expect(gate.revision).equals('3')
  })

  it('forgets a load that finishes after the screen left', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '3')
    let release: (() => void) | undefined
    const { gate, socket, loads } = makeGate({
      client,
      load: async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        await client.teams()
      }
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed', revision: '3' })
    await settle()
    gate.leave()
    gate.leave()
    release?.()
    await settle()
    expect(loads()).equals(1)
    expect(gate.revision).equals(undefined)
  })

  it('lets pass a notice the load does not show, and reads for the rest', async function () {
    const socket = new FakeScopes()
    let loads = 0
    const gate = new ScreenScopeGate({
      socket,
      load: async () => {
        loads++
      },
      passes: notice => notice.gameId != null
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed', revision: '1' })
    await settle()
    expect(loads).equals(1)
    socket.deliver({ type: 'changed', revision: '2', gameId: 'g1' })
    await settle()
    expect(loads, 'one game alone').equals(1)
    socket.deliver({ type: 'changed', revision: '3' })
    await settle()
    expect(loads).equals(2)
    gate.leave()
  })

  it('reads at once while the socket is down, and the ack reads again only if newer (Not connected)', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '5')
    const { gate, socket, timers, loads } = makeGate({
      client,
      load: async () => {
        await client.teams()
      }
    })
    // A first connect on its way is waited for.
    gate.enter({ scope: 'home' })
    await settle()
    expect(loads()).equals(0)
    // It failed: the waiting read goes now, without the three seconds.
    socket.deliver({ type: 'unreachable' })
    await settle()
    expect(loads()).equals(1)
    expect(timers.pending()).equals(0)
    // While it retries, a refresh reads at once too.
    gate.refresh()
    await settle()
    expect(loads()).equals(2)
    // Connected at no newer a revision than the read: nothing to read.
    socket.deliver({ type: 'subscribed', revision: '5' })
    await settle()
    expect(loads()).equals(2)
    expect(gate.acknowledged).equals(true)
    // Down again and back at a newer revision: one more read.
    socket.deliver({ type: 'resync' })
    socket.deliver({ type: 'unreachable' })
    socket.deliver({ type: 'subscribed', revision: '6' })
    await settle()
    expect(loads()).equals(3)
    // Acknowledged, a stale unreachable changes nothing.
    socket.deliver({ type: 'unreachable' })
    gate.refresh()
    await settle()
    expect(loads()).equals(4)
    gate.leave()
  })

  it('finds the least revision among a load’s answers', function () {
    expect(leastRevision([])).equals(undefined)
    expect(
      leastRevision([
        { path: '/a', revision: '12' },
        { path: '/b', revision: '9007199254740993' },
        { path: '/c', revision: '3' }
      ])
    ).equals(3n)
  })
})

describe('TeamStationClient revisions', function () {
  it('records each path’s revision and collects only while asked', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '4')
    await client.teams()
    expect(client.revisionFor('/teams')).equals('4')
    expect(client.revisionFor('/seasons')).equals(undefined)
    const collector: Array<{ path: string; revision: string }> = []
    client.collectRevisions(collector)
    await client.teams()
    await client.seasons()
    const other: typeof collector = []
    client.stopCollecting(other)
    revisions.set('/seasons', '6')
    await client.seasons()
    client.stopCollecting(collector)
    await client.teams()
    expect(collector).deep.equals([
      { path: '/teams', revision: '4' },
      { path: '/seasons', revision: '6' }
    ])
  })

  it('collects every answer into each load running at once', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '4')
    revisions.set('/seasons', '6')
    const lists: Array<{ path: string; revision: string }> = []
    const recent: typeof lists = []
    client.collectRevisions(lists)
    client.collectRevisions(recent)
    await Promise.all([client.teams(), client.seasons()])
    client.stopCollecting(recent)
    await client.teams()
    client.stopCollecting(lists)
    // Neither load holds a revision newer than the least of its own answers.
    expect(leastRevision(lists)).equals(4n)
    expect(leastRevision(recent)).equals(4n)
    expect(lists).has.lengthOf(3)
    expect(recent).has.lengthOf(2)
  })

  it('is offline while a request cannot leave the device', async function () {
    let reachable = false
    const client = new TeamStationClient({
      baseUrl: 'http://api.test/api/v1',
      fetch: async () => {
        if (!reachable) throw new TypeError('Failed to fetch')
        return new Response('[]', { status: 200 })
      }
    })
    expect(client.offline).equals(false)
    let failure: unknown
    try {
      await client.teams()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    expect(client.offline).equals(true)
    reachable = true
    await client.teams()
    expect(client.offline).equals(false)
  })
})
