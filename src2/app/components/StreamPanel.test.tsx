import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type GameLiveStreams,
  GameStationClient,
  type LiveStatus,
  type LiveStream
} from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { StreamPanel } from './StreamPanel'

let root: Root | undefined
let host: HTMLElement | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The panel's polls and its two short timers, held so a test can run them when
 * it likes: three and fifteen seconds for the polls, two for "Copied", and
 * five for a button that was armed and never pressed again.
 */
function heldTimers(): {
  polls: () => number[]
  poll: () => Promise<void>
  fire: (ms: number) => Promise<void>
  restore: () => void
} {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const intervals = new Map<unknown, { ms: number; callback: () => void }>()
  const timeouts = new Map<unknown, { ms: number; callback: () => void }>()
  let nextId = 0
  globalThis.setInterval = ((
    callback: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms !== 3000 && ms !== 15000)
      return realSetInterval(callback, ms, ...rest)
    const id = { interval: ++nextId }
    intervals.set(id, { ms, callback })
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (id: unknown) => {
    if (intervals.delete(id)) return
    realClearInterval(id as Parameters<typeof clearInterval>[0])
  }
  globalThis.setTimeout = ((
    callback: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms !== 2000 && ms !== 5000) return realSetTimeout(callback, ms, ...rest)
    const id = { timeout: ++nextId }
    timeouts.set(id, { ms, callback })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (id: unknown) => {
    if (timeouts.delete(id)) return
    realClearTimeout(id as Parameters<typeof clearTimeout>[0])
  }
  return {
    polls: () => [...intervals.values()].map(held => held.ms),
    poll: async () => {
      await act(async () => {
        for (const held of [...intervals.values()]) held.callback()
        await delay(10)
      })
    },
    fire: async (ms: number) => {
      await act(async () => {
        for (const [id, held] of [...timeouts.entries()]) {
          if (held.ms !== ms) continue
          timeouts.delete(id)
          held.callback()
        }
        await delay(10)
      })
    },
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  }
}
let timers: ReturnType<typeof heldTimers> | undefined

function camera(
  id: string,
  label: string,
  patch: Partial<LiveStream> = {}
): LiveStream {
  return {
    id,
    gameId: 'gam_1',
    userId: 7,
    ownerName: 'Me Myself',
    slot: 1,
    label,
    keyPrefix: id.slice(-4),
    state: 'idle',
    opensAt: '2026-05-20T16:00:00.000Z',
    closesAt: null,
    videoId: null,
    lastError: null,
    status: null,
    url: undefined,
    ...patch
  }
}

function status(
  id: string,
  ingress: Partial<LiveStatus['ingress']>,
  outputs: LiveStatus['outputs']
): LiveStatus {
  return {
    liveStreamId: id,
    ingress: {
      publishing: false,
      receivingPackets: false,
      bytesReceived: 0,
      bytesPerSecond: 0,
      ...ingress
    },
    outputs
  }
}

interface Request {
  method: string
  path: string
  body?: unknown
}

/**
 * A server that keeps one game's cameras, behind the real client.
 *
 * Every action answers the way the routes do: a URL only in the reply to a
 * request that asked for one, and the panel reloading the list after it.
 */
class FakeServer {
  readonly requests: Request[] = []
  mine: LiveStream[]
  others: LiveStream[]
  maxCameras = 4
  /** Answered to the next request, whatever it is, instead of the list. */
  failNext: { status: number; body: string } | undefined
  /** Held unanswered, for the moment before the list arrives. */
  hang = false

  constructor(mine: LiveStream[] = [], others: LiveStream[] = []) {
    this.mine = mine
    this.others = others
  }

  list(): GameLiveStreams {
    return {
      gameId: 'gam_1',
      mine: this.mine,
      others: this.others,
      canAdd: this.maxCameras - this.mine.length,
      maxCameras: this.maxCameras
    }
  }

  readonly fetch = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const method = init?.method ?? 'GET'
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const path = url.pathname.replace(/^\/api\/v1/, '')
    this.requests.push({ method, path, body })
    if (this.hang) return await new Promise<Response>(() => undefined)
    const failed = this.failNext
    if (failed != null) {
      this.failNext = undefined
      return answer(failed.status, failed.body)
    }
    return answer(200, JSON.stringify(this.route(method, path, body)))
  }

  private route(method: string, path: string, body: unknown): unknown {
    const base = '/games/gam_1/live-streams'
    if (method === 'GET' && path === base) return this.list()
    if (method === 'POST' && path === base) {
      const added = camera(`lst_${this.mine.length + 1}`, 'Camera')
      this.mine = [...this.mine, added]
      return { ...added, url: `rtmp://ingest.example/live/${added.id}-key` }
    }
    const [, id, action] =
      /^\/games\/gam_1\/live-streams\/([^/]+)(?:\/(\w+))?$/.exec(path) ?? []
    const found = this.mine.find(row => row.id === id)
    if (method === 'POST' && action === 'reveal' && found != null)
      return { ...found, url: `rtmp://ingest.example/live/${id}-key` }
    if (method === 'POST' && action === 'rotate' && found != null)
      return { ...found, url: `rtmp://ingest.example/live/${id}-new` }
    if (method === 'POST' && action === 'end') {
      const row = [...this.mine, ...this.others].find(item => item.id === id)
      if (row == null) throw new Error(`No camera ${String(id)}`)
      row.state = 'ended'
      return row
    }
    if (method === 'PATCH' && found != null) {
      found.label = (body as { label: string }).label
      return found
    }
    if (method === 'DELETE' && found != null) {
      this.mine = this.mine.filter(row => row !== found)
      return this.list()
    }
    const video = /^\/videos\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && video != null) {
      for (const row of this.mine)
        if (row.videoId === video[1]) row.videoId = null
      return { id: video[1] }
    }
    throw new Error(`Unrouted ${method} ${path}`)
  }
}

function answer(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  } as unknown as Response
}

async function mount(server: FakeServer): Promise<GameStationClient> {
  const client = new GameStationClient({
    baseUrl: 'https://gamestation.example/api/v1',
    fetch: server.fetch
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <StreamPanel client={client} gameId="gam_1" />
      </ThemeProvider>
    )
    await delay(10)
  })
  return client
}

function text(): string {
  return document.body.textContent ?? ''
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

function buttonsNamed(words: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter(
    node => node.textContent === words
  )
}

function button(words: string, index = 0): HTMLElement {
  const found = buttonsNamed(words)
  expect(found.length, words).greaterThan(index)
  return found[index]
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

function sent(server: FakeServer): string[] {
  return server.requests
    .filter(request => request.method !== 'GET')
    .map(request => `${request.method} ${request.path}`)
}

describe('the stream panel', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host = undefined
    timers?.restore()
    timers = undefined
  })

  it('draws nothing for somebody who does not run the team', async function () {
    const server = new FakeServer()
    server.failNext = {
      status: 404,
      body: JSON.stringify({ code: 'notFound', message: 'Not found' })
    }
    await mount(server)
    expect(server.requests).deep.equals([
      { method: 'GET', path: '/games/gam_1/live-streams', body: undefined }
    ])
    expect(host?.textContent).equals('')
    expect(host?.childElementCount).equals(0)
  })

  it('says it is loading until the cameras arrive', async function () {
    const server = new FakeServer()
    server.hang = true
    await mount(server)
    expect(text()).includes('STREAM TO THIS GAME')
    expect(text()).includes('Loading…')
  })

  it('offers a first stream URL, and shows it whole once made', async function () {
    const server = new FakeServer()
    await mount(server)
    expect(text()).includes('Give yourself a stream URL')
    expect(text()).not.includes('Loading…')
    expect(buttonsNamed('Add a camera')).has.lengthOf(0)

    await press(button('Create a stream URL'))
    expect(sent(server)).deep.equals(['POST /games/gam_1/live-streams'])
    expect(text()).not.includes('Give yourself a stream URL')
    expect(text()).includes('rtmp://ingest.example/live/lst_1-key')
    expect(text()).includes('Tap to copy')
    expect(text()).includes('The whole address goes in your software’s')
    labelled('Copy the URL for Camera')
    // One of four, so there is room for another.
    button('Add a camera')
  })

  it('says what each camera and each of its outputs is doing', async function () {
    const now = Date.now()
    const server = new FakeServer(
      [
        camera('lst_live', 'Home plate', {
          state: 'publishing',
          status: status(
            'lst_live',
            {
              receivingPackets: true,
              publishing: true,
              bytesPerSecond: 425_000
            },
            [
              {
                kind: 'hls',
                label: 'recording',
                state: 'connected',
                bytesWritten: 1,
                bytesPerSecond: 1,
                recordedSec: 3725,
                lastError: undefined,
                restartCount: 0
              },
              {
                kind: 'rtmp',
                label: 'relay one',
                state: 'connected',
                bytesWritten: 1,
                bytesPerSecond: 1,
                recordedSec: 65,
                restartCount: 2,
                lastError: 'timed out'
              },
              {
                kind: 'rtmp',
                label: 'relay two',
                state: 'connected',
                bytesWritten: 1,
                bytesPerSecond: 1,
                lastError: undefined,
                recordedSec: undefined,
                restartCount: 0
              },
              {
                kind: 'rtmp',
                label: 'relay three',
                state: 'connecting',
                bytesWritten: 0,
                bytesPerSecond: 0,
                lastError: undefined,
                recordedSec: undefined,
                restartCount: 0
              }
            ]
          )
        }),
        camera('lst_slow', 'Dugout', {
          status: status(
            'lst_slow',
            { receivingPackets: true, bytesPerSecond: 50_000 },
            []
          )
        }),
        camera('lst_quiet', 'Outfield', {
          closesAt: new Date(now + 3_600_000).toISOString(),
          status: status('lst_quiet', { publishing: true }, [])
        }),
        camera('lst_none', 'Bleachers', {
          state: 'ended',
          closesAt: new Date(now - 60_000).toISOString(),
          status: status('lst_none', {}, []),
          lastError: 'The encoder went away'
        })
      ],
      [
        // Somebody else's, whose window shut without anybody ending it.
        camera('lst_other', 'Scoreboard', {
          userId: 8,
          ownerName: 'Pat Parent',
          closesAt: new Date(now - 60_000).toISOString()
        })
      ]
    )
    await mount(server)

    const page = text()
    expect(page).includes('Home plate')
    expect(page).includes('Live now')
    expect(page).includes('Receiving 3.4 Mbit/s')
    expect(page).includes('GameStation · 1:02:05 recorded')
    expect(page).includes('Relay · 1:05 sent · reconnected 2× · timed out')
    expect(page).includes('Relay · connected')
    expect(page).includes('Relay · connecting')
    expect(page).includes('Receiving 400 kbit/s')
    expect(page).includes('Connected, but no video is arriving')
    expect(page).includes('Nothing is streaming to this yet')
    expect(page).includes('Finished')
    expect(page).includes('Pat Parent · Scoreboard')
    expect(page).includes('Closed')
    expect(page).includes('The encoder went away')
    expect(page.match(/Ready/g)).has.lengthOf(2)
    // The key is never on screen until it is asked for.
    expect(page).includes('••••••••  live…')
    expect(page).includes('Tap to show')
    // All four are used.
    expect(page).includes(
      'That is all 4 of your cameras on this game. End one to add another.'
    )
    expect(buttonsNamed('Add a camera')).has.lengthOf(0)
    // A camera on the air cannot be removed, and an ended one cannot be ended.
    expect(buttonsNamed('Remove camera')).has.lengthOf(3)
    expect(buttonsNamed('End stream')).has.lengthOf(3)
  })

  it('reveals a URL, copies it, and says so for two seconds', async function () {
    timers = heldTimers()
    const copies: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copies.push(value)
        }
      }
    })
    try {
      const server = new FakeServer([camera('lst_1', 'Dugout')])
      await mount(server)
      await press(labelled('Show the URL for Dugout'))
      expect(sent(server)).deep.equals([
        'POST /games/gam_1/live-streams/lst_1/reveal'
      ])
      expect(text()).includes('rtmp://ingest.example/live/lst_1-key')

      await press(labelled('Copy the URL for Dugout'))
      expect(copies).deep.equals(['rtmp://ingest.example/live/lst_1-key'])
      expect(text()).includes('Copied')
      // Copying is not a request.
      expect(sent(server)).has.lengthOf(1)

      await timers.fire(2000)
      expect(text()).not.includes('Copied')
      expect(text()).includes('Tap to copy')
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('shows a camera by the name it is given through the client', async function () {
    timers = heldTimers()
    const server = new FakeServer([camera('lst_1', 'Camera')])
    const client = await mount(server)
    // A camera only waiting is looked at again every fifteen seconds.
    expect(timers.polls()).deep.equals([15000])

    const renamed = await client.updateLiveStream('gam_1', 'lst_1', {
      label: 'Third base'
    })
    expect(renamed.label).equals('Third base')
    expect(server.requests.at(-1)).deep.equals({
      method: 'PATCH',
      path: '/games/gam_1/live-streams/lst_1',
      body: { label: 'Third base' }
    })

    await timers.poll()
    expect(text()).includes('Third base')
    labelled('Show the URL for Third base')
  })

  it('asks twice before a new key cuts off a camera on the air', async function () {
    timers = heldTimers()
    const server = new FakeServer([
      camera('lst_1', 'Home plate', { state: 'publishing' })
    ])
    await mount(server)
    expect(timers.polls()).deep.equals([3000])

    await press(button('New key'))
    expect(sent(server)).deep.equals([])
    expect(text()).includes('Tap again: this cuts it off')

    // Left alone, it goes back to being safe.
    await timers.fire(5000)
    expect(text()).not.includes('Tap again')
    await press(button('New key'))
    await press(button('Tap again: this cuts it off'))
    expect(sent(server)).deep.equals([
      'POST /games/gam_1/live-streams/lst_1/rotate'
    ])
    expect(text()).includes('rtmp://ingest.example/live/lst_1-new')
    button('New key')
  })

  it('makes a new key at once for a camera that is only waiting', async function () {
    const server = new FakeServer([camera('lst_1', 'Dugout')])
    await mount(server)
    await press(button('New key'))
    expect(sent(server)).deep.equals([
      'POST /games/gam_1/live-streams/lst_1/rotate'
    ])
    expect(text()).includes('rtmp://ingest.example/live/lst_1-new')
  })

  it('asks twice before ending a stream on the air, and once otherwise', async function () {
    const server = new FakeServer([
      camera('lst_1', 'Home plate', { state: 'publishing' }),
      camera('lst_2', 'Dugout')
    ])
    await mount(server)
    await press(button('End stream', 0))
    expect(sent(server)).deep.equals([])
    await press(button('Tap again to end it'))
    expect(sent(server)).deep.equals([
      'POST /games/gam_1/live-streams/lst_1/end'
    ])
    expect(text()).includes('Finished')

    await press(button('End stream'))
    expect(sent(server)).deep.equals([
      'POST /games/gam_1/live-streams/lst_1/end',
      'POST /games/gam_1/live-streams/lst_2/end'
    ])
    expect(buttonsNamed('End stream')).has.lengthOf(0)
  })

  it('removes a camera that is not on the air', async function () {
    const server = new FakeServer([
      camera('lst_1', 'Home plate'),
      camera('lst_2', 'Dugout')
    ])
    await mount(server)
    await press(button('Remove camera', 1))
    expect(sent(server)).deep.equals(['DELETE /games/gam_1/live-streams/lst_2'])
    expect(text()).includes('Home plate')
    expect(text()).not.includes('Dugout')
  })

  it('always asks twice before deleting a recording', async function () {
    timers = heldTimers()
    const server = new FakeServer([
      camera('lst_1', 'Dugout', {
        state: 'ended',
        videoId: 'vid_9',
        closesAt: '2026-05-20T18:00:00.000Z'
      })
    ])
    await mount(server)
    // Every window has shut, so there is nothing left to ask about.
    expect(timers.polls()).deep.equals([])

    await press(button('Delete the recording'))
    expect(sent(server)).deep.equals([])
    await press(button('Tap again to delete it'))
    expect(sent(server)).deep.equals(['DELETE /videos/vid_9'])
    expect(buttonsNamed('Delete the recording')).has.lengthOf(0)
  })

  it('names other people’s cameras without their keys, and can end them', async function () {
    const server = new FakeServer(
      [],
      [
        camera('lst_8', 'Bleachers', {
          userId: 8,
          ownerName: 'Pat Parent',
          state: 'publishing'
        }),
        camera('lst_9', 'Left field', {
          userId: 9,
          ownerName: 'Sam Sibling',
          state: 'ended'
        })
      ]
    )
    await mount(server)
    expect(text()).includes('ALSO STREAMING')
    expect(text()).includes('Pat Parent · Bleachers')
    expect(text()).includes('Sam Sibling · Left field')
    expect(text()).not.includes('••••')
    expect(text()).not.includes('rtmp://')
    expect(buttonsNamed('End this stream')).has.lengthOf(1)

    await press(button('End this stream'))
    expect(sent(server)).deep.equals([])
    await press(button('Tap again to end it'))
    expect(sent(server)).deep.equals([
      'POST /games/gam_1/live-streams/lst_8/end'
    ])
    expect(buttonsNamed('End this stream')).has.lengthOf(0)
  })

  it('says what went wrong when an action fails', async function () {
    const server = new FakeServer([camera('lst_1', 'Dugout')])
    await mount(server)
    server.failNext = {
      status: 409,
      body: JSON.stringify({
        code: 'conflict',
        message: 'That camera has already ended'
      })
    }
    await press(button('End stream'))
    expect(text()).includes('That camera has already ended')
    // The next action that works clears it.
    await press(button('New key'))
    expect(text()).not.includes('That camera has already ended')
  })

  it('says it did not work when the failure is not an Error', async function () {
    const server = new FakeServer([camera('lst_1', 'Dugout')])
    const client = await mount(server)
    ;(client as { rotateLiveStream: unknown }).rotateLiveStream = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'refused'
    }
    await press(button('New key'))
    expect(text()).includes('That did not work')
  })

  it('stops asking once it has gone', async function () {
    timers = heldTimers()
    const server = new FakeServer([
      camera('lst_1', 'Home plate', { state: 'publishing' })
    ])
    await mount(server)
    const asked = server.requests.length
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(timers.polls()).deep.equals([])
    expect(server.requests).has.lengthOf(asked)
  })
})
