import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BoundaryTimers } from './boundaries'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('one-shot boundaries', () => {
  it('fires once at its moment, and a later arming replaces it', async () => {
    const timers = new BoundaryTimers()
    const fired: string[] = []
    timers.arm('u:badge', Date.now() + 30, () => fired.push('first'))
    timers.arm('u:badge', Date.now() + 60, () => fired.push('second'))
    expect(timers.has('u:badge')).equals(true)
    await wait(100)
    expect(fired).deep.equals(['second'])
    expect(timers.has('u:badge')).equals(false)
  })

  it('keeps the sooner of two moments, and takes a later one once it has fired', async () => {
    const timers = new BoundaryTimers()
    const fired: string[] = []
    timers.armEarliest('u:offlineSet', Date.now() + 30, () =>
      fired.push('sooner')
    )
    timers.armEarliest('u:offlineSet', Date.now() + 60, () =>
      fired.push('later')
    )
    await wait(100)
    expect(fired).deep.equals(['sooner'])
    timers.armEarliest('u:offlineSet', Date.now() + 20, () =>
      fired.push('next')
    )
    timers.armEarliest('u:offlineSet', Date.now() + 5, () =>
      fired.push('sooner still')
    )
    await wait(60)
    expect(fired).deep.equals(['sooner', 'sooner still'])
  })

  it('fires a moment already past at once, and drops or clears what waits', async () => {
    const timers = new BoundaryTimers()
    const fired: string[] = []
    timers.arm('past', Date.now() - 1000, () => fired.push('past'))
    timers.arm('dropped', Date.now() + 20, () => fired.push('dropped'))
    timers.arm('cleared', Date.now() + 20, () => fired.push('cleared'))
    timers.drop('dropped')
    timers.drop('nothing')
    await wait(5)
    timers.clear()
    await wait(50)
    expect(fired).deep.equals(['past'])
  })

  it('waits again when its clock says the moment has not come', async () => {
    let now = 0
    const timers = new BoundaryTimers(() => now)
    const fired: number[] = []
    timers.arm('k', 40, () => fired.push(now))
    now = 10
    await wait(60)
    expect(fired, 'early by its clock').deep.equals([])
    now = 50
    await wait(60)
    expect(fired).deep.equals([50])
  })
})
