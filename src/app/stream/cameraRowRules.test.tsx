import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameLiveStreams, LiveStream } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import {
  angleState,
  cameraRefusal,
  cameraSubtitle,
  cameraTap,
  formatDuration,
  isEnded,
  orderAngles,
  useCameraDuration
} from './cameraRowRules'

const MY_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ID = '00000000-0000-4000-8000-000000000002'
const CLOSED = '2026-05-20T17:00:00.000Z'

function stream(patch: Partial<LiveStream> = {}): LiveStream {
  return {
    id: 'liv_1',
    gameId: 'gam_1',
    userId: userIdOfGumbo(7),
    ownerName: 'Mookie Betts',
    slot: 1,
    label: 'Home Plate',
    keyPrefix: 'ts_0000',
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

const mine = (patch: Partial<LiveStream> = {}): LiveStream =>
  stream({ deviceId: MY_ID, deviceModel: 'iPhone 15', ...patch })
const external = (patch: Partial<LiveStream> = {}): LiveStream =>
  stream({ deviceId: null, deviceModel: null, source: 'rtmp', ...patch })
const live = { state: 'publishing' }
const ended = { state: 'ended' }

describe('a camera’s refusal', function () {
  const refused =
    'TeamStation takes HEVC. This stream is H.264 — change the encoder to HEVC and start it again.'

  it('tells the owner of an idle camera why it sits there', function () {
    expect(cameraRefusal(external({ lastError: refused }), true)).equals(
      refused
    )
  })

  it('leaves out anything else the ingest wrote', function () {
    expect(
      cameraRefusal(external({ lastError: 'The stream ended' }), true)
    ).equals(undefined)
    expect(cameraRefusal(external(), true)).equals(undefined)
  })

  it('goes once the camera is live or over, and is the owner’s alone', function () {
    const lastError = refused
    expect(cameraRefusal(external({ lastError, ...live }), true)).equals(
      undefined
    )
    expect(cameraRefusal(external({ lastError, ...ended }), true)).equals(
      undefined
    )
    expect(cameraRefusal(external({ lastError }), false)).equals(undefined)
  })
})

describe('a camera row’s words', function () {
  it('says what each external source is, also for a camera with no source', function () {
    expect(cameraSubtitle(external(), true)).equals('Using RTMP URL')
    expect(cameraSubtitle(external({ source: null }), true)).equals(
      'Using RTMP URL'
    )
    expect(cameraSubtitle(external({ source: 'gopro' }), true)).equals(
      'Using GoPro'
    )
    expect(cameraSubtitle(external({ source: 'mevo' }), true)).equals(
      'Using Mevo'
    )
    expect(cameraSubtitle(external({ source: 'mevoStudio' }), true)).equals(
      'Using Mevo Studio'
    )
    expect(cameraSubtitle(external(live), true)).equals('Using RTMP URL')
    expect(cameraSubtitle(external(ended), true)).equals('Using RTMP URL')
  })

  it('says which phone is waiting or streaming, on this phone or another', function () {
    expect(cameraSubtitle(mine(), true)).equals(
      'Waiting for stream from iPhone 15'
    )
    expect(cameraSubtitle(mine(live), true)).equals('Streaming with iPhone 15')
    expect(cameraSubtitle(mine({ deviceId: OTHER_ID }), true)).equals(
      'Waiting for stream from iPhone 15'
    )
    expect(cameraSubtitle(mine({ ...live, deviceId: OTHER_ID }), true)).equals(
      'Streaming with iPhone 15'
    )
    expect(cameraSubtitle(mine(ended), true)).equals('Streaming with iPhone 15')
  })

  it('says "a phone" with no model', function () {
    for (const deviceModel of [null, undefined, ''])
      expect(cameraSubtitle(mine({ deviceModel }), true)).equals(
        'Waiting for stream from a phone'
      )
  })

  it('names the owner on somebody else’s row, whatever filmed it', function () {
    const theirs = stream({ deviceModel: 'Pixel 10', source: 'gopro' })
    expect(cameraSubtitle(theirs, false)).equals(
      'Waiting for stream from Mookie B'
    )
    expect(cameraSubtitle({ ...theirs, ...live }, false)).equals(
      'Mookie B streaming'
    )
    expect(cameraSubtitle({ ...theirs, ...ended }, false)).equals(
      'Mookie B streaming'
    )
  })

  it('reads a closing camera as ended while the ingest finishes it, but Live until then', function () {
    const closing = mine({ ...live, closesAt: CLOSED })
    expect(isEnded(closing)).equals(true)
    expect(angleState(closing)).equals('live')
    expect(angleState(mine({ closesAt: CLOSED }))).equals('ended')
    expect(angleState(mine(ended))).equals('ended')
    expect(angleState(mine())).equals('idle')
    expect(angleState(mine(live))).equals('live')
  })
})

describe('what tapping a camera row does', function () {
  it('opens details first on an own ended row, whatever filmed it', function () {
    for (const row of [
      mine(ended),
      mine({ closesAt: CLOSED }),
      mine({ ...ended, deviceId: OTHER_ID }),
      external(ended),
      external({ ...ended, source: null, playableVideoId: 'vid_1' })
    ])
      expect(cameraTap(row, true, MY_ID)).equals('details')
  })

  it('plays somebody else’s ended row only with a video to play', function () {
    expect(
      cameraTap(stream({ ...ended, playableVideoId: 'vid_1' }), false, MY_ID)
    ).equals('play')
    expect(cameraTap(stream(ended), false, MY_ID)).equals('none')
    expect(
      cameraTap(stream({ ...ended, playableVideoId: null }), false, MY_ID)
    ).equals('none')
  })

  it('opens the RTMP sheet from an own external row on any device', function () {
    expect(cameraTap(external(), true, MY_ID)).equals('rtmp')
    expect(cameraTap(external(live), true, undefined)).equals('rtmp')
    expect(cameraTap(external({ source: null }), true, OTHER_ID)).equals('rtmp')
  })

  it('opens the camera only on the phone holding the row', function () {
    expect(cameraTap(mine(), true, MY_ID)).equals('camera')
    expect(cameraTap(mine(live), true, MY_ID)).equals('camera')
    expect(cameraTap(mine({ deviceId: OTHER_ID }), true, MY_ID)).equals('none')
    expect(cameraTap(mine(), true, undefined)).equals('none')
  })

  it('never treats somebody else’s row as external', function () {
    for (const deviceId of [null, undefined])
      expect(
        cameraTap(stream({ deviceId, source: 'rtmp' }), false, MY_ID)
      ).equals('none')
  })
})

describe('the order of a game’s camera rows', function () {
  const list = (
    own: LiveStream[],
    others: LiveStream[] = []
  ): GameLiveStreams => ({
    gameId: 'gam_1',
    mine: own,
    others,
    canAdd: 4,
    maxCameras: 4,
    gameCanAdd: 6,
    discarded: []
  })
  const row = (
    id: string,
    createdAt: string | undefined,
    patch: Partial<LiveStream> = {}
  ): LiveStream => stream({ id, createdAt, ...patch })
  const ids = (angles: Array<{ stream: LiveStream }>): string[] =>
    angles.map(angle => angle.stream.id)

  it('has nothing to order before the list is read', function () {
    expect(orderAngles(undefined)).deep.equals({ active: [], ended: [] })
  })

  it('puts mine first, each oldest first, and ended rows apart in that order', function () {
    const { active, ended: over } = orderAngles(
      list(
        [
          row('b', '2026-05-20T16:02:00.000Z'),
          row('c', '2026-05-20T16:03:00.000Z', ended),
          row('a', '2026-05-20T16:01:00.000Z')
        ],
        [
          row('z', '2026-05-20T16:09:00.000Z', ended),
          row('y', '2026-05-20T16:00:30.000Z'),
          row('x', '2026-05-20T16:00:10.000Z')
        ]
      )
    )
    expect(ids(active)).deep.equals(['a', 'b', 'x', 'y'])
    expect(active.map(angle => angle.mine)).deep.equals([
      true,
      true,
      false,
      false
    ])
    expect(ids(over)).deep.equals(['c', 'z'])
  })

  it('keeps the list’s order for rows with no creation time', function () {
    const { active } = orderAngles(
      list([row('b', undefined), row('a', undefined)])
    )
    expect(ids(active)).deep.equals(['b', 'a'])
  })
})

describe('a camera’s duration', function () {
  let root: Root | undefined
  afterEach(function () {
    act(() => {
      root?.unmount()
    })
    root = undefined
  })

  it('writes hours and minutes, with no seconds', function () {
    expect(formatDuration(0)).equals('0:00')
    expect(formatDuration(59)).equals('0:00')
    expect(formatDuration(60)).equals('0:01')
    expect(formatDuration(9 * 3600 + 59 * 60 + 59)).equals('9:59')
    expect(formatDuration(10 * 3600)).equals('10:00')
    expect(formatDuration(123 * 3600 + 4 * 60)).equals('123:04')
  })

  const START = Date.parse('2026-05-20T16:00:00.000Z')
  const onAir = (patch: Partial<LiveStream> = {}): LiveStream =>
    mine({ ...live, publishedAt: new Date(START).toISOString(), ...patch })

  /** Hands in a clock, holding every interval so a test ticks them itself. */
  function clock(): {
    at: { now: number }
    tick: () => void
    running: () => number
    restore: () => void
  } {
    const at = { now: START }
    const real = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const held = new Set<unknown>()
    const callbacks = new Map<unknown, () => void>()
    globalThis.setInterval = ((callback: () => void, ms?: number) => {
      expect(ms).equals(1000)
      const id = { timer: true }
      held.add(id)
      callbacks.set(id, callback)
      return id
    }) as unknown as typeof setInterval
    globalThis.clearInterval = (id: unknown) => {
      held.delete(id)
    }
    return {
      at,
      tick: () => {
        at.now += 1000
        act(() => {
          for (const id of held) callbacks.get(id)?.()
        })
      },
      running: () => held.size,
      restore: () => {
        globalThis.setInterval = real
        globalThis.clearInterval = realClear
      }
    }
  }

  function show(
    first: LiveStream,
    now: () => number = Date.now
  ): {
    shown: () => string | undefined
    read: (next: LiveStream) => void
  } {
    let latest: string | undefined
    function Probe({ row }: { row: LiveStream }): null {
      latest = useCameraDuration(row, now)
      return null
    }
    const host = document.createElement('div')
    root = createRoot(host)
    act(() => {
      root!.render(<Probe row={first} />)
    })
    return {
      shown: () => latest,
      read: next => {
        act(() => {
          root!.render(<Probe row={next} />)
        })
      }
    }
  }

  it('shows an ended row’s own length, and none until it arrives', function () {
    const row = show(mine({ ...ended, durationSec: 4500 }))
    expect(row.shown()).equals('1:15')
    row.read(mine({ ...ended, durationSec: null }))
    expect(row.shown()).equals(undefined)
    row.read(mine(ended))
    expect(row.shown()).equals(undefined)
  })

  it('shows nothing for a camera that never went live', function () {
    expect(show(mine()).shown()).equals(undefined)
  })

  it('shows nothing for a live row with no start, and runs no timer', function () {
    const time = clock()
    try {
      const row = show(mine(live), () => time.at.now)
      expect(row.shown()).equals(undefined)
      expect(time.running()).equals(0)
    } finally {
      time.restore()
    }
  })

  it('counts a second a second between reads, from a baseline each read takes again', function () {
    const time = clock()
    try {
      time.at.now = START + 58_000
      const first = onAir()
      const row = show(first, () => time.at.now)
      expect(row.shown()).equals('0:00')
      expect(time.running()).equals(1)
      time.tick()
      expect(row.shown()).equals('0:00')
      time.tick()
      expect(row.shown()).equals('0:01')

      // The next read goes by the clock, however many ticks were missed.
      time.at.now = START + 180_000
      row.read(onAir())
      expect(row.shown()).equals('0:03')
      expect(time.running()).equals(1)
      time.tick()
      expect(row.shown()).equals('0:03')
    } finally {
      time.restore()
    }
  })

  it('never counts below nothing when this phone’s clock is behind', function () {
    const time = clock()
    try {
      time.at.now = START - 90_000
      expect(show(onAir(), () => time.at.now).shown()).equals('0:00')
    } finally {
      time.restore()
    }
  })

  it('stops the timer when the stream stops, is ended or closes', function () {
    for (const stopped of [
      { state: 'idle' },
      { state: 'ended', durationSec: 60 },
      { closesAt: CLOSED }
    ]) {
      const time = clock()
      try {
        time.at.now = START + 120_000
        const row = show(onAir(), () => time.at.now)
        expect(row.shown()).equals('0:02')
        expect(time.running()).equals(1)
        row.read(onAir(stopped))
        expect(time.running()).equals(0)
        expect(row.shown()).equals(
          stopped.state === 'ended' ? '0:01' : undefined
        )
      } finally {
        time.restore()
        act(() => {
          root?.unmount()
        })
        root = undefined
      }
    }
  })
})
