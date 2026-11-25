import { expect } from 'chai'
import { describe, it } from 'mocha'

import { whenBack } from './whenBack'

/** The page's visibility, as the browser would set it. */
function show(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new window.Event('visibilitychange'))
}

describe('waiting for the network or the page to come back', () => {
  it('runs once, when the network comes back, and stops listening', () => {
    let runs = 0
    whenBack(() => {
      runs++
    })
    window.dispatchEvent(new window.Event('online'))
    window.dispatchEvent(new window.Event('online'))
    show('visible')
    expect(runs).equals(1)
  })

  it('runs once, when the page is shown again, not while it is hidden', () => {
    let runs = 0
    whenBack(() => {
      runs++
    })
    show('hidden')
    expect(runs).equals(0)
    show('visible')
    show('visible')
    expect(runs).equals(1)
  })

  it('runs nothing once stopped', () => {
    let runs = 0
    const stop = whenBack(() => {
      runs++
    })
    stop()
    window.dispatchEvent(new window.Event('online'))
    show('visible')
    expect(runs).equals(0)
  })
})
