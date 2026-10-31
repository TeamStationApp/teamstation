import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  anchorAfterChromeChange,
  chatLayout,
  type ChatLayoutInput,
  keyboardOverlap
} from './chatLayoutModel'
import { bindPopupKeys, watchVisualViewport } from './chatWebInteractions'
import { watchVisualViewport as watchNativeVisualViewport } from './chatWebInteractions.native'

const base: ChatLayoutInput = {
  header: 48,
  paneHeader: 0,
  pins: 0,
  composer: 52,
  navigation: 70,
  navigationBottom: 16,
  safeBottom: 0,
  keyboardOpen: false,
  keyboardOverlap: 0,
  gap: 16
}

describe('chat overlay layout', function () {
  it('preserves a clipped reader and bottom-only geometry while revealing only a newly covered readable row edge', function () {
    for (const relativeY of [-700, 20, 200])
      expect(anchorAfterChromeChange(relativeY, 64, 64, 8)).equals(relativeY)
    expect(anchorAfterChromeChange(-700, 64, 96, 8)).equals(-700)
    expect(anchorAfterChromeChange(80, 64, 96, 8)).equals(104)
    expect(anchorAfterChromeChange(64, 64, 96, -1)).equals(96)
    expect(anchorAfterChromeChange(100, 64, 96, 8)).equals(100)
    expect(anchorAfterChromeChange(80, 96, 64, 8)).equals(80)
  })

  it('leaves one rem above the measured navigation while keeping the scroll frame full height', function () {
    expect(chatLayout(base)).deep.equals({
      readableTop: 48,
      contentTop: 64,
      composerBottom: 102,
      contentBottom: 170
    })
    expect(
      chatLayout({ ...base, navigationBottom: 34, safeBottom: 34 })
        .composerBottom
    ).equals(120)
    expect(chatLayout({ ...base, navigation: 0 }).composerBottom).equals(16)
    expect(
      chatLayout({ ...base, navigation: 0, safeBottom: 12 }).composerBottom
    ).equals(28)
  })

  it('counts keyboard occlusion exactly once on resized, covered and visual-viewport windows', function () {
    expect(keyboardOverlap(844, undefined)).equals(0)
    expect(keyboardOverlap(844, 544)).equals(300)
    expect(keyboardOverlap(544, 544)).equals(0)
    expect(keyboardOverlap(520, 544)).equals(0)
    expect(
      chatLayout({
        ...base,
        keyboardOpen: true,
        keyboardOverlap: keyboardOverlap(844, 544)
      }).composerBottom
    ).equals(308)
    expect(
      chatLayout({
        ...base,
        keyboardOpen: true,
        keyboardOverlap: keyboardOverlap(544, 544)
      }).composerBottom
    ).equals(8)
    expect(
      chatLayout({
        ...base,
        keyboardOpen: true,
        keyboardOverlap: keyboardOverlap(844, 514)
      }).composerBottom
    ).equals(338)
  })

  it('moves content clearances together for pane headers, pins and expanding composers', function () {
    const next = chatLayout({
      ...base,
      paneHeader: 56,
      pins: 40,
      composer: 140
    })
    expect(next.readableTop).equals(144)
    expect(next.contentTop).equals(160)
    expect(next.contentBottom).equals(258)
    expect(
      chatLayout({
        ...base,
        header: Number.NaN,
        composer: -1,
        gap: -1,
        navigation: 0,
        safeBottom: -1
      })
    ).deep.equals({
      readableTop: 0,
      contentTop: 0,
      composerBottom: 0,
      contentBottom: 0
    })
  })
})

describe('chat browser keyboard and focus handoff', function () {
  const original = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  let stop: (() => void) | undefined
  let editor: HTMLTextAreaElement | undefined
  afterEach(function () {
    stop?.()
    stop = undefined
    editor?.remove()
    editor = undefined
    if (original == null) Reflect.deleteProperty(window, 'visualViewport')
    else Object.defineProperty(window, 'visualViewport', original)
    if (originalHeight != null)
      Object.defineProperty(window, 'innerHeight', originalHeight)
    if (originalWidth != null)
      Object.defineProperty(window, 'innerWidth', originalWidth)
  })

  it('reports the actual visual bottom and releases every browser listener', function () {
    const viewport = new window.EventTarget() as EventTarget & {
      height: number
      offsetTop: number
      scale: number
    }
    viewport.height = window.innerHeight
    viewport.offsetTop = 0
    viewport.scale = 1
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport
    })
    const updates: Array<{ bottom: number; keyboardOpen: boolean }> = []
    stop = watchVisualViewport(value => updates.push(value))
    expect(updates.at(-1)?.keyboardOpen).equals(false)
    editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()
    viewport.height -= 250
    viewport.offsetTop = 10
    viewport.dispatchEvent(new window.Event('resize'))
    expect(updates.at(-1)).deep.equals({
      bottom: window.innerHeight - 240,
      keyboardOpen: true
    })
    const closed = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: closed - 240
    })
    viewport.dispatchEvent(new window.Event('scroll'))
    expect(updates.at(-1)?.keyboardOpen).equals(true)
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: window.innerWidth + 100
    })
    viewport.dispatchEvent(new window.Event('resize'))
    expect(updates.at(-1)?.keyboardOpen).equals(false)
    const count = updates.length
    stop()
    stop = undefined
    viewport.dispatchEvent(new window.Event('resize'))
    expect(updates.length).equals(count)
  })

  it('does not mistake a pinch-zoomed browser for an open keyboard', function () {
    const viewport = new window.EventTarget() as EventTarget & {
      height: number
      offsetTop: number
      scale: number
    }
    viewport.height = window.innerHeight
    viewport.offsetTop = 0
    viewport.scale = 1
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport
    })
    const updates: Array<{ bottom: number; keyboardOpen: boolean }> = []
    stop = watchVisualViewport(value => updates.push(value))
    // Zoomed to 1.5x and panned to the top: two thirds of the layout show.
    viewport.scale = 1.5
    viewport.height = window.innerHeight / 1.5
    viewport.dispatchEvent(new window.Event('resize'))
    expect(updates.at(-1)).deep.equals({
      bottom: window.innerHeight / 1.5,
      keyboardOpen: false
    })
    viewport.offsetTop = window.innerHeight / 3
    viewport.dispatchEvent(new window.Event('scroll'))
    expect(updates.at(-1)?.keyboardOpen).equals(false)
    // A keyboard while zoomed still leaves the screen short.
    editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()
    viewport.height -= 250 / 1.5
    viewport.dispatchEvent(new window.Event('resize'))
    expect(updates.at(-1)).deep.equals({
      bottom: window.innerHeight - 250 / 1.5,
      keyboardOpen: true
    })
  })

  it('leaves native and browsers without visualViewport independent of DOM keyboard APIs', function () {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined
    })
    const updates: unknown[] = []
    watchVisualViewport(value => updates.push(value))()
    watchNativeVisualViewport(value => updates.push(value))()
    expect(updates).deep.equals([])
  })

  it('preserves focus explicitly moved to the composer when the old popup cleans up', function () {
    const trigger = document.createElement('button')
    const panel = document.createElement('div')
    const action = document.createElement('button')
    const composer = document.createElement('textarea')
    panel.append(action)
    document.body.append(trigger, panel, composer)
    trigger.focus()
    stop = bindPopupKeys(panel, () => {})
    expect(document.activeElement).equals(action)
    composer.focus()
    stop()
    stop = undefined
    expect(document.activeElement).equals(composer)
  })
})
