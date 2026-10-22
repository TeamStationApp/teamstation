import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  ScreenScope,
  ScreenScopeEvent,
  ScreenScopeListener
} from '../../common/gameSocket'
import { ACK_GIVE_UP_MS } from '../../common/screenScope'
import {
  FakeScopeSocket,
  heldTimers,
  revisionStamps
} from '../../test/fakeScreenScope'
import {
  screenScopeKey,
  ScreenScopeProvider,
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
    socket.ack('4')
    const releaseSecond = shared.subscribeScope({ scope: 'home' }, event =>
      second.push(event)
    )
    // The answer reaches a load that joins late, after the call returns.
    expect(second).deep.equals([])
    await Promise.resolve()
    expect(second).deep.equals([{ type: 'subscribed', revision: '4' }])
    socket.changed('5')
    expect(first.at(-1)).deep.equals({ type: 'changed', revision: '5' })
    expect(second.at(-1)).deep.equals({ type: 'changed', revision: '5' })
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
    socket.ack('2')
    expect(home).deep.equals([])
    expect(event).deep.equals([{ type: 'subscribed', revision: '2' }])
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
    socket.ack('1')
    socket.deliver({ type: 'resync' })
    const late: ScreenScopeEvent[] = []
    shared.subscribeScope({ scope: 'schedule' }, heard => late.push(heard))
    await Promise.resolve()
    expect(late).deep.equals([])
    socket.ack('3')
    expect(late).deep.equals([{ type: 'subscribed', revision: '3' }])
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
    client?: ReturnType<typeof revisionStamps>
    /** Called, as a screen's existing load would be. */
    load: () => Promise<void>
    /** Handed the function the hook returns. */
    onRefresh?: (refresh: () => Promise<void>) => void
  }

  function Loader(props: Probe): null {
    const refresh = useScreenScope(props.load, props.client)
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
        <ScreenScopeProvider socket={probe.socket} scope={probe.scope}>
          <Loader {...probe} />
        </ScreenScopeProvider>
      )
    })
    await settle()
  }

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
    socket.ack('7')
    await settle()
    expect(log).deep.equals(['subscribe home', 'subscribed 7', 'load'])
  })

  it('reads at once while offline, and with no socket', async function () {
    const client = revisionStamps()
    client.offline = true
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
    socket.ack('2')
    await settle()
    expect(loads).equals(2)
  })

  it('reads again for a notice newer than what it read, and not for an older one', async function () {
    const client = revisionStamps()
    client.revisions.set('/teams', '5')
    const socket = new FakeScopeSocket()
    let loads = 0
    await render({
      socket,
      scope: { scope: 'home' },
      client,
      load: async () => {
        loads++
        client.answer('/teams')
      }
    })
    socket.ack('5')
    await settle()
    expect(loads).equals(1)
    socket.changed('4')
    socket.changed('5')
    await settle()
    expect(loads).equals(1)
    client.revisions.set('/teams', '6')
    socket.changed('6')
    await settle()
    expect(loads).equals(2)
    socket.changed('6')
    await settle()
    expect(loads).equals(2)
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
    socket.ack('1')
    await settle()
    expect(loaded).deep.equals(['g1'])
    await render(probe('g2'))
    expect(left.released).equals(true)
    // A notice for the game just left is not heard.
    left.listener({ type: 'changed', revision: '9' })
    await settle()
    expect(loaded).deep.equals(['g1'])
    socket.ack('2')
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
    socket.ack('1')
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
