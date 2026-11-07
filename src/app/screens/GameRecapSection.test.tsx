import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { type GameDetail, TeamStationClient } from '../../common/api'
import type { GameRecap } from '../../common/gameRecap'
import { FakeScopeSocket, testClock } from '../../test/fakeScreenScope'
import type { PinnedHead } from '../components/pinnedHead'
import { SceneShownProvider } from '../components/sceneShown'
import { ScreenScopeProvider } from '../hooks/useScreenScope'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameRecapSection, RecapPlayer } from './GameRecapSection'

let root: Root | undefined
const pinned: PinnedHead = {
  screen: { onScroll: () => undefined },
  cardBand: { style: {} },
  pillBand: { style: {} },
  content: {},
  nextRow: {},
  rowSection: {},
  spacer: { style: {} },
  select: () => undefined
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function render(content: React.ReactNode): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{content}</ThemeProvider>)
  })
}
function setup(value: GameRecap): {
  client: TeamStationClient
  game: Pick<GameDetail, 'id' | 'nonMemberView'>
  section: (
    game?: Pick<GameDetail, 'id' | 'nonMemberView'>
  ) => React.ReactElement
  reads: () => number
} {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  let reads = 0
  client.gameRecap = async () => {
    reads++
    return value
  }
  const game = { id: 'g1', nonMemberView: false }
  const section = (selectedGame = game): React.ReactElement => (
    <GameRecapSection
      client={client}
      game={selectedGame}
      pinned={pinned}
      head={<Text>Score</Text>}
      tabs={<Text>Recap</Text>}
      membership={<Text>Membership required</Text>}
    />
  )
  return { client, game, section, reads: () => reads }
}
describe('Game recap article', () => {
  it('waits without polling, then displays the recap on a socket notice and rereads after reconnect', async () => {
    const f = setup({ status: 'pending', document: null, clips: {} })
    const socket = new FakeScopeSocket()
    const clock = testClock()
    let reads = 0
    f.client.gameRecap = async () => {
      reads++
      return reads === 1
        ? { status: 'pending', document: null, clips: {} }
        : {
            status: 'ready',
            clips: {},
            document: {
              headline: 'Owls win',
              dateLine: 'January 1',
              paragraphs: []
            }
          }
    }
    await render(
      <ScreenScopeProvider
        socket={socket}
        scope={{ scope: 'event', gameId: 'g1' }}
        timers={clock}
      >
        {f.section()}
      </ScreenScopeProvider>
    )
    await act(async () => {
      socket.ack()
    })
    expect(reads).equals(1)
    expect(document.body.textContent).contains('waiting for recap')
    expect(document.querySelector('[role="progressbar"]')).not.equals(null)
    await act(async () => {
      clock.advance(60000)
    })
    expect(reads).equals(1)
    await act(async () => {
      socket.changed('g1')
    })
    expect(reads).equals(2)
    expect(document.body.textContent).contains('Owls win')
    expect(document.body.textContent).not.contains('waiting for recap')
    await act(async () => {
      socket.deliver({ type: 'resync' })
      socket.ack()
    })
    expect(reads).equals(3)
  })
  it('shows pending, absent, failed and request-failure states', async () => {
    for (const [status, text] of [
      ['pending', 'waiting for recap'],
      ['absent', 'No recap'],
      ['failed', 'could not']
    ] as const) {
      const f = setup({ status, document: null, clips: {} })
      await render(f.section())
      expect(document.body.textContent).contains(text)
    }
    const f = setup({ status: 'absent', document: null, clips: {} })
    f.client.gameRecap = async () => {
      throw new Error('offline')
    }
    await render(f.section())
    expect(document.body.textContent).contains('could not')
  })
  it('does not request protected text for a nonmember or hidden scene', async () => {
    const f = setup({ status: 'pending', document: null, clips: {} })
    f.game.nonMemberView = true
    await render(f.section())
    expect(document.body.textContent).contains('Membership required')
    expect(f.reads()).equals(0)
    f.game.nonMemberView = false
    await render(
      <SceneShownProvider value={false}>{f.section()}</SceneShownProvider>
    )
    expect(f.reads()).equals(0)
  })
  it('links only a single play with video and replaces the selected clip', async () => {
    const f = setup({
      status: 'ready',
      document: {
        headline: 'Hawks win 4–2',
        dateLine: 'January 1',
        paragraphs: [
          [
            { text: 'First hit.', kind: 'play', plays: [1] },
            { text: 'Second hit.', kind: 'play', plays: [2] },
            { text: 'Two hits.', kind: 'play', plays: [1, 2] },
            { text: 'Four runs.', kind: 'totals', plays: [1] },
            { text: 'No recording.', kind: 'play', plays: [3] }
          ]
        ]
      },
      clips: {
        '1': { videoId: 'v1', start: 2, end: 7 },
        '2': { videoId: 'v2', start: 8, end: 12 }
      }
    })
    const requested: string[] = []
    f.client.playback = async id => {
      requested.push(id)
      throw new Error('unavailable')
    }
    await render(f.section())
    const links = document.querySelectorAll<HTMLElement>('[role="link"]')
    expect(links.length).equals(2)
    expect(document.querySelector('[data-testid="recapPlayer"]')).equals(null)
    await act(async () => {
      links[0].click()
    })
    expect(
      document.querySelector('[data-testid="recapPinnedBand"] video')
    ).not.equals(null)
    await render(f.section({ ...f.game }))
    expect(document.querySelector('video')).not.equals(null)
    expect(requested).deep.equals(['v1'])
    await act(async () => {
      links[1].click()
    })
    expect(requested).deep.equals(['v1', 'v2'])
    expect(document.querySelectorAll('video').length).equals(1)
  })
  it('ignores an article response after navigation', async () => {
    const f = setup({ status: 'pending', document: null, clips: {} })
    let finish!: (v: GameRecap) => void
    f.client.gameRecap = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    await render(f.section())
    await render(<div>Other screen</div>)
    await act(async () => {
      finish({ status: 'failed', document: null, clips: {} })
    })
    expect(document.body.textContent).equals('Other screen')
  })
})
describe('Recap player request lifecycle', () => {
  it('seeks at readiness, stops at the clip boundary and tears down listeners', async () => {
    const proto = window.HTMLMediaElement.prototype
    const names = ['canPlayType', 'play', 'pause', 'load'] as const
    const saved = names.map(name =>
      Object.getOwnPropertyDescriptor(proto, name)!
    )
    const vendor = Object.getOwnPropertyDescriptor(navigator, 'vendor')
    let plays = 0
    let pauses = 0
    let paused = true
    Object.defineProperty(navigator, 'vendor', {
      configurable: true,
      value: 'Apple Computer, Inc.'
    })
    Object.defineProperties(proto, {
      canPlayType: { configurable: true, value: () => 'probably' },
      play: {
        configurable: true,
        value: async () => {
          plays++
          paused = false
        }
      },
      pause: {
        configurable: true,
        value: () => {
          pauses++
          paused = true
        }
      },
      load: { configurable: true, value: () => undefined }
    })
    try {
      const client = new TeamStationClient({ baseUrl: '/api/v1' })
      client.playback = async videoId => ({
        videoId,
        storage: 'spaces',
        expiresAt: null,
        durationSec: 20,
        unavailable: false,
        url: '/clip.m3u8'
      })
      await render(
        <RecapPlayer
          client={client}
          clip={{ videoId: 'v1', start: 5, end: 10 }}
        />
      )
      const video = document.querySelector('video')!
      let currentTime = 0
      let seeks = 0
      Object.defineProperties(video, {
        paused: { configurable: true, get: () => paused },
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => {
            currentTime = value
            seeks++
            // A completed real-media seek emits timeupdate, even while paused.
            if (seeks < 100)
              queueMicrotask(() =>
                video.dispatchEvent(new window.Event('timeupdate'))
              )
          }
        }
      })
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: 1
      })
      await act(async () =>
        video.dispatchEvent(new window.Event('loadedmetadata'))
      )
      expect(video.currentTime).equals(5)
      expect(plays).equals(1)
      await act(async () => video.dispatchEvent(new window.Event('canplay')))
      expect(plays).equals(1)
      video.currentTime = 11
      await act(async () => video.dispatchEvent(new window.Event('timeupdate')))
      expect(video.currentTime).equals(10)
      expect(seeks).equals(3)
      expect(pauses).greaterThan(0)
      await act(async () => video.dispatchEvent(new window.Event('error')))
      expect(document.body.textContent).contains('not available')
      await render(<div>Gone</div>)
      video.currentTime = 15
      video.dispatchEvent(new window.Event('timeupdate'))
      expect(video.currentTime).equals(15)
    } finally {
      names.forEach((name, i) => Object.defineProperty(proto, name, saved[i]))
      if (vendor != null) Object.defineProperty(navigator, 'vendor', vendor)
      else Reflect.deleteProperty(navigator, 'vendor')
    }
  })
  it('retries a policy refusal muted and reports genuine playback failures', async () => {
    const proto = window.HTMLMediaElement.prototype
    const names = ['canPlayType', 'play', 'pause', 'load'] as const
    const saved = names.map(name =>
      Object.getOwnPropertyDescriptor(proto, name)!
    )
    const vendor = Object.getOwnPropertyDescriptor(navigator, 'vendor')
    Object.defineProperty(navigator, 'vendor', {
      configurable: true,
      value: 'Apple Computer, Inc.'
    })
    try {
      for (const mode of ['fallback', 'blocked', 'broken', 'stale'] as const) {
        let plays = 0
        let rejectPlay!: (error: Error) => void
        Object.defineProperties(proto, {
          canPlayType: { configurable: true, value: () => 'probably' },
          pause: { configurable: true, value: () => undefined },
          load: { configurable: true, value: () => undefined },
          play: {
            configurable: true,
            value: async function (this: HTMLMediaElement) {
              plays++
              if (mode === 'stale') {
                await new Promise<void>((_resolve, reject) => {
                  rejectPlay = reject
                })
                return
              }
              if (mode === 'fallback' && this.muted) return
              const error = new Error('Cannot play')
              error.name =
                mode === 'broken' ? 'NotSupportedError' : 'NotAllowedError'
              throw error
            }
          }
        })
        const client = new TeamStationClient({ baseUrl: '/api/v1' })
        client.playback = async videoId => ({
          videoId,
          storage: 'spaces',
          expiresAt: null,
          durationSec: 20,
          unavailable: false,
          url: '/clip.m3u8'
        })
        await render(
          <RecapPlayer
            key={mode}
            client={client}
            clip={{ videoId: mode, start: 2, end: 5 }}
          />
        )
        const video = document.querySelector('video')!
        Object.defineProperty(video, 'readyState', {
          configurable: true,
          value: 1
        })
        await act(async () =>
          video.dispatchEvent(new window.Event('loadedmetadata'))
        )
        if (mode === 'stale') {
          await render(<div>Gone</div>)
          await act(async () => {
            rejectPlay(
              Object.assign(new Error('late'), { name: 'NotAllowedError' })
            )
          })
          expect(plays).equals(1)
          expect(document.body.textContent).equals('Gone')
        } else {
          expect(plays).equals(mode === 'broken' ? 1 : 2)
          expect(video.muted).equals(mode !== 'broken')
          expect(document.body.textContent!.includes('not available')).equals(
            mode !== 'fallback'
          )
        }
      }
    } finally {
      names.forEach((name, i) => Object.defineProperty(proto, name, saved[i]))
      if (vendor != null) Object.defineProperty(navigator, 'vendor', vendor)
      else Reflect.deleteProperty(navigator, 'vendor')
    }
  })
  it('waits for pending publication with bounded backoff and cancels superseded retries', async () => {
    const setTimer = globalThis.setTimeout
    const clearTimer = globalThis.clearTimeout
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
    const delays: number[] = []
    globalThis.setTimeout = ((
      run: () => void,
      delay: number
    ): ReturnType<typeof setTimeout> => {
      if (delay < 2000 || delay > 30000) return setTimer(run, delay)
      const handle = { run } as unknown as ReturnType<typeof setTimeout>
      timers.set(handle, run)
      delays.push(delay)
      return handle
    }) as typeof setTimeout
    globalThis.clearTimeout = ((
      handle: ReturnType<typeof setTimeout>
    ): void => {
      if (!timers.delete(handle)) clearTimer(handle)
    }) as typeof clearTimeout
    const advance = async (): Promise<void> => {
      const [handle, run] = timers.entries().next().value!
      timers.delete(handle)
      await act(async () => {
        run()
      })
    }
    try {
      const client = new TeamStationClient({ baseUrl: '/api/v1' })
      const pending = {
        storage: 'spaces' as const,
        expiresAt: null,
        durationSec: 20,
        unavailable: true,
        pending: true,
        url: null
      }
      let asks = 0
      client.playback = async videoId => {
        asks++
        if (asks === 1) return { ...pending, videoId }
        if (asks === 2) throw new Error('temporary network failure')
        return {
          ...pending,
          videoId,
          pending: false,
          unavailable: false,
          url: '/published.m3u8'
        }
      }
      await render(
        <RecapPlayer
          client={client}
          clip={{ videoId: 'publishing', start: 2, end: 5 }}
        />
      )
      expect(document.body.textContent).not.contains('not available')
      await advance()
      expect(document.body.textContent).not.contains('not available')
      await advance()
      expect(asks).equals(3)
      expect(delays.slice(0, 2)).deep.equals([2000, 4000])
      await render(<div>Gone</div>)
      const requested: string[] = []
      client.playback = async videoId => {
        requested.push(videoId)
        return { ...pending, videoId }
      }
      await render(
        <RecapPlayer
          client={client}
          clip={{ videoId: 'old', start: 2, end: 5 }}
        />
      )
      expect(timers.size).equals(1)
      await render(
        <RecapPlayer
          client={client}
          clip={{ videoId: 'new', start: 2, end: 5 }}
        />
      )
      expect(timers.size).equals(1)
      await advance()
      expect(requested).deep.equals(['old', 'new', 'new'])
      await render(<div>Gone</div>)
      expect(timers.size).equals(0)
      requested.length = 0
      await render(
        <RecapPlayer
          client={client}
          clip={{ videoId: 'never-published', start: 2, end: 5 }}
        />
      )
      for (let n = 0; timers.size > 0 && n < 40; n++) await advance()
      expect(timers.size).equals(0)
      expect(requested.length).lessThan(40)
      expect(document.body.textContent).contains('not available')
    } finally {
      globalThis.setTimeout = setTimer
      globalThis.clearTimeout = clearTimer
    }
  })
  it('reports unavailable media and ignores a superseded playback address', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    let finish!: (v: Awaited<ReturnType<TeamStationClient['playback']>>) => void
    client.playback = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    await render(
      <RecapPlayer
        client={client}
        clip={{ videoId: 'old', start: 1, end: 4 }}
      />
    )
    const old = finish
    client.playback = async () => ({
      videoId: 'new',
      storage: 'spaces',
      expiresAt: null,
      durationSec: 10,
      unavailable: true,
      url: null
    })
    await render(
      <RecapPlayer
        client={client}
        clip={{ videoId: 'new', start: 5, end: 8 }}
      />
    )
    await act(async () => {
      old({
        videoId: 'old',
        storage: 'spaces',
        expiresAt: null,
        durationSec: 10,
        unavailable: false,
        url: '/old.m3u8'
      })
    })
    expect(document.querySelector('video')?.getAttribute('src')).equals(null)
    expect(document.body.textContent).contains('not available')
  })
})
