import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AnalyticsClient } from '../../../common/observability/analyticsClient'
import type { Property } from '../../../common/observability/contract'
import type { GameSponsorReel } from '../../../common/sponsors/types'
import {
  AnalyticsProvider,
  useAnalytics
} from '../../observability/AnalyticsContext'
import type { FrameLoop } from '../scoreboardOverlay/usePlayheadStep'
import { SponsorReel } from './SponsorReel'
import {
  REEL_VIEW_MS,
  type ReelView,
  useReelPlayedMs,
  useReelViews
} from './useReelViews'

const START = 1_000_000
const reel: GameSponsorReel = {
  id: 'srp_a',
  reelId: 'srl_a',
  url: 'https://example.test/reel.mp4',
  width: 640,
  height: 360,
  startMs: START,
  durationMs: 12000
}
const view: ReelView = {
  reel,
  gameId: 'gam_g1',
  leagueId: 'lea_al',
  live: true
}
const EXPECTED = {
  rp: 'srp_a',
  rr: 'srl_a',
  gm: 'gam_g1',
  lg: 'lea_al',
  at: START,
  lv: true
}

/** What a stand-in analytics client was asked to send. */
function recorder(): {
  client: AnalyticsClient
  sent: Array<{ event: string; properties: Record<string, Property> }>
} {
  const sent: Array<{ event: string; properties: Record<string, Property> }> =
    []
  const client = {
    emit: async (event: string, properties: Record<string, Property> = {}) => {
      sent.push({ event, properties })
    }
  } as unknown as AnalyticsClient
  return { client, sent }
}

/** Display frames run by hand. */
function manualFrames(): FrameLoop & { step: () => void } {
  const waiting = new Map<number, () => void>()
  let handles = 0
  return {
    request: run => {
      waiting.set(++handles, run)
      return handles
    },
    cancel: handle => {
      waiting.delete(handle)
    },
    step: () => {
      const runs = [...waiting.values()]
      waiting.clear()
      for (const run of runs) run()
    }
  }
}

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
})

describe('useReelViews', () => {
  function Views(props: {
    analytics: AnalyticsClient | undefined
    view: ReelView | null
    playingMs: number
  }): null {
    useReelViews(props.analytics, props.view, props.playingMs)
    return null
  }
  const show = async (
    analytics: AnalyticsClient | undefined,
    shown: ReelView | null,
    playingMs: number
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <Views analytics={analytics} view={shown} playingMs={playingMs} />
      )
    })
  }

  it('sends nothing at 4.9 s of play, and one view at 5 s', async () => {
    const { client, sent } = recorder()
    await show(client, view, 0)
    await show(client, view, 4900)
    expect(sent).deep.equals([])
    await show(client, view, REEL_VIEW_MS)
    await show(client, view, 7000)
    expect(sent).deep.equals([
      { event: 'sponsor_reel_viewed', properties: EXPECTED }
    ])
  })
  it('counts on through a pause: 3 s, paused, then 2 s more is one view', async () => {
    const { client, sent } = recorder()
    await show(client, view, 3000)
    // Paused: the played time holds where it was.
    await show(client, view, 3000)
    await show(client, view, 3000)
    expect(sent).deep.equals([])
    await show(client, view, 5000)
    expect(sent).length(1)
  })
  it('sends another for a replay of the placement', async () => {
    const { client, sent } = recorder()
    await show(client, view, 6000)
    await show(client, null, 0)
    await show(client, view, 0)
    await show(client, view, 5000)
    expect(sent).length(2)
    // Another placement is a play of its own.
    await show(client, { ...view, reel: { ...reel, id: 'srp_b' } }, 5000)
    expect(sent).length(3)
    expect(sent[2].properties.rp).equals('srp_b')
  })
  it('sends nothing without an analytics client or a reel', async () => {
    const { sent } = recorder()
    await show(undefined, view, 9000)
    await show(undefined, null, 9000)
    expect(sent).deep.equals([])
  })
})

describe('useReelPlayedMs', () => {
  let played = -1
  function Played(props: {
    reelId: string | null
    wallNow: () => number | null
    paused: boolean
    frames: FrameLoop
  }): null {
    played = useReelPlayedMs(
      props.reelId,
      props.wallNow,
      props.paused,
      props.frames
    )
    return null
  }

  it('counts the game clock moving forward while not paused, and not seeks', async () => {
    const frames = manualFrames()
    let wall: number | null = START
    const render = async (
      reelId: string | null,
      paused = false
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <Played
            reelId={reelId}
            wallNow={() => wall}
            paused={paused}
            frames={frames}
          />
        )
      })
    }
    const step = async (ms: number | null): Promise<void> => {
      wall = ms == null ? null : (wall ?? START) + ms
      await act(async () => {
        frames.step()
      })
    }
    await render('srp_a')
    expect(played).equals(0)
    for (let i = 0; i < 20; i++) await step(100)
    expect(played).equals(2000)
    // A seek on, a seek back and a picture with no clock count nothing.
    await step(5000)
    await step(-3000)
    await step(null)
    await step(100)
    expect(played).equals(2000)
    // Paused, the clock is not counted even if it moves.
    await render('srp_a', true)
    await step(500)
    expect(played).equals(2000)
    await render('srp_a')
    for (let i = 0; i < 10; i++) await step(100)
    expect(played).equals(3000)
    // Off and on again is a new play, from 0.
    await render(null)
    expect(played).equals(0)
    await render('srp_a')
    expect(played).equals(0)
    for (let i = 0; i < 3; i++) await step(100)
    expect(played).equals(250)
  })
})

describe('SponsorReel views', () => {
  it('records 5 s of a drawn reel as a view of the game, signed in', async () => {
    const frames = manualFrames()
    const sent: unknown[][] = []
    const originalFetch = globalThis.fetch
    const media = window.HTMLMediaElement.prototype
    const play = Object.getOwnPropertyDescriptor(media, 'play')!
    Object.defineProperty(media, 'play', {
      configurable: true,
      value: async () => undefined
    })
    globalThis.fetch = (async (_url: string, options: RequestInit) => {
      sent.push(JSON.parse(options.body as string) as unknown[])
      return { status: 202 }
    }) as typeof fetch
    let wall = START
    let analytics: AnalyticsClient | undefined
    function Probe(): null {
      analytics = useAnalytics()
      return null
    }
    const kept = new Map<string, string>()
    const draw = async (game?: {
      id: string
      leagueId: string | null
      live: boolean
    }): Promise<void> => {
      await act(async () => {
        root.render(
          <AnalyticsProvider
            endpoint="/api/v1/analytics/events"
            storage={{
              getItem: async key => kept.get(key) ?? null,
              setItem: async (key, value) => {
                kept.set(key, value)
              }
            }}
          >
            <Probe />
            <SponsorReel
              reels={[reel]}
              wallNow={() => wall}
              rect={{ x: 0, y: 0, w: 320, h: 180 }}
              muted
              paused={false}
              frames={frames}
              game={game}
            />
          </AnalyticsProvider>
        )
      })
    }
    try {
      await draw({ id: 'gam_g1', leagueId: 'lea_al', live: false })
      analytics!.identify('usr_viewer', 'token')
      for (let i = 0; i < 60; i++) {
        wall += 100
        await act(async () => {
          frames.step()
        })
      }
      await act(async () => {
        await analytics!.flush()
      })
      const views = sent
        .flat()
        .filter(
          (row): row is { E: string; P: Record<string, unknown> } =>
            (row as { E?: string }).E === 'sponsor_reel_viewed'
        )
      expect(views.map(row => row.P)).deep.equals([{ ...EXPECTED, lv: false }])
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(media, 'play', play)
    }
  })
})
