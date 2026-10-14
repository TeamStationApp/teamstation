import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { NativeOrientation } from '../player/multiCam/orientationLock'
import { applyCameraOrientation } from './cameraOrientation'

describe('the camera orientation', function () {
  function native(): { calls: string[] } & NativeOrientation {
    const calls: string[] = []
    return {
      calls,
      allowRotation: () => {
        calls.push('any')
      },
      lockLandscape: () => {
        calls.push('landscape')
      },
      lockPortrait: () => {
        calls.push('portrait')
      }
    }
  }

  it('asks iOS for landscape, every orientation, and portrait', function () {
    const module = native()
    applyCameraOrientation('ios', module, 'landscape')
    applyCameraOrientation('ios', module, 'any')
    applyCameraOrientation('ios', module, 'portrait')
    expect(module.calls).deep.equals(['landscape', 'any', 'portrait'])
  })

  it('leaves Android and a missing module alone', function () {
    const module = native()
    applyCameraOrientation('android', module, 'landscape')
    applyCameraOrientation('ios', undefined, 'portrait')
    applyCameraOrientation('ios', null, 'any')
    expect(module.calls).deep.equals([])
  })
})
