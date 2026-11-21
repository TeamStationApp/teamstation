import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  describeMedia,
  eventText,
  noteEvent,
  type SeenEvent,
  SinglePlayerReadout
} from './SinglePlayerReadout'
import type { VideoHandle } from './videoHandle'

/** The element as the readout reads it: state it is given, and events it can be sent. */
class FakeMedia {
  paused = true
  readyState = 4
  networkState = 2
  seeking = false
  error: { code: number } | null = null
  currentTime = 93.5
  seekable = ranges([[0, 225.4]])
  buffered = ranges([[20, 233.4]])
  listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }

  attached(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

function ranges(list: Array<[number, number]>): {
  length: number
  start: (i: number) => number
  end: (i: number) => number
} {
  return {
    length: list.length,
    start: i => list[i][0],
    end: i => list[i][1]
  }
}

let root: Root | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

const text = (): string =>
  document.querySelector('[data-testid="singlePlayerReadout"]')?.textContent ??
  ''

describe('the single player’s readout', function () {
  it('writes what the element is doing on one line', function () {
    const media = new FakeMedia()
    expect(describeMedia(media)).equals(
      'paused ready 4 net 2 at 93.5 seekable 0.0–225.4 buf 20.0–233.4'
    )
    media.paused = false
    media.seeking = true
    media.error = { code: 2 }
    media.seekable = ranges([
      [0, 10],
      [12, 40.25]
    ])
    media.buffered = ranges([])
    expect(describeMedia(media)).equals(
      'playing ready 4 net 2 seeking at 93.5 seekable 12.0–40.3 buf — error 2'
    )
    const bare = new FakeMedia() as Omit<FakeMedia, 'networkState'> & {
      networkState?: number
    }
    bare.networkState = undefined
    expect(describeMedia(bare)).includes('net ?')
  })

  it('shows the page’s own state and the last six events, and lets go when it goes', async function () {
    this.timeout(5000)
    const media = new FakeMedia()
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <SinglePlayerReadout
          element={media as unknown as VideoHandle}
          state={() => 'recovering false wants false suspended false'}
        />
      )
    })
    expect(text()).includes('paused ready 4')
    expect(text()).includes('recovering false wants false')
    for (const type of [
      'play',
      'playing',
      'stalled',
      'stalled',
      'pause',
      'ended',
      'emptied'
    ])
      media.emit(type)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    // The two stalls kept as one; six in all.
    expect(text()).match(
      /play@0 playing@0 stalled×2@0–0 pause@0 ended@0 emptied@0/
    )
    const listening = media.attached()
    expect(listening).greaterThan(0)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(media.attached()).equals(0)
  })

  it('keeps a run of the same event once, so a stop’s own events stay among the six', function () {
    const events: SeenEvent[] = []
    noteEvent(events, 'pause', 71)
    noteEvent(events, 'ended', 71)
    // Safari's stalls every few seconds while it stands there.
    for (let sec = 75; sec <= 225; sec += 4) noteEvent(events, 'stalled', sec)
    expect(events.map(eventText)).deep.equals([
      'pause@71',
      'ended@71',
      'stalled×38@75–223'
    ])
    for (const type of ['play', 'playing', 'seeking', 'seeked'])
      noteEvent(events, type, 230)
    expect(events.map(eventText)).deep.equals([
      'ended@71',
      'stalled×38@75–223',
      'play@230',
      'playing@230',
      'seeking@230',
      'seeked@230'
    ])
  })

  it('draws nothing without an element', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<SinglePlayerReadout element={null} state={() => ''} />)
    })
    expect(
      document.querySelector('[data-testid="singlePlayerReadout"]')
    ).equals(null)
  })
})
