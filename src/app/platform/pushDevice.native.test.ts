import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { PushDevice } from './pushState'

/**
 * A phone's notifications through `TSPush`, the app's own module. React
 * Native is replaced in the module cache by a registry of this test's, as
 * `NativeChatCrypto.test.ts` does.
 */
const reactNative = require.resolve('react-native')
const file = require.resolve('./pushDevice.native')

function loadWith(push: object | undefined): PushDevice {
  Reflect.deleteProperty(require.cache, file)
  require.cache[reactNative] = {
    id: reactNative,
    filename: reactNative,
    loaded: true,
    exports: {
      TurboModuleRegistry: {
        get: (name: string) => (name === 'TSPush' ? push : null)
      }
    }
  } as unknown as NodeJS.Module
  return (require('./pushDevice.native') as { pushDevice: PushDevice })
    .pushDevice
}

/** `TSPush`, now in `permission`, answering a request with `answer`. */
function module(
  permission: string,
  answer: string
): {
  asked: number
  permissionState: () => Promise<string>
  requestPermission: () => Promise<string>
} {
  const push = {
    asked: 0,
    permissionState: async () => permission,
    requestPermission: async () => {
      push.asked++
      permission = answer
      return answer
    }
  }
  return push
}

describe('notifications on a phone', function () {
  afterEach(function () {
    Reflect.deleteProperty(require.cache, file)
    Reflect.deleteProperty(require.cache, reactNative)
  })

  it('reads the phone’s permission without asking', async function () {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      const push = module(state, 'granted')
      const device = loadWith(push)
      expect(await device.state()).equals(state)
      expect(await device.sync()).equals(state)
      expect(push.asked).equals(0)
    }
    expect(await loadWith(module('restricted', 'granted')).state()).equals(
      'unsupported'
    )
  })

  it('asks only when not asked yet, and answers what the person chose', async function () {
    const allowed = module('prompt', 'granted')
    expect(await loadWith(allowed).enable()).equals('granted')
    const refused = module('prompt', 'denied')
    expect(await loadWith(refused).enable()).equals('denied')
    const blocked = module('denied', 'granted')
    expect(await loadWith(blocked).enable()).equals('denied')
    expect(blocked.asked).equals(0)
  })

  it('cannot notify in a build without the module', async function () {
    const device = loadWith(undefined)
    expect(await device.state()).equals('unsupported')
    expect(await device.enable()).equals('unsupported')
  })
})
