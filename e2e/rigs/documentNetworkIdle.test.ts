import { EventEmitter } from 'node:events'
import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import type { Page } from 'puppeteer'

import {
  type DocumentNetwork,
  watchDocumentNetwork
} from './documentNetworkIdle'

const origin = 'http://localhost'

class Session extends EventEmitter {
  detached = false

  async send(method: string): Promise<unknown> {
    if (method === 'Network.getCookies')
      return { cookies: [{ name: 'fixture', value: 'session' }] }
  }

  async detach(): Promise<void> {
    if (this.detached) throw new Error('already detached')
    this.detached = true
  }

  async watch(): Promise<DocumentNetwork> {
    return await watchDocumentNetwork({
      createCDPSession: async () => this
    } as unknown as Page)
  }

  navigate(loader: string, id = 'main', parentId?: string): void {
    this.emit('Page.frameNavigated', {
      frame: { id, loaderId: loader, parentId }
    })
  }

  start(
    id: string,
    loader: string,
    options: {
      url?: string
      type?: string
      frame?: string
      method?: string
    } = {}
  ): void {
    this.emit('Network.requestWillBeSent', {
      requestId: id,
      frameId: options.frame,
      loaderId: loader,
      type: options.type ?? 'Fetch',
      request: {
        method: options.method ?? 'GET',
        headers: { accept: 'application/json' },
        url: options.url ?? origin + '/api/v1/chat/blocks?redact=1'
      }
    })
  }

  finish(id: string, failed = false): void {
    this.emit(failed ? 'Network.loadingFailed' : 'Network.loadingFinished', {
      requestId: id
    })
  }
}

describe('network idle for a scoring document', function () {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  })
  afterEach(() => {
    mock.timers.reset()
    mock.restoreAll()
  })

  it('retires an orphan fetch on commit and preserves the incoming document request', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('first')
    session.start('old', 'first', { frame: 'main' })
    session.start('second', 'second', { frame: 'main', type: 'Document' })
    session.start('preload', 'second', { frame: 'main' })
    session.finish('second')
    session.navigate('second')
    session.start('late-old', 'first', { frame: 'main' })
    let quiet = false
    const wait = network.wait(300).then(() => {
      quiet = true
    })
    session.finish('old')
    mock.timers.tick(500)
    await Promise.resolve()
    expect(quiet).equals(false)
    session.finish('preload')
    mock.timers.tick(300)
    await wait
    expect(quiet).equals(true)
    await network.close()
    expect(session.detached).equals(true)
    expect(session.eventNames()).deep.equals([])
  })

  it('ignores late requests carrying a retired loader without a frame ID', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('old')
    session.navigate('child', 'sub', 'main')
    session.start('abandoned', 'abandoned', { frame: 'main', type: 'Document' })
    session.finish('abandoned', true)
    session.navigate('new')
    for (const loader of ['old', 'child', 'abandoned'])
      session.start(loader, loader)
    session.start('live', 'new', { url: origin + '/current' })
    const result = network.wait(300).catch((e: unknown) => (e as Error).message)
    mock.timers.tick(30000)
    expect(await result).equals(
      'The page never settled; still open: GET /current (30000 ms)'
    )
  })

  it('keeps preloads that arrive after the document finishes and before commit', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('original')
    session.start('next', 'next', { frame: 'main', type: 'Document' })
    session.finish('next')
    session.start('style', 'next', {
      frame: 'main',
      url: origin + '/theme.css'
    })
    session.navigate('next')
    const result = network.wait(300).catch((e: unknown) => (e as Error).message)
    mock.timers.tick(30000)
    expect(await result).equals(
      'The page never settled; still open: GET /theme.css (30000 ms)'
    )
  })

  it('retires preloads when the pending navigation is superseded or fails', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('original')
    session.start('abandoned', 'abandoned', { frame: 'main', type: 'Document' })
    session.start('asset', 'abandoned', { frame: 'main' })
    session.start('next', 'next', { frame: 'main', type: 'Document' })
    session.start('style', 'next', { frame: 'main' })
    session.finish('next', true)
    session.start('late', 'next', { frame: 'main' })
    const wait = network.wait(300)
    mock.timers.tick(300)
    await wait
  })

  it('preserves live reads through a fragment change and reports each open request at the deadline', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('same')
    session.start('read', 'same', { frame: 'main' })
    mock.timers.tick(40)
    session.start('other', 'same', { method: 'POST', url: origin + '/save' })
    session.emit('Page.navigatedWithinDocument', { frameId: 'main' })
    session.navigate('same')
    const error = network.wait(500).then(
      () => '',
      (e: unknown) => (e as Error).message
    )
    mock.timers.tick(30000)
    expect(await error).equals(
      'The page never settled; still open: GET /api/v1/chat/blocks (30040 ms), POST /save (30000 ms)'
    )
  })

  it('says when nothing is open but activity never stopped for the quiet period', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('busy')
    const error = network.wait(500).then(
      () => '',
      (e: unknown) => (e as Error).message
    )
    for (let at = 400; at < 30000; at += 400) {
      mock.timers.tick(400)
      session.start(`poll-${at}`, 'busy', { frame: 'main' })
      session.finish(`poll-${at}`)
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    mock.timers.tick(400)
    expect(await error).equals(
      'The page never settled; no request is open, but 500 ms never passed without one (the last ended 400 ms ago)'
    )
  })

  it('restarts quiet for a short burst and leaves a second tab independent', async function () {
    const session = new Session()
    const network = await session.watch()
    const other = new Session()
    const otherNetwork = await other.watch()
    const busy = network.wait(500)
    const idle = otherNetwork.wait(500)
    mock.timers.tick(490)
    session.start('burst', 'a')
    session.finish('burst', true)
    mock.timers.tick(10)
    await idle
    let settled = false
    const completed = busy.then(() => {
      settled = true
    })
    mock.timers.tick(489)
    await Promise.resolve()
    expect(settled).equals(false)
    mock.timers.tick(1)
    await completed
  })

  it('forgets a child frame’s old reads on navigation or detachment', async function () {
    const session = new Session()
    const network = await session.watch()
    session.navigate('one')
    session.navigate('child1', 'sub', 'main')
    session.start('a', 'child1', { frame: 'sub' })
    session.start('b', 'one', { frame: 'main' })
    session.navigate('child2', 'sub', 'main')
    session.start('c', 'child2')
    session.emit('Page.frameDetached', { frameId: 'sub' })
    session.start('late-child', 'child1')
    session.start('late-detached', 'child2')
    const wait = network.wait(300).catch((e: unknown) => (e as Error).message)
    mock.timers.tick(30000)
    expect(await wait).equals(
      'The page never settled; still open: GET /api/v1/chat/blocks (30000 ms)'
    )
  })

  it('retries API reads only on the configured app and fixture origins', async function () {
    const session = new Session()
    const network = await session.watch()
    session.start('success', 'one')
    const api = origin + ':9180'
    session.start('failure', 'one', { url: api + '/api/failed' })
    session.start('asset', 'one', { url: origin + '/asset' })
    session.start('external', 'one', { url: 'https://example.test/api/read' })
    session.start('write', 'one', { method: 'POST' })
    const budget = mock.method(AbortSignal, 'timeout')
    const readCookies = session.send.bind(session)
    mock.method(session, 'send', async (method: string) => {
      // The HTTP retry's clock is already running during cookie lookup.
      expect(budget.mock.callCount()).greaterThan(0)
      return await readCookies(method)
    })
    const retry = mock.method(
      globalThis,
      'fetch',
      async (url: URL, init: RequestInit) => {
        expect(new Headers(init.headers).get('accept')).equals(
          'application/json'
        )
        expect(new Headers(init.headers).get('cookie')).equals(
          'fixture=session'
        )
        expect(budget.mock.calls.map(call => call.result)).includes(init.signal)
        expect(init.redirect).equals('error')
        if (url.pathname.endsWith('/failed')) throw new Error('unreachable')
        return new Response('{}')
      }
    )
    const error = network.wait(500, [origin, api]).then(
      () => '',
      (e: unknown) => (e as Error).message
    )
    mock.timers.tick(30000)
    const message = await error
    expect(retry.mock.callCount()).equals(2)
    expect(message).includes('/api/v1/chat/blocks (30000 ms), retry 200')
    expect(message).includes('/api/failed (30000 ms), retry failed')
    expect(message).not.includes('redact')
  })

  it('keeps the pending request detail if the cookie lookup times out', async function () {
    const session = new Session()
    const network = await session.watch()
    const lookup = mock.method(
      session,
      'send',
      async (_method: string, _params: unknown, options: { timeout: number }) =>
        await new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('cookie timeout'))
          }, options.timeout)
        })
    )
    const fetch = mock.method(globalThis, 'fetch', async () => new Response())
    session.start('slow', 'one')
    const error = network
      .wait(500, [origin])
      .catch((e: unknown) => (e as Error).message)
    mock.timers.tick(30000)
    await Promise.resolve()
    expect(lookup.mock.calls[0].arguments[2]).deep.equals({ timeout: 10000 })
    mock.timers.tick(10000)
    expect(await error).equals(
      'The page never settled; still open: GET /api/v1/chat/blocks (30000 ms), retry failed after 10000 ms'
    )
    expect(fetch.mock.callCount()).equals(0)
  })

  it('closes the watcher when the target already closed or closes during detach', async function () {
    const session = new Session()
    const network = await session.watch()
    const detach = mock.method(session, 'detach', async () => {
      session.detached = true
      throw new Error('target closed')
    })
    await network.close()
    await network.close()
    expect(detach.mock.callCount()).equals(1)
    expect(session.eventNames()).deep.equals([])
  })

  it('reports unexpected detach failures', async function () {
    const session = new Session()
    const network = await session.watch()
    mock.method(session, 'detach', async () => {
      throw new Error('detach failed')
    })
    const error = await network
      .close()
      .catch((e: unknown) => (e as Error).message)
    expect(error).equals('detach failed')
  })

  it('detaches if observation cannot start', async function () {
    const session = new Session()
    session.send = async () => {
      throw new Error('disconnected')
    }
    const error = await session.watch().then(
      () => '',
      (e: unknown) => (e as Error).message
    )
    expect(error).equals('disconnected')
    expect(session.detached).equals(true)
  })
})
