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

  function Harness(props: { enabled: boolean }): null {
    const handlers: PredictiveBackHandlers = {
      enabled: props.enabled,
      onStart: () => heard.push('start'),
      onProgress: progress => heard.push(`progress ${progress}`),
      onCancel: () => heard.push('cancel'),
      onInvoke: () => heard.push('invoke')
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
