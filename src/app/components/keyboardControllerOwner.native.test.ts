import Module from 'node:module'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type * as Owner from './keyboardControllerOwner.native'

/**
 * The Android keyboard coordination's owners, over stand-ins for React
 * Native and react-native-keyboard-controller: a screen that rides the
 * keyboard holds it on while shown, and the last to let go turns it off.
 */
describe('the keyboard controller owner', function () {
  let owner: typeof Owner
  const saved = new Map<string, NodeJS.Module | undefined>()
  const platform = { OS: 'android' }
  const enabled: boolean[] = []
  const controller = {
    setEnabled: (value: boolean) => enabled.push(value)
  }
  let keyboardVisible = false
  const hideListeners: Array<() => void> = []
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
      KeyboardController: { isVisible: () => keyboardVisible },
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
    fresh('./keyboardControllerOwner.native')
    owner = await import('./keyboardControllerOwner.native')
  })

  after(function () {
    for (const [path, module] of saved) {
      if (module != null) require.cache[path] = module
      else Reflect.deleteProperty(require.cache, path)
    }
  })

  const roots: Root[] = []
  afterEach(async function () {
    for (const root of roots.splice(0))
      await act(async () => {
        root.unmount()
      })
    document.body.replaceChildren()
    enabled.length = 0
    keyboardVisible = false
    hideListeners.length = 0
    platform.OS = 'android'
  })

  function Holder(props: { active: boolean }): null {
    owner.useKeyboardControllerOwner(props.active)
    return null
  }
  async function hold(
    active: boolean
  ): Promise<(next: boolean) => Promise<void>> {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(React.createElement(Holder, { active }))
    })
    return async next => {
      await act(async () => {
        root.render(React.createElement(Holder, { active: next }))
      })
    }
  }

  it('holds the controller on while shown on Android, and lets go when covered', async function () {
    const set = await hold(true)
    expect(enabled).deep.equals([true])
    await set(false)
    expect(enabled).deep.equals([true, false])
    await set(true)
    expect(enabled).deep.equals([true, false, true])
  })

  it('keeps it on until the last of two owners lets go, and on unmount', async function () {
    await hold(true)
    const chat = await hold(true)
    expect(enabled).deep.equals([true, true])
    await chat(false)
    expect(enabled, 'Search still holds it').deep.equals([true, true])
    await act(async () => {
      roots.pop()!.unmount()
    })
    await act(async () => {
      roots.pop()!.unmount()
    })
    expect(enabled).deep.equals([true, true, false])
  })

  it('lets go only once the keyboard has hidden, when its screen leaves mid-keyboard', async function () {
    await hold(true)
    keyboardVisible = true
    await act(async () => {
      roots.pop()!.unmount()
    })
    expect(enabled, 'still held while the keyboard hides').deep.equals([true])
    await act(async () => {
      for (const listener of [...hideListeners]) listener()
    })
    expect(enabled, 'let go once it has hidden').deep.equals([true, false])
  })

  it('lets go after a second if the keyboard never says it hid', async function () {
    const set = await hold(true)
    keyboardVisible = true
    await set(false)
    expect(enabled).deep.equals([true])
    await act(async () => {
      await new Promise(resolve =>
        setTimeout(resolve, owner.RELEASE_FALLBACK_MS + 50)
      )
    })
    expect(enabled).deep.equals([true, false])
  })

  it('stays on when another screen takes it up while the first is still letting go', async function () {
    const set = await hold(true)
    keyboardVisible = true
    await set(false)
    await hold(true)
    await act(async () => {
      for (const listener of [...hideListeners]) listener()
    })
    expect(enabled, 'never turned off: the second still holds it').not.includes(
      false
    )
  })

  it('asks nothing while not shown, and nothing at all on iOS', async function () {
    await hold(false)
    expect(enabled).deep.equals([])
    platform.OS = 'ios'
    await hold(true)
    expect(enabled).deep.equals([])
  })
})
