import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { openNotificationSettings as openOnTheWeb } from './notificationSettings'

/**
 * React Native is replaced in the module cache by a registry of this test's,
 * as `pushDevice.native.test.ts` does.
 */
const reactNative = require.resolve('react-native')
const file = require.resolve('./notificationSettings.native')

/** The phone's module, loaded afresh with `push` as `TSPush`. */
function load(push: object | undefined): {
  openNotificationSettings: (
    module?: () => { openSettings: () => Promise<boolean> } | null
  ) => Promise<boolean>
} {
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
  return require('./notificationSettings.native') as ReturnType<typeof load>
}

describe('opening this device’s notification settings', function () {
  afterEach(() => {
    Reflect.deleteProperty(require.cache, reactNative)
    Reflect.deleteProperty(require.cache, file)
  })

  it('opens them through TSPush on a phone, and answers whether it could', async function () {
    let opened = 0
    const { openNotificationSettings } = load({
      openSettings: async () => {
        opened++
        return true
      }
    })
    expect(await openNotificationSettings()).equals(true)
    expect(opened).equals(1)
    const refusing = load({ openSettings: async () => false })
    expect(await refusing.openNotificationSettings()).equals(false)
  })

  it('answers false with no module, or one that fails', async function () {
    expect(await load(undefined).openNotificationSettings()).equals(false)
    const failing = load({
      openSettings: async () => {
        throw new Error('No activity')
      }
    })
    expect(await failing.openNotificationSettings()).equals(false)
  })

  it('cannot open a browser’s site settings', async function () {
    expect(await openOnTheWeb()).equals(false)
  })
})
