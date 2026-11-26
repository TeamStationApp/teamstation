import { mock } from 'node:test'

import type { Canvas, CanvasProps } from '@react-three/fiber'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act, isValidElement } from 'react'
import { createRoot } from 'react-dom/client'

import { FieldCanvas } from './FieldCanvas'
import type { FieldScene } from './FieldScene'
import { watchFieldContext } from './watchFieldContext'

describe('web field visibility', function () {
  it('enables active motion time on the web canvas and pauses the scene while the page is hidden or play is paused', async function () {
    // Observe the props at the WebGL boundary, with no GPU needed.
    const fiber: { Canvas: typeof Canvas } = require('@react-three/fiber')
    const scene: Array<React.ComponentProps<typeof FieldScene>> = []
    const canvas = mock.method(fiber, 'Canvas', ({ children }: CanvasProps) => {
      if (isValidElement<React.ComponentProps<typeof FieldScene>>(children))
        scene.push(children.props)
      return null
    })
    const context = mock.method(
      HTMLCanvasElement.prototype,
      'getContext',
      () => ({ getExtension: () => null })
    )
    const hidden = mock.getter(document, 'hidden', () => false)
    const root = createRoot(document.createElement('div'))
    const field = (presentationPaused: boolean): React.ReactElement => (
      <FieldCanvas
        players={[]}
        view="home"
        selected=""
        zoom={1}
        onSelect={() => undefined}
        presentationPaused={presentationPaused}
      />
    )
    try {
      await act(async () => {
        root.render(field(false))
      })
      expect(scene.at(-1)?.activeMotionTime).equals(true)
      expect(scene.at(-1)?.presentationPaused).equals(false)
      await act(async () => {
        hidden.mock.mockImplementation(() => true)
        document.dispatchEvent(new window.Event('visibilitychange'))
      })
      expect(scene.at(-1)?.presentationPaused).equals(true)
      await act(async () => {
        hidden.mock.mockImplementation(() => false)
        document.dispatchEvent(new window.Event('visibilitychange'))
        root.render(field(true))
      })
      expect(scene.at(-1)?.presentationPaused).equals(true)
      await act(async () => {
        root.render(field(false))
      })
      expect(scene.at(-1)?.presentationPaused).equals(false)
    } finally {
      await act(async () => {
        root.unmount()
      })
      hidden.mock.restore()
      context.mock.restore()
      canvas.mock.restore()
    }
  })
})

describe('touch scoring shadows', function () {
  it('selects the basic sampler only for a touch scoring surface', async function () {
    const fiber: { Canvas: typeof Canvas } = require('@react-three/fiber')
    const modes: Array<CanvasProps['shadows']> = []
    const canvas = mock.method(fiber, 'Canvas', (props: CanvasProps) => {
      modes.push(props.shadows)
      return null
    })
    const context = mock.method(
      HTMLCanvasElement.prototype,
      'getContext',
      () => ({
        getExtension: () => null
      })
    )
    const touch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    const media = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const root = createRoot(document.createElement('div'))
    let coarse = true
    try {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        value: 5
      })
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: coarse })
      })
      for (const [key, scoring, pointer, expected] of [
        ['touch', true, true, 'basic'],
        ['touch', false, true, true],
        ['mouse', true, false, true]
      ] as const) {
        coarse = pointer
        await act(async () => {
          root.render(
            <FieldCanvas
              key={key}
              basicTouchShadows={scoring}
              players={[]}
              view="home"
              selected=""
              zoom={1}
              onSelect={() => undefined}
            />
          )
        })
        expect(modes.at(-1)).equals(expected)
      }
    } finally {
      await act(async () => {
        root.unmount()
      })
      if (touch == null) Reflect.deleteProperty(navigator, 'maxTouchPoints')
      else Object.defineProperty(navigator, 'maxTouchPoints', touch)
      if (media == null) Reflect.deleteProperty(window, 'matchMedia')
      else Object.defineProperty(window, 'matchMedia', media)
      context.mock.restore()
      canvas.mock.restore()
    }
  })
})

describe('web field context recovery', function () {
  it('keeps the renderer on restore, retries a lasting loss and cleans up loss listeners on route exit', function () {
    const canvas = document.createElement('canvas')
    let timeout: (() => void) | undefined
    const arm = mock.method(window, 'setTimeout', (fn: () => void) => {
      timeout = fn
      return 12
    })
    const disarm = mock.method(window, 'clearTimeout', () => {
      timeout = undefined
    })
    let interruptions = 0
    let redraws = 0
    let restarts = 0
    const stop = watchFieldContext(
      canvas,
      () => {
        interruptions++
      },
      () => {
        redraws++
      },
      () => {
        restarts++
      }
    )
    const lose = (): Event => {
      const event = new window.Event('webglcontextlost', { cancelable: true })
      canvas.dispatchEvent(event)
      return event
    }
    try {
      expect(lose().defaultPrevented).equals(true)
      lose()
      expect(interruptions).equals(1)
      expect(timeout).to.be.a('function')
      canvas.dispatchEvent(new window.Event('webglcontextrestored'))
      expect(timeout).equals(undefined)
      expect(redraws).equals(1)
      expect(restarts).equals(0)
      lose()
      timeout?.()
      expect(restarts).equals(1)
      lose()
      stop()
      expect(timeout).equals(undefined)
      expect(lose().defaultPrevented).equals(false)
      canvas.dispatchEvent(new window.Event('webglcontextrestored'))
      expect(redraws).equals(1)
    } finally {
      stop()
      arm.mock.restore()
      disarm.mock.restore()
    }
  })
  it('tries one replacement renderer and leaves the retry control available on permanent loss', async function () {
    const fiber: { Canvas: typeof Canvas } = require('@react-three/fiber')
    let created: CanvasProps['onCreated']
    const stub = mock.method(fiber, 'Canvas', (props: CanvasProps) => {
      created = props.onCreated
      return null
    })
    const support = mock.method(
      HTMLCanvasElement.prototype,
      'getContext',
      () => ({ getExtension: () => null })
    )
    const host = document.createElement('div')
    const root = createRoot(host)
    let failure: (() => void) | undefined
    const timer = mock.method(window, 'setTimeout', (fn: () => void) => {
      failure = fn
      return 12
    })
    const lose = (): void => {
      const canvas = document.createElement('canvas')
      created?.({
        gl: { domElement: canvas },
        invalidate: () => {}
      } as unknown as Parameters<NonNullable<CanvasProps['onCreated']>>[0])
      canvas.dispatchEvent(
        new window.Event('webglcontextlost', { cancelable: true })
      )
    }
    try {
      await act(async () => {
        root.render(
          <FieldCanvas
            players={[]}
            view="home"
            selected=""
            zoom={1}
            onSelect={() => undefined}
          />
        )
      })
      lose()
      await act(async () => failure?.())
      expect(host.textContent).not.includes('cannot start 3D')
      lose()
      await act(async () => failure?.())
      expect(host.textContent).includes('This browser cannot start 3D')
      expect(host.textContent).includes('Try again')
      await act(async () => {
        host.querySelector<HTMLElement>('[role="button"]')!.click()
      })
      expect(host.textContent).not.includes('cannot start 3D')
    } finally {
      await act(async () => {
        root.unmount()
      })
      stub.mock.restore()
      support.mock.restore()
      timer.mock.restore()
    }
  })
})
