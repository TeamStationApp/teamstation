import { expect } from 'chai'
import { describe, it } from 'mocha'

import { orientationLock } from './orientationLock'

describe('turning the multi-camera view with the phone', function () {
  const recorder = (): {
    calls: string[]
    native: {
      allowRotation: () => void
      lockPortrait: () => void
      lockLandscape: () => void
    }
  } => {
    const calls: string[] = []
    return {
      calls,
      native: {
        allowRotation: () => calls.push('allow'),
        lockPortrait: () => calls.push('portrait'),
        lockLandscape: () => calls.push('landscape')
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

  it('holds the Android activity sideways for the streaming screen', function () {
    const { calls, native } = recorder()
    const lock = orientationLock('android', native)
    lock.lockLandscape()
    lock.restore()
    expect(calls).deep.equals(['landscape', 'portrait'])
  })

  it('leaves iOS to the modal', function () {
    const { calls, native } = recorder()
    const lock = orientationLock('ios', native)
    lock.allow()
    lock.lockLandscape()
    lock.restore()
    expect(calls).deep.equals([])
  })

  it('does nothing in a build without the module, or an older one', function () {
    const lock = orientationLock('android', undefined)
    lock.allow()
    lock.lockLandscape()
    lock.restore()
    const calls: string[] = []
    const older = orientationLock('android', {
      allowRotation: () => calls.push('allow'),
      lockPortrait: () => calls.push('portrait')
    })
    older.lockLandscape()
    expect(calls).deep.equals([])
  })
})
