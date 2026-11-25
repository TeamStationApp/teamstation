import Module from 'node:module'

import { expect } from 'chai'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Animated as RNAnimated } from 'react-native'

import type { ChatComposerBandProps } from './ChatViewport'

describe('phone composer keyboard attachments', function () {
  const saved = new Map<string, NodeJS.Module | undefined>()
  const androidPath = require.resolve('./ChatComposerBand.android')
  const iosPath = require.resolve('./ChatComposerBand.ios')
  const platform = { OS: 'ios', isPad: false }
  const Animated =
    require('react-native-web/dist/cjs/exports/Animated') as typeof RNAnimated
  const height = new Animated.Value(0)
  const progress = new Animated.Value(0)
  let root: Root
  let host: HTMLDivElement
  let android: React.ComponentType<ChatComposerBandProps>
  let ios: typeof android
  let band: {
    testID: string
    style: [
      unknown,
      {
        bottom: number
        transform?: Array<{ translateY: number | { __getValue: () => number } }>
      }
    ]
    children: React.ReactNode
  }
  let dock: { dockClearance?: number; style: [unknown, { zIndex: number }] }
  let bandRenders = 0
  function stand(name: string, exports: object): void {
    const path = require.resolve(name)
    saved.set(path, require.cache[path])
    const module = new Module(path)
    module.filename = path
    module.loaded = true
    module.exports = exports
    require.cache[path] = module
  }
  function Band(props: typeof band): React.ReactNode {
    band = props
    bandRenders++
    return props.children
  }
  before(function () {
    stand('react-native', {
      Animated: { ...Animated, View: Band },
      View: Band,
      Platform: platform,
      StyleSheet: {
        absoluteFill: { position: 'absolute' },
        flatten: (style: object) => style
      },
      requireNativeComponent: (name: string) => {
        expect(name).equals('TSChatComposerDock')
        return (
          props: typeof dock & { children: React.ReactNode }
        ): React.ReactNode => {
          dock = props
          return props.children
        }
      }
    })
    stand('react-native-keyboard-controller', {
      useKeyboardContext: () => ({ animated: { height, progress } })
    })
    stand('./ChatComposerBand.native', {
      ChatComposerBand: () => React.createElement('span', null, 'Tablet guide')
    })
    for (const path of [androidPath, iosPath]) {
      saved.set(path, require.cache[path])
      Reflect.deleteProperty(require.cache, path)
    }
    android = require(androidPath).ChatComposerBand
    ios = require(iosPath).ChatComposerBand
  })
  after(function () {
    for (const [path, module] of saved) {
      if (module != null) require.cache[path] = module
      else Reflect.deleteProperty(require.cache, path)
    }
  })
  beforeEach(function () {
    host = document.createElement('div')
    root = createRoot(host)
    platform.isPad = false
    height.setValue(0)
    progress.setValue(0)
  })
  afterEach(function () {
    act(() => {
      root.unmount()
    })
  })
  function show(
    component: typeof android,
    active = true,
    follow = true,
    consumed = 0
  ): void {
    const props: ChatComposerBandProps = {
      active,
      frame: undefined,
      style: { zIndex: 8 },
      testID: 'composer',
      viewport: {
        composerDock: { bottom: 80, gap: 8, consumed, follow },
        composerBottom: 36
      }
    }
    act(() => {
      root.render(React.createElement(component, props, 'Draft'))
    })
  }
  function translation(): number {
    const node = band.style[1].transform![0].translateY
    return typeof node === 'number' ? node : node.__getValue()
  }
  function sample(
    imeHeight: number,
    imeProgress: number,
    expected: number
  ): void {
    height.setValue(-imeHeight)
    progress.setValue(imeProgress)
    expect(translation()).closeTo(expected, 0.00001)
  }
  it('moves the mounted Android composer from its first native event through interruption and return', function () {
    show(android)
    const renders = bandRenders
    expect(band.style[1].bottom).equals(80)
    expect(host.textContent).equals('Draft')
    sample(0, 0, 0)
    sample(60, 0.2, -45.6)
    sample(180, 0.6, -136.8)
    sample(110, 0.38, -82.64)
    sample(300, 1, -228)
    sample(0, 0, 0)
    sample(10, 1, 0)
    expect(bandRenders).equals(renders)
  })
  it('deducts only the Android inset already consumed by the window and releases the attachment handoff', function () {
    show(android, true, true, 50)
    sample(20, 0, 0)
    sample(240, 1, -118)
    const nativeTransform = band.style[1].transform![0].translateY
    show(android, true, false, 50)
    expect(band.style[1].transform![0].translateY).equals(nativeTransform)
    expect(translation()).equals(0)
    expect(band.style[1].bottom).equals(36)
    sample(120, 0.5, 0)
    show(android, true, true, 50)
    expect(band.style[1].transform![0].translateY).equals(nativeTransform)
    expect(translation()).equals(-34)
    show(android, false)
    sample(260, 1, 0)
    expect(band.testID).equals('composer')
  })
  it('anchors the iPhone draft to the native guide and releases it while the drawer owns the composer', function () {
    show(ios)
    expect(dock.dockClearance).equals(72)
    expect(dock.style[1].zIndex).equals(8)
    expect(band.style[1].bottom).equals(80)
    expect(host.textContent).equals('Draft')
    show(ios, true, false)
    expect(dock.dockClearance).equals(undefined)
    expect(band.style[1].bottom).equals(36)
    show(ios, false)
    expect(dock.dockClearance).equals(undefined)
    expect(band.testID).equals('composer')
  })
  it('continues routing iPad to its existing tablet keyboard guide', function () {
    platform.isPad = true
    show(ios)
    expect(host.textContent).equals('Tablet guide')
  })
})
