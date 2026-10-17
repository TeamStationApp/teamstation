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
      followSensor: () => void
    }
  } => {
    const calls: string[] = []
    return {
      calls,
      native: {
        allowRotation: () => calls.push('allow'),
        lockPortrait: () => calls.push('portrait'),
        lockLandscape: () => calls.push('landscape'),
        followSensor: () => calls.push('sensor')
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

  it('lets the streaming settings follow the sensor, then holds sideways again', function () {
    const { calls, native } = recorder()
    const lock = orientationLock('android', native)
    lock.lockLandscape()
    lock.followSensor()
    lock.lockLandscape()
    lock.restore()
    expect(calls).deep.equals(['landscape', 'sensor', 'landscape', 'portrait'])
  })

  it('keeps the multi-camera view on the rotation lock, not the sensor', function () {
    const { calls, native } = recorder()
    orientationLock('android', native).allow()
    expect(calls).deep.equals(['allow'])
  })

  it('leaves iOS to the modal', function () {
    const { calls, native } = recorder()
    const lock = orientationLock('ios', native)
    lock.allow()
    lock.lockLandscape()
    lock.followSensor()
    lock.restore()
    expect(calls).deep.equals([])
  })

  it('does nothing in a build without the module, or an older one', function () {
    const lock = orientationLock('android', undefined)
    lock.allow()
    lock.lockLandscape()
    lock.followSensor()
    lock.restore()
    const calls: string[] = []
    const older = orientationLock('android', {
      allowRotation: () => calls.push('allow'),
      lockPortrait: () => calls.push('portrait')
    })
    older.lockLandscape()
    expect(calls).deep.equals([])
    // Without `followSensor`, settings still turns, on the rotation lock.
    older.followSensor()
    expect(calls).deep.equals(['allow'])
  })
})
