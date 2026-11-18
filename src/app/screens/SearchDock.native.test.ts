import Module from 'node:module'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type * as Dock from './SearchDock.native'

/**
 * Search's dock on a phone, over stand-ins for React Native,
 * react-native-keyboard-controller and Reanimated: what it asks of them is
 * the contract a device build relies on.
 */
describe('the Search dock on a phone', function () {
  let dock: typeof Dock
  const saved = new Map<string, NodeJS.Module | undefined>()
  const platform = { OS: 'android' }
  const enabled: boolean[] = []
  const controller = {
    setEnabled: (value: boolean) => enabled.push(value)
  }
  const dismissed: unknown[] = []
  let views: Record<string, Record<string, any>> = {}
  let keyboardVisible = false
  const hideListeners: Array<() => void> = []
  const keyboard = { height: { value: -300 }, progress: { value: 1 } }
  const stand = (name: string, exports: object): void => {
    const path = require.resolve(name)
    saved.set(path, require.cache[path])
    const module = new Module(path)
    module.filename = path
    module.loaded = true
    module.exports = exports
    require.cache[path] = module
  }
  const fresh = (path: string): void => {
    const resolved = require.resolve(path)
    saved.set(resolved, require.cache[resolved])
    Reflect.deleteProperty(require.cache, resolved)
  }

  before(async function () {
    stand('react-native', { Platform: platform })
    stand('react-native-keyboard-controller', {
      // One setter for the provider's life, as keyboard-controller's is.
      useKeyboardController: () => controller,
      useReanimatedKeyboardAnimation: () => keyboard,
      KeyboardController: {
        dismiss: async (options?: unknown) => {
          dismissed.push(options ?? 'animated')
        },
        isVisible: () => keyboardVisible
      },
      KeyboardEvents: {
        addListener: (_name: string, listener: () => void) => {
          hideListeners.push(listener)
          return {
            remove: () => {
              hideListeners.splice(hideListeners.indexOf(listener), 1)
            }
          }
        }
      }
    })
    stand('react-native-reanimated', {
      __esModule: true,
      default: {
        View: (props: Record<string, any>) => {
          views[String(props.testID)] = props
          return React.createElement('div', null, props.children)
        }
      },
      useAnimatedStyle: (style: () => object) => style()
    })
    fresh('../components/keyboardControllerOwner.native')
    fresh('./SearchDock.native')
    dock = await import('./SearchDock.native')
  })

  after(function () {
    for (const [path, module] of saved) {
      if (module != null) require.cache[path] = module
      else Reflect.deleteProperty(require.cache, path)
    }
  })

  let root: Root | undefined
  afterEach(async function () {
    if (root != null)
      await act(async () => {
        root!.unmount()
      })
    root = undefined
    document.body.replaceChildren()
    enabled.length = 0
    dismissed.length = 0
    views = {}
    keyboardVisible = false
    hideListeners.length = 0
    platform.OS = 'android'
  })

  async function render(element: React.ReactElement): Promise<void> {
    const host = document.createElement('div')
    document.body.append(host)
    root ??= createRoot(host)
    await act(async () => {
      root!.render(element)
    })
  }
  const docked = (active: boolean): React.ReactElement =>
    React.createElement(
      dock.SearchDock,
      {
        bottom: 96,
        gap: 12,
        active,
        style: { position: 'absolute' },
        onLayout: () => undefined
      },
      React.createElement('span', null, 'pills'),
      React.createElement('span', null, 'field')
    )

  it('rides the keyboard: at rest `bottom` up, and open with its foot `gap` above the keyboard', async function () {
    await render(docked(true))
    const dock = views['search-dock']
    // A 300-point keyboard all the way up, the dock 96 up at rest with 12
    // of air over the keyboard: up by 300 - (96 - 12).
    expect(dock.style).deep.equals([
      { position: 'absolute' },
      { bottom: 96 },
      { transform: [{ translateY: -216 }] }
    ])
    expect(dock.pointerEvents).equals('box-none')
    // The pills, then the field: the pills ride directly above it.
    expect(document.body.textContent).equals('pillsfield')
  })

  it('rises with the keyboard, less the room it stood clear by, and never sinks', function () {
    expect(dock.dockShift(-300, 1, 84)).equals(-216)
    expect(dock.dockShift(-150, 0.5, 84)).equals(-108)
    expect(dock.dockShift(0, 0, 84)).equals(0)
    // A hardware keyboard's 55-point bar: the dock stays where it rests.
    expect(dock.dockShift(-55, 1, 84)).equals(0)
  })

  it('holds the Android keyboard controller only while Search is on show', async function () {
    await render(docked(true))
    expect(enabled).deep.equals([true])
    await render(docked(false))
    expect(enabled).deep.equals([true, false])
    platform.OS = 'ios'
    await render(docked(true))
    expect(enabled, 'iOS keeps the root provider on').deep.equals([true, false])
  })

  it('makes room for the keyboard under the results on Android only', async function () {
    await render(React.createElement(dock.KeyboardSpacer))
    expect(views['search-keyboard-spacer']?.style).deep.equals({ height: 300 })
    views = {}
    platform.OS = 'ios'
    await render(React.createElement(dock.KeyboardSpacer))
    expect(
      views['search-keyboard-spacer'],
      'iOS insets the scroll view itself'
    ).equals(undefined)
  })

  it('puts the keyboard away with its own animation', async function () {
    dock.dismissKeyboard()
    await act(async () => undefined)
    expect(dismissed).deep.equals(['animated'])
  })
})
