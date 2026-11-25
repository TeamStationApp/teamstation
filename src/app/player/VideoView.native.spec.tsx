import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { VideoView } from './VideoView.native'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

/** Renders `VideoView.native`, the same root each time, as a re-render. */
async function show(
  props: Partial<React.ComponentProps<typeof VideoView>>
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <VideoView
        source="https://media.example.test/v1/index.m3u8"
        onHandle={() => undefined}
        {...props}
      />
    )
  })
}

/** What `VideoView.native` handed the phone's player. */
async function handed(
  props: Partial<React.ComponentProps<typeof VideoView>>
): Promise<Record<string, unknown>> {
  await show(props)
  const node = document.querySelector('[data-video-props]')!
  return JSON.parse(node.getAttribute('data-video-props')!) as Record<
    string,
    unknown
  >
}

describe("the phone's picture and its audio session (U33a)", function () {
  it('requests direct transport updates only for iOS grid cameras', async function () {
    const original = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    try {
      Object.defineProperty(Platform, 'OS', { ...original, value: 'ios' })
      expect(
        (await handed({ gridTransport: true })).teamstationGridCrawlRate
      ).equals(0.25)
      expect((await handed({})).teamstationGridCrawlRate).equals(undefined)
      Object.defineProperty(Platform, 'OS', { ...original, value: 'android' })
      expect(
        (await handed({ gridTransport: true })).teamstationGridCrawlRate
      ).equals(undefined)
    } finally {
      Object.defineProperty(Platform, 'OS', original)
    }
  })
  it('keeps the exact restored speed while a same-frame tap commits its pause', async function () {
    let tile: Parameters<
      React.ComponentProps<typeof VideoView>['onHandle']
    >[0] = null
    const onHandle: React.ComponentProps<
      typeof VideoView
    >['onHandle'] = next => {
      tile = next
    }
    await show({ onHandle, gridTransport: true })
    const handle = tile as NonNullable<Parameters<typeof onHandle>[0]> | null
    if (handle == null) throw new Error('missing tile handle')
    await act(async () => {
      handle.playbackRate = 1.02
      await handle.play()
    })
    const holding = await handed({
      onHandle,
      gridTransport: true,
      deferGridRelease: true
    })
    expect(holding.rate).equals(0.25)
    expect(holding.muted).equals(true)
    expect(handle.playbackRate).equals(1.02)
    await act(async () => {
      handle.pause()
    })
    const paused = await handed({
      onHandle,
      gridTransport: true,
      deferGridRelease: true
    })
    expect(paused.paused).equals(true)
    expect(paused.rate).equals(0.25)
    const settled = await handed({
      onHandle,
      gridTransport: true,
      deferGridRelease: false
    })
    expect(settled.paused).equals(true)
    expect(settled.rate).equals(1.02)
  })
  it('takes the session through the silent switch when primary, with no controls', async function () {
    const props = await handed({ controls: false, primary: true })
    expect(props.controls).equals(false)
    expect(props.disableFocus).equals(false)
    expect(props.ignoreSilentSwitch).equals('ignore')
    // The app's own live pill, never ExoPlayer's badge as well.
    expect(props.controlsStyles).deep.equals({ hideLiveBadge: true })
  })

  it('leaves the session alone, obeying the switch, when not', async function () {
    const props = await handed({ controls: false, primary: false })
    expect(props.disableFocus).equals(true)
    expect(props.ignoreSilentSwitch).equals('obey')
    // A card's preview, which says neither, is not primary.
    const preview = await handed({})
    expect(preview.disableFocus).equals(true)
  })
})

describe("the phone's picture with no source (issue 317)", function () {
  it('releases the player for no source and keeps the handle, then takes the address again', async function () {
    const handles: unknown[] = []
    const onHandle = (handle: unknown): void => {
      handles.push(handle)
    }
    const first = await handed({ onHandle })
    expect(first.source).deep.include({
      uri: 'https://media.example.test/v1/index.m3u8'
    })
    const kept = handles.at(-1)
    expect(kept).not.equals(null)

    await show({ onHandle, source: null })
    expect(document.querySelector('[data-video-props]')).equals(null)
    expect(handles).not.includes(null)

    const again = await handed({ onHandle })
    expect(again.source).deep.equals(first.source)
    expect(handles.at(-1)).equals(kept)
  })
})

describe("the phone's picture and its buffer (U33a)", function () {
  it('loads half a minute ahead, alone or as a tile', async function () {
    expect((await handed({})).preferredForwardBufferDuration).equals(30)
    const tile = await handed({
      buffer: { aheadSec: 30, startSec: 5, behindSec: 20, heapShare: 0.15 }
    })
    expect(tile.preferredForwardBufferDuration).equals(30)
    expect(tile.bufferingStrategy).equals('DependingOnMemory')
  })
})

describe("the phone's picture and its volume (U27)", function () {
  it('hands the handle’s volume to the player, full until one is set', async function () {
    let handle: { volume: number } | undefined
    const onHandle = (given: unknown): void => {
      handle = given as { volume: number }
    }
    expect((await handed({ onHandle })).volume).equals(1)
    expect(handle?.volume).equals(1)
    await act(async () => {
      handle!.volume = 0.2
    })
    expect((await handed({ onHandle })).volume).equals(0.2)
  })
})
