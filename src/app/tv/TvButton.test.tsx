import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { emitTvDirection } from '../../test/tvRemoteRuntime'
import { TvButton } from './TvButton'

describe('TV button upward focus recovery', () => {
  it('handles a separate upward gesture only while focused and removes its listener on blur', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    const originalNow = Date.now
    let now = 1000
    let upward = 0
    Date.now = () => now
    try {
      await act(async () => {
        root.render(
          <TvButton
            label="Watch"
            onPress={() => undefined}
            onUp={() => {
              upward++
            }}
          />
        )
      })
      emitTvDirection('up')
      expect(upward).equals(0)
      await act(async () => {
        element.querySelector<HTMLElement>('[role="button"]')!.focus()
      })
      emitTvDirection('up') // The gesture that arrived at Watch must stop there.
      expect(upward).equals(0)
      now += 101
      emitTvDirection('right')
      emitTvDirection('longUp')
      expect(upward).equals(0)
      emitTvDirection('up')
      emitTvDirection('swipeUp')
      expect(upward).equals(2)
      await act(async () => {
        element.querySelector<HTMLElement>('[role="button"]')!.blur()
      })
      emitTvDirection('up')
      expect(upward).equals(2)
    } finally {
      Date.now = originalNow
      await act(async () => {
        root.unmount()
      })
      element.remove()
    }
  })
})
