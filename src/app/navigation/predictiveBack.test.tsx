import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native'

import { usePredictiveBack } from './predictiveBack.native'
import type { PredictiveBackHandlers } from './predictiveBackTypes'

describe('predictive back', function () {
  const originalOS = Platform.OS
  let root: Root | undefined
  let host: HTMLDivElement
  const enabled: boolean[] = []
  const heard: string[] = []
  let takes = true

  function Harness(props: { enabled: boolean }): null {
    const handlers: PredictiveBackHandlers = {
      enabled: props.enabled,
      onStart: () => heard.push('start'),
      onProgress: (progress, edge) =>
        heard.push(`progress ${progress}${edge === 'left' ? '' : ` ${edge}`}`),
      onCancel: () => heard.push('cancel'),
      onInvoke: () => {
        heard.push('invoke')
        return takes
      }
    }
    usePredictiveBack(handlers)
    return null
  }
  async function render(on: boolean, os = 'android'): Promise<void> {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
    // One module for the whole case, as on a phone.
    ;(NativeModules as Record<string, unknown>).TSPredictiveBack ??= {
      setEnabled: (value: boolean) => enabled.push(value),
      addListener: () => undefined,
      removeListeners: () => undefined
    }
    if (root == null) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(<Harness enabled={on} />)
    })
  }
  const send = async (event: Record<string, unknown>): Promise<void> => {
    await act(async () => {
      DeviceEventEmitter.emit('TSPredictiveBack', event)
    })
  }

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    enabled.length = 0
    heard.length = 0
    takes = true
    Object.defineProperty(Platform, 'OS', {
      value: originalOS,
      configurable: true
    })
    delete (NativeModules as Record<string, unknown>).TSPredictiveBack
  })

  it('maps the gesture to start, progress, cancel and invoke (U19)', async function () {
    await render(true)
    await send({ type: 'started', progress: 0, swipeEdge: 0 })
    await send({ type: 'progress', progress: 0.4, swipeEdge: 0 })
    await send({ type: 'cancelled' })
    await send({ type: 'invoked' })
    expect(heard).deep.equals(['start', 'progress 0.4', 'cancel', 'invoke'])
  })

  it('says which edge a gesture came from', async function () {
    await render(true)
    await send({ type: 'started', progress: 0, swipeEdge: 1 })
    await send({ type: 'progress', progress: 0.4, swipeEdge: 1 })
    // A preview from three-button navigation's Back has no edge.
    await send({ type: 'progress', progress: 0.2, swipeEdge: 2 })
    expect(heard).deep.equals([
      'start',
      'progress 0.4 right',
      'progress 0.2 none'
    ])
  })

  it('hands a press it could not take to BackHandler (U19)', async function () {
    await render(true)
    const pressed: string[] = []
    const subscription = DeviceEventEmitter.addListener(
      'hardwareBackPress',
      () => pressed.push('back')
    )
    try {
      await send({ type: 'invoked' })
      expect(pressed).deep.equals([])
      takes = false
      await send({ type: 'invoked' })
      expect(heard).deep.equals(['invoke', 'invoke'])
      expect(pressed).deep.equals(['back'])
    } finally {
      subscription.remove()
    }
  })

  it('turns the callback back on after a declined press, on the next render, while JS has it on', async function () {
    await render(true)
    const subscription = DeviceEventEmitter.addListener(
      'hardwareBackPress',
      () => undefined
    )
    try {
      takes = false
      await send({ type: 'invoked' })
      // Off for the press `BackHandler` now has.
      expect(enabled.at(-1)).equals(false)
      // The render that follows its move: on again, as JS still has it.
      await render(true)
      expect(enabled.at(-1)).equals(true)
    } finally {
      subscription.remove()
    }
  })

  it('follows enabled, and turns the callback off when it goes (U19)', async function () {
    await render(false)
    await render(true)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(enabled).deep.equals([false, true, false])
  })

  it('does nothing on an iPhone (U19)', async function () {
    await render(true, 'ios')
    await send({ type: 'started' })
    expect(enabled).deep.equals([])
    expect(heard).deep.equals([])
  })
})
