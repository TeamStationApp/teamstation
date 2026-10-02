import { expect } from 'chai'
import { describe, it } from 'mocha'

import { orientationLock } from './orientationLock'

describe('turning the multi-camera view with the phone', function () {
  const recorder = (): {
    calls: string[]
    native: { allowRotation: () => void; lockPortrait: () => void }
  } => {
    const calls: string[] = []
    return {
      calls,
      native: {
        allowRotation: () => calls.push('allow'),
        lockPortrait: () => calls.push('portrait')
      }
    }
  }

  it('asks the Android activity to follow the phone, then stand upright', function () {
    const { calls, native } = recorder()
    const lock = orientationLock('android', native)
    lock.allow()
    lock.restore()
    expect(calls).deep.equals(['allow', 'portrait'])
  })

  it('leaves iOS to the modal', function () {
    const { calls, native } = recorder()
    const lock = orientationLock('ios', native)
    lock.allow()
    lock.restore()
    expect(calls).deep.equals([])
  })

  it('does nothing in a build without the module', function () {
    const lock = orientationLock('android', undefined)
    lock.allow()
    lock.restore()
  })
})
