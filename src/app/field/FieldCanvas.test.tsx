import { mock } from 'node:test'

import type { Canvas, CanvasProps } from '@react-three/fiber'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act, isValidElement } from 'react'
import { createRoot } from 'react-dom/client'

import { FieldCanvas } from './FieldCanvas'
import type { FieldScene } from './FieldScene'

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
