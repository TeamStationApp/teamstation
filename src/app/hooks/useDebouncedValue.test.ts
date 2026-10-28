import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { heldTimers } from '../../test/fakeScreenScope'
import { useDebouncedValue } from './useDebouncedValue'

let root: Root | undefined
let timers: ReturnType<typeof heldTimers> | undefined
const seen: string[] = []

function Probe({ value }: { value: string }): null {
  seen.push(useDebouncedValue(value, 500))
  return null
}
async function show(value: string): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(Probe, { value }))
  })
}

describe('useDebouncedValue', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
    seen.length = 0
  })

  it('answers the first value at once, and each later one after it holds still for the delay', async () => {
    timers = heldTimers(500)
    root = createRoot(document.createElement('div'))
    await show('')
    expect(seen.at(-1)).equals('')
    await show('B')
    await show('Be')
    await show('Bet')
    // Each change cleared the wait before it: one timer is left.
    expect(timers.pending()).equals(1)
    expect(seen.at(-1)).equals('')
    await act(async () => {
      timers!.fire()
    })
    expect(seen.at(-1)).equals('Bet')
    expect(seen).not.includes('B')
    expect(seen).not.includes('Be')
  })
})
