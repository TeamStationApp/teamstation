import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from '../../common/gameSocket'
import {
  ACK_GIVE_UP_MS,
  COALESCE_MS,
  type ScreenScopeNotice
} from '../../common/screenScope'
import {
  FakeScopeSocket,
  heldTimers,
  testClock
} from '../../test/fakeScreenScope'
import { SceneShownProvider } from '../components/sceneShown'
import {
  screenScopeKey,
  ScreenScopeProvider,
  type ScreenScopeRead,
  SharedScreenScope,
  useScreenScope
} from './useScreenScope'

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
  })
}

describe('SharedScreenScope', function () {
  it('holds one subscription for every load on the scope, and lets it go with the last', async function () {
    const socket = new FakeScopeSocket()
    const shared = new SharedScreenScope(socket)
    const first: ScreenScopeEvent[] = []
    const second: ScreenScopeEvent[] = []
    const releaseFirst = shared.subscribeScope({ scope: 'home' }, event =>
      first.push(event)
    )
    socket.ack()
    const releaseSecond = shared.subscribeScope({ scope: 'home' }, event =>
      second.push(event)
    )
    // The answer reaches a load that joins late, after the call returns.
    expect(second).deep.equals([])
    await Promise.resolve()
    expect(second).deep.equals([{ type: 'subscribed' }])
    socket.changed()
    expect(first.at(-1)).deep.equals({ type: 'changed' })
    expect(second.at(-1)).deep.equals({ type: 'changed' })
    expect(socket.asked()).deep.equals(['home'])
    releaseFirst()
    releaseFirst()
    expect(socket.current()).not.equals(undefined)
    releaseSecond()
    expect(socket.current()).equals(undefined)
  })

  it('replaces another scope, and the replaced loads hear nothing more', function () {
    const socket = new FakeScopeSocket()
    const shared = new SharedScreenScope(socket)
    const home: ScreenScopeEvent[] = []
    const event: ScreenScopeEvent[] = []
    const releaseHome = shared.subscribeScope({ scope: 'home' }, heard =>
      home.push(heard)
    )
    shared.subscribeScope({ scope: 'event', gameId: 'g1' }, heard =>
      event.push(heard)
    )
    socket.ack()
    expect(home).deep.equals([])
    expect(event).deep.equals([{ type: 'subscribed' }])
    // Letting go of the replaced scope leaves the new one held.
    releaseHome()
    expect(socket.asked()).deep.equals(['home', 'event:g1'])
    expect(socket.current()?.scope).deep.equals({
      scope: 'event',
      gameId: 'g1'
    })
  })

  it('tells a late load nothing once the scope must be acknowledged again', async function () {
    const socket = new FakeScopeSocket()
    const shared = new SharedScreenScope(socket)
    shared.subscribeScope({ scope: 'schedule' }, () => undefined)
    socket.ack()
    socket.deliver({ type: 'resync' })
    const late: ScreenScopeEvent[] = []
    shared.subscribeScope({ scope: 'schedule' }, heard => late.push(heard))
    await Promise.resolve()
    expect(late).deep.equals([])
    socket.ack()
    expect(late).deep.equals([{ type: 'subscribed' }])
  })

  it('tells a late load the scope was refused, and not after it left', async function () {
    const socket = new FakeScopeSocket()
    const shared = new SharedScreenScope(socket)
    shared.subscribeScope({ scope: 'event', gameId: 'g9' }, () => undefined)
    socket.deliver({ type: 'error', code: 'notFound', message: 'No game' })
    const late: ScreenScopeEvent[] = []
    shared.subscribeScope({ scope: 'event', gameId: 'g9' }, heard =>
      late.push(heard)
    )
    const gone: ScreenScopeEvent[] = []
    shared.subscribeScope({ scope: 'event', gameId: 'g9' }, heard =>
      gone.push(heard)
    )()
    await Promise.resolve()
    expect(late).deep.equals([
      { type: 'error', code: 'notFound', message: 'No game' }
    ])
    expect(gone).deep.equals([])
  })

  it('says nothing will be acknowledged on a platform with no socket', function () {
    const heard: ScreenScopeEvent[] = []
    const shared = new SharedScreenScope({
      subscribeScope: (_scope: ScreenScope, _listener: ScreenScopeListener) => {
        throw new Error('This platform has no WebSocket')
      }
    })
    const release = shared.subscribeScope({ scope: 'home' }, event =>
      heard.push(event)
    )
    expect(heard).deep.equals([{ type: 'stopped' }])
    release()
  })

  it('names each scope as a value', function () {
    expect(screenScopeKey({ scope: 'home' })).equals('home')
    expect(screenScopeKey({ scope: 'event', gameId: 'g1' })).equals('event:g1')
  })
})

describe('useScreenScope', function () {
  let root: Root | undefined
  let timers: ReturnType<typeof heldTimers> | undefined
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
  })

  interface Probe {
    socket?: FakeScopeSocket
    scope?: ScreenScope
    client?: { offline?: boolean }
    /** The gate's clock, for a test that moves it. */
    clock?: ReturnType<typeof testClock>
    /** Called, as a screen's existing load would be. */
    load: () => Promise<void>
    /** Handed the function the hook returns. */
    onRefresh?: (refresh: () => Promise<void>) => void
    /** A notice the load lets pass. */
    passes?: (notice: ScreenScopeNotice) => boolean
  }

  function Loader(props: Probe): null {
    const refresh = useScreenScope(props.load, props.client, undefined, {
      passes: props.passes
    })
    const { onRefresh } = props
    useEffect(() => {
      onRefresh?.(refresh)
      refresh().catch(() => undefined)
    }, [refresh, onRefresh])
    return null
  }

  async function render(probe: Probe): Promise<void> {
    if (root == null) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(
        <ScreenScopeProvider
          socket={probe.socket}
          scope={probe.scope}
          timers={probe.clock}
        >
          <Loader {...probe} />
        </ScreenScopeProvider>
      )
    })
    await settle()
  }

  it('reads nothing a notice names while a screen covers it', async function () {
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    let loads = 0
    const load = async (): Promise<void> => {
      loads++
    }
    const scope: ScreenScope = { scope: 'home' }
    const tree = (shown: boolean): React.ReactElement => (
      <SceneShownProvider value={shown}>
        <ScreenScopeProvider socket={socket} scope={scope}>
          <Loader socket={socket} scope={scope} load={load} />
        </ScreenScopeProvider>
      </SceneShownProvider>
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(tree(true))
    })
    await settle()
    socket.ack()
    await settle()
    expect(loads).equals(1)
    await act(async () => {
      root!.render(tree(false))
    })
    socket.changed()
    await settle()
    expect(loads).equals(1)
  })

  it('lets pass a post’s notice of its own game, and reads every other', async function () {
    const log: string[] = []
    const clock = testClock(0)
    const socket = new FakeScopeSocket(log)
    const scope: ScreenScope = { scope: 'event', gameId: 'g1' }
    let loads = 0
    const load = async (): Promise<void> => {
      loads++
    }
    const probe = (): Probe => ({
      socket,
      scope,
      clock,
      load,
      // A new function each render, as a screen may hand one.
      passes: notice => notice.byPost === true && notice.gameId === 'g1'
    })
    await render(probe())
    socket.ack()
    await settle()
    expect(loads).equals(1)
    const heard = async (gameId?: string, byPost?: boolean): Promise<void> => {
      clock.advance(COALESCE_MS)
      socket.changed(gameId, byPost)
      await settle()
    }
    await heard('g1', true)
    expect(loads).equals(1)
    await render(probe())
    await heard('g1', true)
    expect(loads).equals(1)
    await heard('g1')
    expect(loads).equals(2)
    await heard('g2', true)
    expect(loads).equals(3)
    await heard()
    expect(loads).equals(4)
    // The gate the screen began with: one scope asked for.
    expect(socket.asked()).deep.equals(['event:g1'])
  })

  it('reads only after the scope is acknowledged', async function () {
    const log: string[] = []
    const socket = new FakeScopeSocket(log)
    await render({
      socket,
      scope: { scope: 'home' },
      load: async () => {
        log.push('load')
      }
    })
    expect(log).deep.equals(['subscribe home'])
    socket.ack()
    await settle()
    expect(log).deep.equals(['subscribe home', 'subscribed', 'load'])
  })

  it('reads at once while offline, and with no socket', async function () {
    const client = { offline: true }
    let loads = 0
    await render({
      socket: new FakeScopeSocket(),
      scope: { scope: 'schedule' },
      client,
      load: async () => {
        loads++
      }
    })
    expect(loads).equals(1)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await render({
      scope: { scope: 'schedule' },
      load: async () => {
        loads++
      }
    })
    expect(loads).equals(2)
  })

  it('reads after three seconds with no answer, and again when it comes', async function () {
    timers = heldTimers(ACK_GIVE_UP_MS)
    const socket = new FakeScopeSocket()
    let loads = 0
    await render({
      socket,
      scope: { scope: 'home' },
      load: async () => {
        loads++
      }
    })
    expect(loads).equals(0)
    expect(timers.pending()).equals(1)
    await act(async () => {
      timers!.fire()
    })
    await settle()
    expect(loads).equals(1)
    socket.ack()
    await settle()
    expect(loads).equals(2)
  })

  /** A load the test finishes by hand, and when each began on `clock`. */
  function timedLoads(clock: ReturnType<typeof testClock>): {
    load: () => Promise<void>
    began: number[]
    finish: () => Promise<void>
  } {
    const began: number[] = []
    let release: (() => void) | undefined
    return {
      began,
      load: async () => {
        began.push(clock.now())
        await new Promise<void>(resolve => {
          release = resolve
        })
      },
      finish: async () => {
        release?.()
        release = undefined
        await settle()
      }
    }
  }

  it('reads a notice at once when idle, and once for ten during a read, 3 s after it began', async function () {
    const clock = testClock(0)
    const socket = new FakeScopeSocket()
    const loads = timedLoads(clock)
    await render({ socket, scope: { scope: 'home' }, clock, load: loads.load })
    socket.ack()
    await settle()
    await loads.finish()
    // Idle, and the last read began 3 s ago: at once.
    clock.advance(COALESCE_MS)
    socket.changed()
    await settle()
    expect(loads.began).deep.equals([0, 3000])
    // Ten notices over 2 s while that read runs: one read, at its 3 s.
    for (let i = 0; i < 10; i++) {
      clock.advance(200)
      socket.changed()
    }
    await loads.finish()
    await act(async () => {
      clock.advance(999)
    })
    expect(loads.began).deep.equals([0, 3000])
    await act(async () => {
      clock.advance(1)
    })
    await settle()
    expect(loads.began).deep.equals([0, 3000, 6000])
    await loads.finish()
    clock.advance(10_000)
    await settle()
    expect(loads.began).deep.equals([0, 3000, 6000])
  })

  it('holds a notice 1 s after a read to the 3 s mark, and reads one 4 s after at once', async function () {
    const clock = testClock(0)
    const socket = new FakeScopeSocket()
    const loads = timedLoads(clock)
    await render({
      socket,
      scope: { scope: 'schedule' },
      clock,
      load: loads.load
    })
    socket.ack()
    await settle()
    await loads.finish()
    clock.advance(1000)
    socket.changed()
    await settle()
    expect(loads.began).deep.equals([0])
    await act(async () => {
      clock.advance(2000)
    })
    await loads.finish()
    expect(loads.began).deep.equals([0, 3000])
    clock.advance(4000)
    socket.changed()
    await loads.finish()
    expect(loads.began).deep.equals([0, 3000, 7000])
  })

  it('reads at once on every subscribed, and holds a notice after a read alongside', async function () {
    const clock = testClock(0)
    const socket = new FakeScopeSocket()
    const loads = timedLoads(clock)
    let refresh: ScreenScopeRead | undefined
    await render({
      socket,
      scope: { scope: 'event', gameId: 'g1' },
      clock,
      load: loads.load,
      onRefresh: next => {
        refresh = next as ScreenScopeRead
      }
    })
    socket.ack()
    await loads.finish()
    clock.advance(500)
    socket.deliver({ type: 'resync' })
    socket.ack()
    await loads.finish()
    expect(loads.began).deep.equals([0, 500])
    clock.advance(5000)
    await act(async () => {
      await refresh!.alongside(async () => undefined)
    })
    clock.advance(1000)
    socket.changed()
    await settle()
    expect(loads.began).deep.equals([0, 500])
    await act(async () => {
      clock.advance(2000)
    })
    await loads.finish()
    expect(loads.began).deep.equals([0, 500, 8500])
  })

  it('drops the scope it left, and waits for the new one’s own answer', async function () {
    const socket = new FakeScopeSocket()
    const loaded: string[] = []
    const probe = (gameId: string): Probe => ({
      socket,
      scope: { scope: 'event', gameId },
      load: async () => {
        loaded.push(gameId)
      }
    })
    await render(probe('g1'))
    const left = socket.current()!
    socket.ack()
    await settle()
    expect(loaded).deep.equals(['g1'])
    await render(probe('g2'))
    expect(left.released).equals(true)
    // A notice for the game just left is not heard.
    left.listener({ type: 'changed' })
    await settle()
    expect(loaded).deep.equals(['g1'])
    socket.ack()
    await settle()
    expect(loaded).deep.equals(['g1', 'g2'])
    expect(socket.asked()).deep.equals(['event:g1', 'event:g2'])
  })

  it('asks again with a new load, and does nothing once unmounted', async function () {
    const socket = new FakeScopeSocket()
    const loaded: string[] = []
    let refresh: (() => Promise<void>) | undefined
    const onRefresh = (next: () => Promise<void>): void => {
      refresh = next
    }
    const probe = (name: string): Probe => ({
      socket,
      scope: { scope: 'schedule' },
      onRefresh,
      load: async () => {
        loaded.push(name)
      }
    })
    await render(probe('upcoming'))
    socket.ack()
    await settle()
    await render(probe('past'))
    expect(loaded).deep.equals(['upcoming', 'past'])
    expect(socket.asked()).deep.equals(['schedule'])
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(socket.current()).equals(undefined)
    await refresh?.()
    expect(loaded).deep.equals(['upcoming', 'past'])
  })
})
