import { expect } from 'chai'
import { describe, it } from 'mocha'

import { testClock } from '../test/fakeScreenScope'
import { REVISION_HEADER, TeamStationClient } from './api'
import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from './gameSocket'
import {
  ACK_GIVE_UP_MS,
  COALESCE_MS,
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

/** A load the test finishes by hand: `running()` until `finish()`. */
function heldLoads(): {
  load: () => Promise<void>
  finish: () => void
  running: () => boolean
} {
  let release: (() => void) | undefined
  return {
    load: async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
    },
    finish: () => {
      const done = release
      release = undefined
      done?.()
    },
    running: () => release != null
  }
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
  clock: ReturnType<typeof testClock>
  loads: () => number
  /** When each read began, on the test clock, from the gate's creation. */
  began: number[]
} {
  const socket = options.socket ?? new FakeScopes()
  const clock = testClock(0)
  let count = 0
  const began: number[] = []
  const gate = new ScreenScopeGate({
    socket: options.socket === null ? undefined : socket,
    client: options.client,
    onError: options.onError,
    load: async () => {
      count++
      began.push(clock.now())
      await options.load?.()
    },
    ...clock
  })
  return { gate, socket, clock, loads: () => count, began }
}

describe('the screen scope gate', function () {
  it('reads nothing until the scope is acknowledged, then reads (Ack barrier)', async function () {
    const { gate, socket, clock, loads } = makeGate()
    gate.enter({ scope: 'home' })
    gate.refresh()
    await settle()
    expect(socket.held.map(entry => entry.scope)).deep.equals([
      { scope: 'home' }
    ])
    expect(loads()).equals(0)
    expect(gate.acknowledged).equals(false)
    expect(clock.pending()).deep.equals([ACK_GIVE_UP_MS])
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(1)
    expect(gate.acknowledged).equals(true)
    expect(clock.pending()).deep.equals([])
    // Acknowledged, a refresh reads at once.
    gate.refresh()
    await settle()
    expect(loads()).equals(2)
    gate.leave()
    expect(socket.held[0].released).equals(true)
  })

  it('reads after 3 seconds without an ack, and again when it arrives (Give-up)', async function () {
    const { gate, socket, clock, loads } = makeGate()
    expect(ACK_GIVE_UP_MS).equals(3000)
    gate.enter({ scope: 'schedule' })
    clock.advance(ACK_GIVE_UP_MS)
    await settle()
    expect(loads()).equals(1)
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(2)
  })

  it('reads a notice at once when no read runs and none began in 3 s', async function () {
    const { gate, socket, clock, began } = makeGate()
    expect(COALESCE_MS).equals(3000)
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(5000)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(began).deep.equals([0, 5000])
    expect(clock.pending()).deep.equals([])
  })

  it('reads once for ten notices over 2 s during a read, 3 s after it began', async function () {
    const held = heldLoads()
    const { gate, socket, clock, began } = makeGate({ load: held.load })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(held.running()).equals(true)
    for (let i = 0; i < 10; i++) {
      clock.advance(200)
      socket.deliver({ type: 'changed' })
    }
    // The read ends 2 s in: the next waits for its 3 s.
    held.finish()
    await settle()
    expect(began).deep.equals([0])
    expect(clock.pending()).deep.equals([1000])
    clock.advance(999)
    await settle()
    expect(began).deep.equals([0])
    clock.advance(1)
    await settle()
    expect(began).deep.equals([0, 3000])
    held.finish()
    await settle()
    expect(clock.pending()).deep.equals([])
    clock.advance(10_000)
    await settle()
    expect(began).deep.equals([0, 3000])
  })

  it('reads again at once when a read ran longer than 3 s and heard a notice', async function () {
    const held = heldLoads()
    const { gate, socket, clock, began } = makeGate({ load: held.load })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    clock.advance(4000)
    held.finish()
    await settle()
    expect(began).deep.equals([0, 5000])
  })

  it('holds a notice 1 s after a read to the 3 s mark, and reads one 4 s after at once', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'schedule' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(began).deep.equals([0])
    expect(clock.pending()).deep.equals([2000])
    // Dirty already: a second notice adds nothing.
    clock.advance(500)
    socket.deliver({ type: 'changed' })
    expect(clock.pending()).deep.equals([1500])
    clock.advance(1500)
    await settle()
    expect(began).deep.equals([0, 3000])
    clock.advance(4000)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(began).deep.equals([0, 3000, 7000])
  })

  it('reads at once on each subscribed: the first, after a reconnect and after a resync', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(500)
    // The socket dropped and came back.
    socket.deliver({ type: 'resync' })
    socket.deliver({ type: 'unreachable' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(500)
    // The server's resync: asked again, and answered.
    socket.deliver({ type: 'resync' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(began).deep.equals([0, 500, 1000])
  })

  it('holds the next notice to 3 s after a read the screen made itself (alongside)', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'event', gameId: 'g1' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(5000)
    const outside: number[] = []
    await gate.alongside(async () => {
      outside.push(clock.now())
    })
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(began).deep.equals([0])
    expect(clock.pending()).deep.equals([2000])
    clock.advance(2000)
    await settle()
    expect(outside).deep.equals([5000])
    expect(began).deep.equals([0, 8000])
  })

  it('times a notice owed before a read alongside from that read’s start', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'event', gameId: 'g1' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(clock.pending()).deep.equals([2000])
    clock.advance(800)
    let release: (() => void) | undefined
    const outside = gate.alongside(async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    clock.advance(100)
    release?.()
    await outside
    await settle()
    // The read alongside began at 1.8 s: the owed one waits to 4.8 s, not 3 s.
    expect(clock.pending()).deep.equals([2900])
    clock.advance(1100)
    await settle()
    expect(began).deep.equals([0])
    clock.advance(1800)
    await settle()
    expect(began).deep.equals([0, 4800])
  })

  it('owes a read for a notice heard during a read alongside', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'event', gameId: 'g1' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(5000)
    let release: (() => void) | undefined
    const outside = gate.alongside(async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    socket.deliver({ type: 'changed' })
    clock.advance(1000)
    release?.()
    await outside
    await settle()
    expect(began).deep.equals([0])
    clock.advance(2000)
    await settle()
    expect(began).deep.equals([0, 8000])
    // One that failed counts too, and the screen hears its error.
    let failure: unknown
    await gate
      .alongside(async () => {
        throw new Error('no game')
      })
      .catch((error: unknown) => {
        failure = error
      })
    expect(String(failure)).equals('Error: no game')
  })

  it('waits on past its time for a read alongside that is still running', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'event', gameId: 'g1' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    clock.advance(1500)
    let release: (() => void) | undefined
    const outside = gate.alongside(async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    // Its 3 s pass while the read alongside runs: it waits for that one.
    clock.advance(1000)
    await settle()
    expect(began).deep.equals([0])
    release?.()
    await outside
    expect(clock.pending()).deep.equals([2000])
    clock.advance(2000)
    await settle()
    expect(began).deep.equals([0, 5500])
  })

  it('reads at once for a refresh, covering a notice that waited', async function () {
    const { gate, socket, clock, began } = makeGate()
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    expect(clock.pending()).deep.equals([2000])
    gate.refresh()
    await settle()
    expect(began).deep.equals([0, 1000])
    expect(clock.pending()).deep.equals([])
    clock.advance(5000)
    await settle()
    expect(began).deep.equals([0, 1000])
  })

  it('reads at once after a running read for a refresh asked during it', async function () {
    const held = heldLoads()
    const { gate, socket, clock, began } = makeGate({ load: held.load })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(500)
    socket.deliver({ type: 'changed' })
    gate.refresh()
    clock.advance(500)
    held.finish()
    await settle()
    expect(began).deep.equals([0, 1000])
    held.finish()
    await settle()
    expect(clock.pending()).deep.equals([])
  })

  it('drops the notices of a scope it left, and waits for the new one’s ack (Replaced scope)', async function () {
    const { gate, socket, loads } = makeGate()
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(1)
    gate.enter({ scope: 'event', gameId: 'g1' })
    expect(socket.held[0].released).equals(true)
    socket.held[0].listener({ type: 'changed' })
    socket.held[0].listener({ type: 'subscribed' })
    gate.refresh()
    await settle()
    expect(loads()).equals(1)
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(2)
  })

  it('forgets a read it owed once the screen left', async function () {
    const { gate, socket, clock, loads } = makeGate()
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    clock.advance(1000)
    socket.deliver({ type: 'changed' })
    expect(clock.pending()).deep.equals([2000])
    gate.leave()
    expect(clock.pending()).deep.equals([])
    clock.advance(5000)
    await settle()
    expect(loads()).equals(1)
  })

  it('ignores a notice before the ack, which the ack’s read already covers', async function () {
    const { gate, socket, loads } = makeGate()
    gate.enter({ scope: 'schedule' })
    socket.deliver({ type: 'changed' })
    await settle()
    expect(loads()).equals(0)
  })

  it('waits for a new ack after resync (Reconnect)', async function () {
    const { gate, socket, clock, loads } = makeGate()
    gate.enter({ scope: 'schedule' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    socket.deliver({ type: 'resync' })
    expect(gate.acknowledged).equals(false)
    gate.refresh()
    await settle()
    expect(loads()).equals(1)
    expect(clock.pending()).deep.equals([ACK_GIVE_UP_MS])
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(2)
    expect(clock.pending()).deep.equals([])
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
    // Notices still count once nothing waits for an ack, through the gate.
    stopped.clock.advance(COALESCE_MS)
    stopped.socket.deliver({ type: 'changed' })
    await settle()
    expect(stopped.loads()).equals(3)

    // A socket already stopped answers the subscribe itself.
    const socket = new FakeScopes()
    socket.answer = { type: 'stopped' }
    const early = makeGate({ socket })
    early.gate.enter({ scope: 'home' })
    await settle()
    expect(early.loads()).equals(1)
    expect(early.clock.pending()).deep.equals([])

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
    late.clock.advance(ACK_GIVE_UP_MS)
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
    const { gate, socket, clock, loads } = makeGate({ client })
    gate.enter({ scope: 'home' })
    await settle()
    expect(loads()).equals(1)
    expect(clock.pending()).deep.equals([])
    client.offline = false
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(2)
  })

  it('goes on after a load fails, and says so', async function () {
    const errors: unknown[] = []
    let fail = false
    const { gate, socket, clock, loads } = makeGate({
      onError: error => errors.push(error),
      load: async () => {
        if (fail) throw new Error('offline')
      }
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    fail = true
    clock.advance(COALESCE_MS)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(loads()).equals(2)
    expect(errors.map(String)).deep.equals(['Error: offline'])
    fail = false
    clock.advance(COALESCE_MS)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(loads()).equals(3)
  })

  it('forgets a load that finishes after the screen left', async function () {
    const held = heldLoads()
    const { gate, socket, clock, loads } = makeGate({ load: held.load })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    socket.deliver({ type: 'changed' })
    gate.leave()
    gate.leave()
    held.finish()
    await settle()
    clock.advance(10_000)
    await settle()
    expect(loads()).equals(1)
  })

  it('lets pass a notice the load does not show, and reads for the rest', async function () {
    const socket = new FakeScopes()
    let loads = 0
    const gate = new ScreenScopeGate({
      socket,
      load: async () => {
        loads++
      },
      passes: notice => notice.gameId != null,
      coalesceMs: 0
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads).equals(1)
    socket.deliver({ type: 'changed', gameId: 'g1' })
    await settle()
    expect(loads, 'one game alone').equals(1)
    socket.deliver({ type: 'changed' })
    await settle()
    expect(loads).equals(2)
    gate.leave()
  })

  it('times its reads by the platform’s clock unless given one', async function () {
    let loads = 0
    const socket = new FakeScopes()
    const gate = new ScreenScopeGate({
      socket,
      load: async () => {
        loads++
      },
      coalesceMs: 20
    })
    gate.enter({ scope: 'home' })
    socket.deliver({ type: 'subscribed' })
    await settle()
    socket.deliver({ type: 'changed' })
    await settle()
    expect(loads).equals(1)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(loads).equals(2)
    gate.leave()
  })

  it('reads at once while the socket is down, and again on the ack (Not connected)', async function () {
    const { gate, socket, clock, loads } = makeGate()
    // A first connect on its way is waited for.
    gate.enter({ scope: 'home' })
    await settle()
    expect(loads()).equals(0)
    // It failed: the waiting read goes now, without the three seconds.
    socket.deliver({ type: 'unreachable' })
    await settle()
    expect(loads()).equals(1)
    expect(clock.pending()).deep.equals([])
    // While it retries, a refresh reads at once too.
    gate.refresh()
    await settle()
    expect(loads()).equals(2)
    // Connected: what changed while it was down is read.
    socket.deliver({ type: 'subscribed' })
    await settle()
    expect(loads()).equals(3)
    expect(gate.acknowledged).equals(true)
    // Acknowledged, a stale unreachable changes nothing.
    socket.deliver({ type: 'unreachable' })
    gate.refresh()
    await settle()
    expect(loads()).equals(4)
    gate.leave()
  })
})

describe('TeamStationClient revisions', function () {
  it('records each path’s revision', async function () {
    const { client, revisions } = revisionClient()
    revisions.set('/teams', '4')
    await client.teams()
    expect(client.revisionFor('/teams')).equals('4')
    expect(client.revisionFor('/seasons')).equals(undefined)
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
