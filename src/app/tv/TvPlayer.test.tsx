import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  AccessibilityInfo,
  BackHandler,
  LayoutAnimation,
  Platform
} from 'react-native'

import { asVideoGame, type TeamStationClient } from '../../common/api'
import { nativeStatistics } from '../../test/gameStatisticsFixture'
import { boardStep, SHOWN_OVERLAY } from '../../test/overlayFixtures'
import { replayContext, scored } from '../../test/replayGameFixture'
import { windowSize } from '../../test/tessTestKit'
import {
  emitTvDirection,
  emitTvPan,
  panRequests
} from '../../test/tvRemoteRuntime'
import { timelineFor } from './playbackTimeline'
import { TvPlayer } from './TvPlayer'

const game = asVideoGame({
  id: 'game',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeTeamName: 'Hosts',
  awayTeamName: 'Visitors',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'final',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'ok',
  videoCount: 4,
  latestVideoId: 'video',
  latestVideoAt: '2026-10-01T00:00:00Z'
})
let root: Root | undefined
let viewport: Awaited<ReturnType<typeof windowSize>> | undefined
let remoteBack: (() => boolean | null | undefined) | undefined
const originalBack = BackHandler.addEventListener.bind(BackHandler)
let lineOnly = false
let wide = false
let count = 4
let fail = false
let pending = false
let live = false
let mixed = false
let closed = false
const client = {
  game: async () => {
    if (fail) throw new Error('Game unavailable')
    return {
      ...game,
      awayTeamId: replayContext().teams.away.id,
      homeTeamId: replayContext().teams.home.id,
      videos: [
        ...Array.from({ length: count }, (_, i) => ({
          id: String(i),
          title: `Angle ${i}`,
          numCameras: 1,
          status: live ? 'live' : 'ready'
        })),
        { id: 'mosaic', title: 'Mosaic', numCameras: 4, status: 'ready' },
        {
          id: 'processing',
          title: 'Processing',
          numCameras: 1,
          status: 'processing'
        }
      ]
    }
  },
  scoreboardOverlay: async () => SHOWN_OVERLAY,
  wallTimeline: async () => ({ ...timelineFor('2026-10-01T00:00:00Z'), live }),
  gameStatistics: async () => {
    const data = nativeStatistics(
      await client.game('game'),
      await client.gameEvents('game')
    )
    if (lineOnly) {
      data.initial = null
      data.boxes = [
        {
          at: 0,
          position: null,
          box: null,
          message: 'Player statistics are incomplete in the recorded plays.'
        }
      ]
      data.line.teams = { away: 'Recorded Visitors', home: 'Recorded Hosts' }
      data.line.steps = [
        {
          at: 0,
          line: {
            away: { innings: [2], r: 2, h: null, e: null },
            home: { innings: [1], r: 1, h: null, e: null }
          }
        }
      ]
    }
    return data
  },
  lineScore: async () => {
    throw new Error('TV must use replay state')
  },
  gameEvents: async () =>
    wide
      ? await scored(
          Array.from({ length: 48 }, () => ({
            type: 'gameFlow' as const,
            kind: 'endHalf' as const
          }))
        )
      : { plays: [], currentPlay: null },
  tvHighlights: async () => [
    {
      eventId: 'clip',
      title: 'Home run',
      startOffsetSec: 5,
      playOffsetSec: 6,
      endOffsetSec: 8,
      stillUrl: 'https://example.test/still.jpg'
    },
    {
      eventId: 'second',
      title: 'Strikeout',
      startOffsetSec: 10,
      playOffsetSec: 11,
      endOffsetSec: 13,
      stillUrl: null
    }
  ],
  playback: async (id: string) => {
    if (mixed && id === '0') throw new Error('Camera unavailable')
    return {
      url:
        pending || (mixed && id === '1')
          ? null
          : `https://example.test/${id}.mp4`
    }
  }
} as unknown as TeamStationClient
const pause = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20))
}
const mediaPrototype = window.HTMLMediaElement.prototype
// Preserve the original methods for restoration, never invoke them unbound.
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalPlay = mediaPrototype.play
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalPause = mediaPrototype.pause
async function render(): Promise<void> {
  mediaPrototype.play = async function () {
    Object.defineProperty(this, 'paused', { value: false, configurable: true })
  }
  mediaPrototype.pause = function () {
    Object.defineProperty(this, 'paused', { value: true, configurable: true })
  }
  BackHandler.addEventListener = (_event, handler) => {
    remoteBack = () =>
      handler({ type: 'hardwareBackPress', timeStamp: Date.now() })
    return {
      remove() {
        remoteBack = undefined
      }
    }
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <TvPlayer
        client={client}
        request={{ game }}
        onClose={() => {
          closed = true
        }}
      />
    )
    await pause()
  })
}
async function press(label: string): Promise<void> {
  if (['Close panel', 'Back to cameras', 'Back to games'].includes(label)) {
    await act(async () => {
      remoteBack?.()
      await pause()
    })
    return
  }
  const direction = {
    Highlights: 'swipeRight',
    Cameras: 'swipeLeft',
    'Box score': 'swipeDown',
    'Team and player statistics': 'down',
    Pause: 'playPause',
    Play: 'playPause',
    '−10 seconds': 'left',
    '+10 seconds': 'right'
  }[label]
  if (direction !== undefined) {
    if (label === 'Team and player statistics') {
      await act(async () => {
        emitTvDirection('down')
        await pause()
      })
      return
    }
    const index =
      label === 'Highlights'
        ? Math.min(count - 1, 1)
        : label === 'Box score'
          ? count - 1
          : 0
    if (direction.startsWith('swipe')) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 2100))
      })
    }
    await act(async () => {
      document
        .querySelector<HTMLElement>(`[data-testid="tv-angle-${index}"]`)
        ?.blur()
      document
        .querySelector<HTMLElement>(`[data-testid="tv-angle-${index}"]`)
        ?.focus()
      await pause()
    })
    await act(async () => {
      if (direction.startsWith('swipe'))
        await new Promise(resolve => setTimeout(resolve, 120))
      emitTvDirection(direction)
      await pause()
    })
    return
  }
  const target = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(target, label).not.equals(null)
  await act(async () => {
    target!.click()
    await pause()
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  mediaPrototype.play = originalPlay
  mediaPrototype.pause = originalPause
  document.body.innerHTML = ''
  BackHandler.addEventListener = originalBack
  root = undefined
  await viewport?.restore()
  viewport = undefined
  count = 4
  lineOnly = false
  wide = false
  mixed = false
  fail = false
  pending = false
  live = false
  closed = false
})
describe('TV game playback entry', () => {
  it('allows a slow initial decoder to open before its bounded retry', async () => {
    count = 1
    const originalInterval = globalThis.setInterval
    const originalNow = Date.now
    let now = originalNow()
    let recover: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      if (delay === 1000) recover = callback
      return originalInterval(callback, delay)
    }) as typeof setInterval
    Date.now = () => now
    try {
      await render()
      const initial = document.querySelector('video')!
      for (let second = 0; second < 24; second++) {
        now += 1000
        await act(async () => {
          recover!()
          await pause()
        })
        expect(
          document.querySelector('video'),
          'initial opening decoder survives'
        ).equals(initial)
      }
      now += 6001
      await act(async () => {
        recover!()
        await pause()
      })
      expect(
        document.querySelector('video'),
        'never-opening initial decoder retries'
      ).not.equals(initial)
    } finally {
      globalThis.setInterval = originalInterval
      Date.now = originalNow
    }
  })
  it('retries after stale error progress and lets the replacement finish opening', async () => {
    count = 1
    const originalInterval = globalThis.setInterval
    const originalNow = Date.now
    let now = originalNow()
    let recover: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      if (delay === 1000) recover = callback
      return originalInterval(callback, delay)
    }) as typeof setInterval
    Date.now = () => now
    try {
      await render()
      const before = document.querySelector('video')!
      await act(async () => {
        Object.defineProperty(before, 'duration', {
          value: 100,
          configurable: true
        })
        before.dispatchEvent(new window.Event('durationchange'))
        await pause()
        before.dispatchEvent(new window.Event('seeked'))
        before.dispatchEvent(new window.Event('timeupdate'))
        for (const seconds of [10, 11]) {
          before.currentTime = seconds
          before.dispatchEvent(new window.Event('timeupdate'))
        }
        Object.defineProperty(before, 'error', {
          value: { code: 2 },
          configurable: true
        })
        before.dispatchEvent(new window.Event('error', { bubbles: true }))
        before.currentTime = 11.25
        before.dispatchEvent(new window.Event('timeupdate'))
        await pause()
      })
      now += 1001
      await act(async () => {
        recover!()
        await pause()
      })
      expect(
        document.querySelector('video'),
        'failed decoder is replaced'
      ).not.equals(before)
      const replacement = document.querySelector('video')!
      for (let second = 0; second < 24; second++) {
        now += 1000
        await act(async () => {
          recover!()
          await pause()
        })
        expect(
          document.querySelector('video'),
          'opening decoder survives'
        ).equals(replacement)
      }
      // A decoder that never opens must still get another bounded attempt.
      now += 6000
      await act(async () => {
        recover!()
        await pause()
      })
      expect(document.querySelector('video')).not.equals(replacement)
    } finally {
      globalThis.setInterval = originalInterval
      Date.now = originalNow
    }
  })
  it('automatically replaces only the failed camera and refreshes a live archive source', async () => {
    live = true
    count = 2
    const originalInterval = globalThis.setInterval
    const originalNow = Date.now
    let now = originalNow()
    let recover: (() => void) | undefined
    let poll: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      if (delay === 1000) recover = callback
      if (delay === 10000) poll = callback
      return originalInterval(callback, delay)
    }) as typeof setInterval
    Date.now = () => now
    try {
      await render()
      const before = [...document.querySelectorAll('video')]
      await act(async () => {
        for (const video of before) {
          Object.defineProperty(video, 'duration', {
            value: 100,
            configurable: true
          })
          video.dispatchEvent(new window.Event('durationchange'))
        }
        await pause()
        for (const video of before) {
          video.dispatchEvent(new window.Event('seeked'))
          video.dispatchEvent(new window.Event('timeupdate'))
          video.currentTime = 1
          video.dispatchEvent(new window.Event('timeupdate'))
          video.currentTime = 2
          video.dispatchEvent(new window.Event('timeupdate'))
        }
        before[0].dispatchEvent(new window.Event('ended'))
        before[0].dispatchEvent(new window.Event('timeupdate'))
        Object.defineProperty(before[0], 'error', {
          configurable: true,
          value: { code: 2 }
        })
        before[0].dispatchEvent(new window.Event('error', { bubbles: true }))
        await pause()
      })
      now += 1001
      await act(async () => {
        recover!()
        await pause()
      })
      const retried = [...document.querySelectorAll('video')]
      expect(retried[0]).not.equals(before[0])
      expect(retried[1]).equals(before[1])
      live = false
      await act(async () => {
        poll!()
        await pause()
        await pause()
      })
      const archived = [...document.querySelectorAll('video')]
      expect(archived[0]).not.equals(retried[0])
      expect(archived[1]).not.equals(retried[1])
      await act(async () => {
        poll!()
        await pause()
      })
      expect(document.querySelectorAll('video')[0]).equals(archived[0])
      await press('Pause')
      await act(async () => {
        for (const video of archived) {
          Object.defineProperty(video, 'duration', {
            value: 100,
            configurable: true
          })
          video.dispatchEvent(new window.Event('durationchange'))
        }
        await pause()
      })
      now += 30000
      await act(async () => {
        recover!()
        await pause()
      })
      expect(
        document.querySelectorAll('video')[0],
        'a loaded pause is not a silent stall'
      ).equals(archived[0])
    } finally {
      globalThis.setInterval = originalInterval
      Date.now = originalNow
    }
  })
  it('abandons an unacknowledged seek when replacing a failed source', async () => {
    count = 2
    const originalInterval = globalThis.setInterval
    const originalNow = Date.now
    let now = originalNow()
    let recover: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      if (delay === 1000) recover = callback
      return originalInterval(callback, delay)
    }) as typeof setInterval
    Date.now = () => now
    const load = (video: HTMLVideoElement): void => {
      Object.defineProperty(video, 'duration', {
        value: 100,
        configurable: true
      })
      video.dispatchEvent(new window.Event('durationchange', { bubbles: true }))
    }
    try {
      await render()
      const before = [...document.querySelectorAll('video')]
      await act(async () => {
        before.forEach(load)
        await pause()
        before.forEach(video => video.dispatchEvent(new window.Event('seeked')))
      })
      await press('Close panel')
      await press('Pause')
      // The old decoder cannot reach the request, so its completion is stale.
      Object.defineProperty(before[0], 'duration', {
        value: 0,
        configurable: true
      })
      await press('+10 seconds')
      now += 5001
      await act(async () => {
        recover!()
        await pause()
      })
      now += 1001
      await act(async () => {
        recover!()
        await pause()
      })
      const replacement = document.querySelector('video')!
      expect(replacement).not.equals(before[0])
      await act(async () => {
        load(replacement)
        await pause()
      })
      expect(
        replacement.currentTime,
        'new player receives retained viewer position'
      ).equals(10)
    } finally {
      globalThis.setInterval = originalInterval
      Date.now = originalNow
    }
  })
  it('uses the same short camera names as the regular game player', async () => {
    const original = client.game.bind(client)
    client.game = async (...args) => {
      const game = await original(...args)
      return {
        ...game,
        videos: game.videos.map((video, i) => ({
          ...video,
          title: `Visitors vs Hosts — ${['Home', 'First base', 'Third base', 'Outfield'][i] ?? 'Other'}`
        }))
      }
    }
    try {
      await render()
      expect(
        document.querySelector('[aria-label="Toggle First base"]')
      ).not.equals(null)
      expect(
        document.querySelector('[aria-label="Toggle Third base"]')
      ).not.equals(null)
      expect(
        document.querySelector('[aria-label="Toggle First base"]')!.textContent
      ).not.contains('Visitors vs Hosts')
    } finally {
      client.game = original
    }
  })

  it('drains recording completion even when touch begin/end are batched together', async () => {
    viewport = await windowSize(1920, 1080)
    count = 1
    await render()
    const video = document.querySelector('video')!
    await act(async () => {
      Object.defineProperty(video, 'duration', {
        value: 100,
        configurable: true
      })
      video.dispatchEvent(new window.Event('durationchange', { bubbles: true }))
      await pause()
    })
    await press('Close panel')
    await act(async () => {
      emitTvDirection('right')
      await pause()
    })
    await act(async () => {
      emitTvPan('Began', 0)
      emitTvPan('Changed', -100)
      video.dispatchEvent(new window.Event('ended', { bubbles: true }))
      emitTvPan('Cancelled', -100)
    })
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).not.equals(null)
    expect(document.querySelector('[data-testid="tv-scrubber"]')).equals(null)
  })
  for (const finish of [
    'Ended',
    'Cancelled',
    'clickLeft',
    'holdLeft'
  ] as const) {
    it(`defers natural recording completion during a drag and handles ${finish}`, async () => {
      viewport = await windowSize(1920, 1080)
      count = 1
      await render()
      const video = document.querySelector('video')!
      await act(async () => {
        Object.defineProperty(video, 'duration', {
          value: 100,
          configurable: true
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
        await pause()
      })
      await press('Close panel')
      await act(async () => {
        emitTvDirection('right')
        emitTvPan('Began', 0)
        emitTvPan('Changed', -100)
        await pause()
      })
      expect(
        document.querySelector('[data-testid="tv-scrubber"]'),
        'scrub before end'
      ).not.equals(null)
      await act(async () => {
        video.dispatchEvent(new window.Event('ended', { bubbles: true }))
        await pause()
      })
      expect(document.querySelector('[data-testid="tv-scrubber"]')).not.equals(
        null
      )
      expect(
        document.querySelector('[data-testid="tv-highlights-panel"]')
      ).equals(null)
      await act(async () => {
        if (finish === 'clickLeft') emitTvDirection('left')
        else if (finish === 'holdLeft') emitTvDirection('longLeft', 0)
        else emitTvPan(finish, -100)
        await pause()
      })
      if (finish !== 'Cancelled') {
        if (finish === 'Ended') expect(video.currentTime).lessThan(10)
        else expect(video.currentTime).equals(90)
        expect(
          document.querySelector('[data-testid="tv-highlights-panel"]')
        ).equals(null)
        expect(document.querySelector('video')!.paused).equals(false)
      } else {
        expect(
          document.querySelector('[data-testid="tv-highlights-panel"]')
        ).not.equals(null)
        expect(document.querySelector('[data-testid="tv-scrubber"]')).equals(
          null
        )
      }
    })
  }
  it('applies slow overlapping refreshes and never lets an older response replace newer highlights', async () => {
    live = true
    const originalInterval = globalThis.setInterval
    const originalHighlights = client.tvHighlights.bind(client)
    let poll: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      if (delay === 10000) poll = callback
      return originalInterval(callback, delay)
    }) as typeof setInterval
    try {
      await render()
      await press('Highlights')
      const pendingRefreshes: Array<
        (value: Awaited<ReturnType<typeof client.tvHighlights>>) => void
      > = []
      client.tvHighlights = async () =>
        await new Promise(resolve => {
          pendingRefreshes.push(resolve)
        })
      expect(poll).not.equals(undefined)
      await act(async () => {
        poll!()
        poll!()
        await pause()
      })
      const clips = await originalHighlights('0')
      await act(async () => {
        pendingRefreshes[0]([{ ...clips[0], title: 'First slow refresh' }])
        await pause()
      })
      expect(document.body.textContent).contains('First slow refresh')
      await act(async () => {
        pendingRefreshes[1]([{ ...clips[0], title: 'Second slow refresh' }])
        await pause()
        poll!()
        poll!()
        await pause()
      })
      await act(async () => {
        pendingRefreshes[3]([{ ...clips[0], title: 'Newest response' }])
        await pause()
        pendingRefreshes[2]([{ ...clips[0], title: 'Stale response' }])
        await pause()
      })
      expect(document.body.textContent).contains('Newest response')
      expect(document.body.textContent).not.contains('Stale response')
    } finally {
      globalThis.setInterval = originalInterval
      client.tvHighlights = originalHighlights
    }
  })
  it('owns native pan only during scrubbing and seeks every persistent player', async () => {
    viewport = await windowSize(1920, 1080)
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      for (const video of videos) {
        Object.defineProperty(video, 'duration', {
          value: 100,
          configurable: true
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      }
      await pause()
    })
    await press('Close panel')
    panRequests.length = 0
    await act(async () => {
      emitTvDirection('right')
      await pause()
    })
    expect(videos.map(v => v.currentTime)).deep.equals([10, 10, 10, 10])
    expect(document.querySelector('[data-testid="tv-scrubber"]')).not.equals(
      null
    )
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).equals(null)
    expect(
      document.querySelector('[data-testid="tv-total-time"]')!.textContent
    ).equals('1:40')
    expect(panRequests).deep.equals([true])
    await act(async () => {
      emitTvDirection('swipeRight')
      await pause()
    })
    expect(videos.map(v => v.currentTime)).deep.equals([10, 10, 10, 10])
    await act(async () => {
      emitTvPan('Began', 0)
      emitTvPan('Changed', 100)
    })
    // The dot and label move before any timer/native seek can complete.
    const dot = document.querySelector<HTMLElement>(
      '[data-testid="tv-scrub-dot"]'
    )!
    expect(parseFloat(dot.style.left)).greaterThan(10)
    expect(
      document.querySelector('[data-testid="tv-current-time"]')!.textContent
    ).not.equals('0:10')
    expect(videos.map(v => v.currentTime)).deep.equals([10, 10, 10, 10])
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
    })
    expect(parseFloat(dot.style.left)).greaterThan(10)
    await act(async () => {
      emitTvPan('Ended', 100)
      await pause()
    })
    expect(videos.every(v => v.currentTime > 10)).equals(true)
    await press('Highlights')
    expect(panRequests).deep.equals([true, false])
    expect(document.querySelector('[data-testid="tv-scrubber"]')).equals(null)
    await press('Close panel')
    await act(async () => {
      emitTvDirection('longUp', 0)
      await pause()
    })
    expect(videos.map(v => v.playbackRate)).deep.equals([
      0.25, 0.25, 0.25, 0.25
    ])
    await act(async () => {
      emitTvDirection('longUp', 1)
      await pause()
    })
    expect(videos.map(v => v.playbackRate)).deep.equals([1, 1, 1, 1])
  })
  it('temporarily plays paused cameras slowly during Up and pauses them again on release', async () => {
    await render()
    await press('Close panel')
    const videos = [...document.querySelectorAll('video')]
    const paused = new Map<HTMLVideoElement, boolean>()
    for (const video of videos) {
      video.play = async () => {
        paused.set(video, false)
      }
      video.pause = () => {
        paused.set(video, true)
      }
    }
    await act(async () => {
      for (const video of videos) {
        Object.defineProperty(video, 'duration', {
          value: 100,
          configurable: true
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      }
      await pause()
    })
    await press('Close panel')
    await act(async () => {
      emitTvDirection('playPause')
      await pause()
    })
    expect(videos.every(v => paused.get(v) === true)).equals(true)
    await act(async () => {
      emitTvDirection('longUp', 0)
      await pause()
    })
    expect(videos.every(v => paused.get(v) === false)).equals(true)
    expect(videos.map(v => v.playbackRate)).deep.equals([
      0.25, 0.25, 0.25, 0.25
    ])
    await act(async () => {
      emitTvDirection('longUp', 1)
      await pause()
    })
    expect(videos.every(v => paused.get(v) === true)).equals(true)
    // Hold the last native rate while paused to avoid the native forced-play setter.
    expect(videos.map(v => v.playbackRate)).deep.equals([
      0.25, 0.25, 0.25, 0.25
    ])
    await act(async () => {
      emitTvDirection('playPause')
      await pause()
    })
    expect(videos.every(v => paused.get(v) === false)).equals(true)
    expect(videos.map(v => v.playbackRate)).deep.equals([1, 1, 1, 1])
  })
  it('has no transport buttons and keeps Up navigation on the video', async () => {
    await render()
    await press('Close panel')
    for (const label of [
      'Back to games',
      'Cameras',
      'Highlights',
      'Box score',
      'Pause',
      '−10 seconds',
      '+10 seconds'
    ]) {
      expect(document.querySelector(`[aria-label="${label}"]`)).equals(null)
    }
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="tv-angle-0"]')!.focus()
      emitTvDirection('up')
      emitTvDirection('swipeUp')
      await pause()
    })
    await press('+10 seconds')
    expect(document.querySelector('[data-testid="tv-scrubber"]')).not.equals(
      null
    )
  })
  it('opens each panel on the first swipe beyond its edge after focus arrives', async () => {
    await render()
    const focus = async (index: number): Promise<void> => {
      await act(async () => {
        document
          .querySelector<HTMLElement>(`[data-testid="tv-angle-${index}"]`)!
          .focus()
        await new Promise(resolve => setTimeout(resolve, 120))
      })
    }
    const key = async (direction: string): Promise<void> => {
      await act(async () => {
        emitTvDirection(direction)
        await pause()
      })
    }
    await focus(0)
    await key('swipeRight')
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).equals(null)
    await focus(1)
    await key('swipeRight')
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).not.equals(null)
    await key('swipeLeft')
    await focus(0)
    await key('swipeLeft')
    expect(
      document.querySelector('[data-testid="tv-cameras-panel"]')
    ).not.equals(null)
    await key('swipeRight')
    await focus(2)
    await key('swipeDown')
    expect(document.querySelector('[data-testid="tv-box-panel"]')).not.equals(
      null
    )
    await key('swipeUp')
    expect(document.querySelector('[data-testid="tv-box-panel"]')).equals(null)
  })
  it('scrolls expanded stats at half speed on drag, directional clicks and release', async () => {
    await render()
    await press('Close panel')
    await press('Box score')
    await press('Team and player statistics')
    type Measured = HTMLElement & {
      __reactLayoutHandler: (event: unknown) => void
    }
    const scroll = document.querySelector<Measured>(
      '[data-testid="tv-stats-scroll"]'
    )!
    const content = scroll.firstElementChild as Measured
    await act(async () => {
      for (const [node, height] of [
        [scroll, 270],
        [content, 1270]
      ] as const)
        node.__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width: 1920, height } }
        })
      emitTvPan('Began', 0, 0)
      emitTvPan('Changed', 0, 200)
    })
    expect(scroll.scrollTop).equals(100)
    await act(async () => {
      emitTvPan('Cancelled', 0, 200)
      emitTvDirection('down')
    })
    expect(scroll.scrollTop).equals(150)
    const raf = globalThis.requestAnimationFrame
    const now = Date.now
    const frames: FrameRequestCallback[] = []
    try {
      let time = now()
      Date.now = () => time
      globalThis.requestAnimationFrame = callback => frames.push(callback)
      emitTvPan('Ended', 0, 200, 1000)
      expect(frames).length(1)
      time += 20
      frames.shift()!(time)
      expect(scroll.scrollTop).equals(160)
    } finally {
      emitTvPan('Cancelled', 0, 200)
      globalThis.requestAnimationFrame = raf
      Date.now = now
    }
  })
  it('dismisses topmost stats with an upward swipe or continuous upward touch', async () => {
    await render()
    await press('Close panel')
    await press('Box score')
    expect(document.querySelector('[data-testid="tv-box-panel"]')).not.equals(
      null
    )
    await act(async () => {
      emitTvDirection('swipeUp')
      await pause()
    })
    expect(document.querySelector('[data-testid="tv-box-panel"]')).equals(null)
    await press('Box score')
    await act(async () => {
      emitTvPan('Began', 0, 50)
      emitTvPan('Changed', 0, 20)
      emitTvPan('Ended', 0, 20)
      await pause()
    })
    expect(document.querySelector('[data-testid="tv-box-panel"]')).equals(null)
  })
  it('restores the selected camera and boundary tracking after collapsing fullscreen', async () => {
    await render()
    await press('Close panel')
    const angle = document.querySelector<HTMLElement>(
      '[data-testid="tv-angle-1"]'
    )!
    let restored = 0
    Object.assign(angle, {
      requestTVFocus() {
        restored++
        angle.focus()
      }
    })
    await act(async () => {
      angle.focus()
      await pause()
    })
    await press('Camera Angle 1')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    restored = 0
    await act(async () => {
      remoteBack?.()
      await pause()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(restored).equals(1)
    expect(document.activeElement).equals(angle)
    await act(async () => {
      emitTvDirection('swipeRight')
      await pause()
    })
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).not.equals(null)
  })
  for (const angleCount of [2, 3, 4])
    it(`keeps the imported inning score for ${angleCount} cameras without player detail`, async () => {
      viewport = await windowSize(1920, 1080)
      count = angleCount
      lineOnly = true
      await render()
      const video = document.querySelector('video')!
      await act(async () => {
        video.currentTime = 1
        video.dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
        await pause()
      })
      const selector = angleCount === 4 ? 'tv-line-score' : 'line-score-box'
      const line = document.querySelector(`[data-testid="${selector}"]`)
      expect(line).not.equals(null)
      expect(line?.textContent).includes('Recorded Visitors')
      expect(line?.textContent).includes('Recorded Hosts')
      expect(document.querySelector('[data-testid="tv-stats-away"]')).equals(
        null
      )
    })

  it('keeps extra innings scrollable and its statistics control reachable within the bottom third', async () => {
    wide = true
    await render()
    const video = document.querySelector('video')!
    await act(async () => {
      Object.defineProperty(video, 'duration', {
        configurable: true,
        value: 60
      })
      video.dispatchEvent(new window.Event('durationchange', { bubbles: true }))
      video.currentTime = 1
      video.dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    await press('Close panel')
    await press('Box score')
    const panel = document.querySelector<HTMLElement>(
      '[data-testid="tv-box-panel"]'
    )!
    expect(panel.style.height).equals('20%')
    expect(
      document.querySelector('[data-testid="tv-score-column-25"]')
    ).not.equals(null)
    await press('Team and player statistics')
    expect(panel.style.height).equals('25%')
    expect(document.querySelector('[data-testid="tv-stats-away"]')).not.equals(
      null
    )
    await press('Close panel')
    expect(document.querySelector('[data-testid="tv-box-panel"]')).equals(null)
  })

  it('keeps the streams through zoom and toggles, and outlines only a choice of pictures', async () => {
    viewport = await windowSize(1920, 1080)
    await render()
    await press('Close panel')
    const streams = [...document.querySelectorAll('video')]
    const angle = document.querySelector<HTMLElement>(
      '[data-testid="tv-angle-1"]'
    )!
    const focusAngle = async (): Promise<void> => {
      await act(async () => {
        angle.blur()
        angle.focus()
        await pause()
      })
    }
    const border = (): string => getComputedStyle(angle).borderTopWidth
    await focusAngle()
    expect(border()).equals('4px')
    await press('Camera Angle 1')
    expect(border()).equals('0px')
    expect(getComputedStyle(angle.parentElement!).width).equals('1920px')
    await press('Back to cameras')
    expect(getComputedStyle(angle.parentElement!).width).equals('960px')
    await press('Cameras')
    for (const i of [0, 2, 3]) await press(`Toggle Angle ${i}`)
    await press('Close panel')
    await focusAngle()
    expect(getComputedStyle(angle.parentElement!).width).equals('1920px')
    expect(border()).equals('0px')
    await press('Cameras')
    await press('Toggle Angle 0')
    await press('Close panel')
    await focusAngle()
    expect(border()).equals('4px')
    expect([...document.querySelectorAll('video')]).deep.equals(streams)
  })
  for (const reduced of [false, true]) {
    it(`schedules TV layout transitions only when motion is allowed (reduce motion ${reduced})`, async () => {
      const tvFlag = Object.getOwnPropertyDescriptor(Platform, 'isTV')
      const preference =
        AccessibilityInfo.isReduceMotionEnabled.bind(AccessibilityInfo)
      const configure = LayoutAnimation.configureNext
      const stats = client.gameStatistics.bind(client)
      const animations: Array<Parameters<typeof configure>[0]> = []
      try {
        Object.defineProperty(Platform, 'isTV', {
          configurable: true,
          value: true
        })
        AccessibilityInfo.isReduceMotionEnabled = async () => reduced
        LayoutAnimation.configureNext = config => {
          animations.push(config)
        }
        client.gameStatistics = async id => {
          const data = await stats(id)
          data.board.steps = [boardStep(0)]
          return data
        }
        viewport = await windowSize(1920, 1080)
        await render()
        await act(async () => {
          for (const video of document.querySelectorAll('video')) {
            Object.defineProperty(video, 'duration', {
              configurable: true,
              value: 60
            })
            video.dispatchEvent(new window.Event('durationchange'))
          }
          document
            .querySelector('video')!
            .dispatchEvent(new window.Event('timeupdate'))
          await pause()
        })
        await press('Close panel')
        const board = (): HTMLElement =>
          document.querySelector<HTMLElement>('[data-testid="tv-scoreboard"]')!
        const fourWidth = getComputedStyle(board()).width
        await press('Camera Angle 1')
        expect(animations).length(reduced ? 0 : 1)
        await press('Back to cameras')
        expect(animations).length(reduced ? 0 : 2)
        await press('Cameras')
        await press('Toggle Angle 0')
        expect(animations).length(reduced ? 0 : 3)
        expect(getComputedStyle(board()).width)
          .equals('960px')
          .and.not.equals(fourWidth)
        await press('Toggle Angle 0')
        expect(getComputedStyle(board()).width).equals(fourWidth)
        expect(animations).deep.equals(
          Array(reduced ? 0 : 4).fill(
            LayoutAnimation.create(240, 'easeInEaseOut', 'scaleXY')
          )
        )
      } finally {
        if (tvFlag !== undefined)
          Object.defineProperty(Platform, 'isTV', tvFlag)
        else Reflect.deleteProperty(Platform, 'isTV')
        AccessibilityInfo.isReduceMotionEnabled = preference
        LayoutAnimation.configureNext = configure
        client.gameStatistics = stats
      }
    })
  }
  it('opens four authorized single-camera sources and enlarges the same player without remounting', async () => {
    await render()
    const videos = [...document.querySelectorAll('video')]
    expect(videos).length(4)
    await press('Camera Angle 1')
    expect([...document.querySelectorAll('video')]).deep.equals(videos)
    await press('Back to cameras')
    expect(closed).equals(false)
    await press('Back to games')
    expect(closed).equals(true)
  })
  it('moves the static highlight focus cue with the remote, even without a thumbnail', async () => {
    const preference =
      AccessibilityInfo.isReduceMotionEnabled.bind(AccessibilityInfo)
    AccessibilityInfo.isReduceMotionEnabled = async () => true
    try {
      await render()
      await press('Close panel')
      await press('Highlights')
      const clips = [0, 1].map(i =>
        document.querySelector<HTMLElement>(
          `[data-testid="tv-highlight-${i}"]`
        )!
      )
      for (const selected of clips) {
        await act(async () => {
          selected.focus()
          await pause()
        })
        for (const clip of clips) {
          const thumbnail = clip.firstElementChild!
          expect(
            getComputedStyle(thumbnail).transform === 'scale(1.16)'
          ).equals(clip === selected)
          expect(getComputedStyle(thumbnail).overflowX).equals('hidden')
          expect(getComputedStyle(thumbnail).borderTopLeftRadius).equals('12px')
          const text = [...clip.querySelectorAll<HTMLElement>('*')].find(
            node =>
              node.childElementCount === 0 &&
              node.textContent === clip.getAttribute('aria-label')
          )!
          expect(
            getComputedStyle(text).textDecoration.includes('underline') ||
              getComputedStyle(text).textDecorationLine === 'underline'
          ).equals(false)
        }
      }
    } finally {
      AccessibilityInfo.isReduceMotionEnabled = preference
    }
  })
  it('toggles persistent surfaces, transfers audio, seeks highlights and reopens their list while playback continues', async () => {
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      for (const video of videos) {
        Object.defineProperty(video, 'duration', {
          value: 60,
          configurable: true
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      }
      await pause()
    })
    expect(
      document.querySelector('[data-testid="tv-cameras-panel"]')
    ).not.equals(null)
    const cameraGradient = document.querySelector<HTMLElement>(
      '[data-testid="tv-cameras-panel"] [data-testid="tv-panel-gradient"]'
    )!
    expect(
      cameraGradient.querySelector('linearGradient')?.getAttribute('x2')
    ).equals('100%')
    expect(
      cameraGradient.querySelector('stop')?.getAttribute('stop-opacity')
    ).equals('0.75')
    const gradientWidth = cameraGradient.parentElement!.style.width
    const camera = document.querySelector<HTMLElement>(
      '[data-testid="tv-toggle-0"]'
    )!
    expect(camera.style.borderWidth).not.equals('3px')
    expect(getComputedStyle(camera).width).equals('207px')
    expect(camera.querySelector('[data-testid="tv-camera-dim-0"]')).equals(null)
    expect(camera.textContent).equals('Angle 0')
    const stops = camera.querySelectorAll('stop')
    expect(stops[0].getAttribute('stop-opacity')).equals('0')
    expect(stops[1].getAttribute('stop-opacity')).equals('0.75')
    await press('Toggle Angle 0')
    expect(
      camera.querySelector<HTMLElement>('[data-testid="tv-camera-dim-0"]')!
        .style.backgroundColor
    ).equals('rgba(0, 0, 0, 0.6)')
    expect([...document.querySelectorAll('video')]).deep.equals(videos)
    expect(videos[0].muted).equals(true)
    expect(videos[1].muted).equals(false)
    await press('Toggle Angle 0')
    await press('Close panel')
    await press('Highlights')
    const clip = document.querySelector<HTMLElement>(
      '[data-testid="tv-highlight-0"]'
    )!
    const highlightGradient = document.querySelector<HTMLElement>(
      '[data-testid="tv-highlights-panel"] [data-testid="tv-panel-gradient"]'
    )!
    expect(
      highlightGradient.querySelector('linearGradient')?.getAttribute('x1')
    ).equals('100%')
    expect(highlightGradient.parentElement!.style.width).equals(gradientWidth)
    expect(clip.textContent).contains('Home run')
    expect(clip.style.flexDirection).not.equals('row')
    expect(clip.style.borderWidth).equals('')
    await act(async () => {
      clip.focus()
      await pause()
    })
    expect(clip.style.borderWidth).equals('')
    const thumbnail = clip.querySelector<HTMLElement>(
      '[data-testid="tv-highlight-thumbnail-0"]'
    )!
    for (const node of [thumbnail, ...thumbnail.querySelectorAll('*')]) {
      const { borderTopStyle, borderTopWidth } = getComputedStyle(node)
      expect(
        ['', 'none', 'hidden'].includes(borderTopStyle) ||
          borderTopWidth === '0px'
      ).equals(true)
    }
    expect(getComputedStyle(thumbnail).width).equals('300px')
    expect(getComputedStyle(thumbnail).height).equals('170px')
    await press('Home run')
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).equals(null)
    expect(videos.map(v => v.currentTime)).deep.equals([5, 5, 5, 5])
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    await act(async () => {
      videos[0].currentTime = 9
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).not.equals(null)
    expect(videos[0].currentTime).equals(9)
    await press('Close panel')
    await press('Box score')
    expect(document.body.textContent).contains(
      'Statistics are not available in the recorded plays.'
    )
    await press('Team and player statistics')
    expect(
      document.body.textContent?.split(
        'Statistics are not available in the recorded plays.'
      ).length
    ).equals(2)
    await press('Close panel')
    await press('Pause')
    await press('Play')
    await press('−10 seconds')
    expect(videos[0].currentTime).equals(0)
    await press('+10 seconds')
    expect(videos[0].currentTime).equals(10)
    await press('Back to games')
    expect(closed).equals(true)
  })
  it('keeps the native live opening position instead of seeking to the first pitch', async () => {
    live = true
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      for (const video of videos) {
        Object.defineProperty(video, 'duration', {
          configurable: true,
          value: 60
        })
        video.currentTime = 40
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      }
      await pause()
    })
    expect(videos.map(video => video.currentTime)).deep.equals([40, 40, 40, 40])
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    await press('Close panel')
    await press('−10 seconds')
    // Live streams without a finite recording extent cannot use recorded seeking.
    expect(videos.map(video => video.currentTime)).deep.equals([40, 40, 40, 40])
  })
  it('continues the game and transfers audio when the first recording ends', async () => {
    count = 2
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      videos.forEach((video, index) => {
        Object.defineProperty(video, 'duration', {
          configurable: true,
          value: index === 0 ? 20 : 60
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      })
      await pause()
    })
    await press('Close panel')
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('ended', { bubbles: true }))
      await pause()
    })
    expect(document.querySelector('video')!.paused).equals(false)
    expect(videos[0].muted).equals(true)
    expect(videos[1].muted).equals(false)
    await press('+10 seconds')
    expect(videos[1].currentTime).equals(30)
    await act(async () => {
      videos[1].dispatchEvent(new window.Event('ended', { bubbles: true }))
      await pause()
    })
    await press('Close panel')
    await press('Play')
    expect(videos[1].currentTime).equals(0)
  })
  it('offers retry when every native camera fails before loading', async () => {
    count = 2
    await render()
    const videos = [...document.querySelectorAll('video')]
    for (const video of videos) {
      await act(async () => {
        Object.defineProperty(video, 'error', {
          configurable: true,
          value: { code: 3, message: 'fixture' }
        })
        video.dispatchEvent(new window.Event('error', { bubbles: true }))
        await pause()
      })
    }
    expect(document.body.textContent).contains('cameras could not play')
    await press('Retry video')
    expect(document.querySelectorAll('video')).length(2)
    expect(document.body.textContent).not.contains('Retry video')
  })
  it('plays available cameras when another URL fails or is still preparing', async () => {
    mixed = true
    await render()
    const videos = [...document.querySelectorAll('video')]
    expect(videos).length(2)
    expect(videos.map(video => video.getAttribute('src'))).deep.equals([
      'https://example.test/2.mp4',
      'https://example.test/3.mp4'
    ])
    expect(document.body.textContent).not.contains('Retry video')
  })
  it('recovers unavailable and pending sources and handles a single camera', async () => {
    fail = true
    await render()
    expect(document.body.textContent).contains('Game unavailable')
    fail = false
    pending = true
    await press('Retry video')
    expect(document.body.textContent).contains('still preparing')
    pending = false
    count = 0
    await press('Retry video')
    expect(document.body.textContent).contains('No camera angles')
    count = 1
    await press('Retry video')
    expect(document.querySelectorAll('video')).length(1)
    await press('Camera Angle 0')
    expect(document.body.textContent).not.contains('Back to cameras')
    const video = document.querySelector('video')!
    await act(async () => {
      Object.defineProperty(video, 'error', {
        configurable: true,
        value: { code: 3, message: 'fixture' }
      })
      video.dispatchEvent(new window.Event('error', { bubbles: true }))
      await pause()
    })
    expect(document.body.textContent).contains('cameras could not play')
    await press('Retry video')
    expect(document.querySelectorAll('video')).length(1)
    expect(document.body.textContent).not.contains('Retry video')
  })
})
