import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asVideoSummary,
  type GameLiveStreams,
  type VideoSummary
} from '../../common/api'
import {
  openingVideo,
  sameVideos,
  usePublishingReport,
  useVideoListRefresh
} from './useVideoListRefresh'

function video(id: string, status: string): VideoSummary {
  return asVideoSummary({
    id,
    kind: 'game',
    title: id,
    status,
    storage: 'spaces',
    startAt: '2026-09-27T22:30:00Z',
    durationSec: status === 'live' ? null : 600,
    width: 1920,
    height: 1080,
    codecs: null
  })
}

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root?.render(element)
  })
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

describe('keeping a game page’s videos current', function () {
  function Probe(props: {
    videos: VideoSummary[] | undefined
    publishing: string[]
    refresh: () => void
    active?: boolean
  }): null {
    const { videos, publishing, refresh, active } = props
    useVideoListRefresh({ videos, publishing, refresh, everyMs: 40, active })
    return null
  }

  it('asks nothing while a screen covers the page, and once when it is shown', async function () {
    let asked = 0
    const probe = (active: boolean): React.ReactElement => (
      <Probe
        videos={[video('v1', 'live')]}
        publishing={[]}
        refresh={() => asked++}
        active={active}
      />
    )
    await render(probe(false))
    await wait(150)
    expect(asked).equals(0)
    await render(probe(true))
    expect(asked).equals(1)
    await wait(150)
    expect(asked).to.be.at.least(3)
  })

  it('asks nothing of a game nothing is live on', async function () {
    let asked = 0
    await render(
      <Probe
        videos={[video('v1', 'ready')]}
        publishing={[]}
        refresh={() => asked++}
      />
    )
    await wait(150)
    expect(asked).equals(0)
  })

  it('asks again, every so often, while one of its videos is live', async function () {
    let asked = 0
    await render(
      <Probe
        videos={[video('v1', 'live')]}
        publishing={[]}
        refresh={() => asked++}
      />
    )
    await wait(150)
    expect(asked).to.be.at.least(2)

    // Once nothing is live, it stops.
    await render(
      <Probe
        videos={[video('v1', 'ready')]}
        publishing={[]}
        refresh={() => asked++}
      />
    )
    const after = asked
    await wait(150)
    expect(asked).equals(after)
  })

  it('asks at once for a publishing video the page does not hold, and only once', async function () {
    let asked = 0
    const refresh = (): void => {
      asked++
    }
    // Still loading: nothing to compare with yet.
    await render(
      <Probe videos={undefined} publishing={['v2']} refresh={refresh} />
    )
    expect(asked).equals(0)
    await render(<Probe videos={[]} publishing={['v2']} refresh={refresh} />)
    expect(asked).equals(1)
    await render(<Probe videos={[]} publishing={['v2']} refresh={refresh} />)
    expect(asked).equals(1)
    // A camera the page already holds asks nothing at once.
    await render(
      <Probe
        videos={[video('v2', 'live')]}
        publishing={['v2']}
        refresh={refresh}
      />
    )
    expect(asked).equals(1)
  })
})

describe('the video a game page opens on', function () {
  it('is a live one, then a ready one, then any', function () {
    const failed = video('f', 'failed')
    const ready = video('r', 'ready')
    const live = video('l', 'live')
    expect(openingVideo([failed, ready, live])).equals(live)
    expect(openingVideo([failed, ready])).equals(ready)
    expect(openingVideo([failed])).equals(failed)
    expect(openingVideo([])).equals(undefined)
  })

  it('opens on a live camera that is sending, not one that has stopped', function () {
    const stopped = video('s', 'live')
    const sending = { ...video('x', 'live'), receiving: true }
    expect(openingVideo([stopped, sending])).equals(sending)
    // Nothing sending: the first live one still, as before.
    expect(openingVideo([stopped, video('r', 'ready')])).equals(stopped)
  })
})

describe('two lists of videos', function () {
  it('are the same when they hold the same videos in the same states', function () {
    // A frame's address is signed afresh on every read, so it is not a change.
    expect(
      sameVideos(
        [{ ...video('a', 'live'), posterUrl: 'https://media.example.test/1' }],
        [{ ...video('a', 'live'), posterUrl: 'https://media.example.test/2' }]
      )
    ).equals(true)
    expect(sameVideos([video('a', 'live')], [video('a', 'ready')])).equals(
      false
    )
    expect(sameVideos([video('a', 'live')], [video('b', 'live')])).equals(false)
    expect(sameVideos([], [video('a', 'live')])).equals(false)
  })

  it('differ when a video was placed again or renamed', function () {
    // The phone says when its first picture was taken a moment after the
    // server placed the stream by when it heard it. A refresh that brings the
    // phone's start is the one the multi-camera view lines up by.
    expect(
      sameVideos(
        [video('a', 'live')],
        [{ ...video('a', 'live'), startAt: '2026-09-27T22:29:59.200Z' }]
      )
    ).equals(false)
    expect(
      sameVideos([video('a', 'live')], [{ ...video('a', 'live'), title: 'x' }])
    ).equals(false)
    expect(
      sameVideos(
        [video('a', 'ready')],
        [{ ...video('a', 'ready'), syncOffsetSec: 0.4 }]
      )
    ).equals(false)
  })
})

describe('a cameras panel’s report of what is publishing', function () {
  const row = (
    id: string,
    state: string,
    videoId: string | null
  ): GameLiveStreams['mine'][number] =>
    ({ id, state, videoId }) as unknown as GameLiveStreams['mine'][number]
  const streams = (
    mine: Array<GameLiveStreams['mine'][number]>,
    others: Array<GameLiveStreams['others'][number]> = []
  ): GameLiveStreams => ({ mine, others }) as unknown as GameLiveStreams

  function Probe(props: {
    streams: GameLiveStreams | undefined
    onPublishing: (ids: string[]) => void
  }): null {
    usePublishingReport(props.streams, props.onPublishing)
    return null
  }

  it('names the videos being published to, each time that changes', async function () {
    const reports: string[][] = []
    const onPublishing = (ids: string[]): void => {
      reports.push(ids)
    }
    await render(<Probe streams={undefined} onPublishing={onPublishing} />)
    await render(
      <Probe
        streams={streams(
          [row('s1', 'publishing', 'v2'), row('s2', 'idle', 'v3')],
          [row('s3', 'publishing', 'v1'), row('s4', 'publishing', null)]
        )}
        onPublishing={onPublishing}
      />
    )
    // The same again says nothing new.
    await render(
      <Probe
        streams={streams(
          [row('s1', 'publishing', 'v2')],
          [row('s3', 'publishing', 'v1')]
        )}
        onPublishing={onPublishing}
      />
    )
    expect(reports).deep.equals([[], ['v1', 'v2']])
  })
})
