import Module from 'node:module'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import * as web from './thisDevice'
import type * as NativeDevice from './thisDevice.native'

/**
 * What a sign-in says it is on: nothing from a browser, and from the phone
 * the name it gives chat, over a stand-in for React Native's `Platform`.
 */
describe('the device a sign-in is on', function () {
  let native: typeof NativeDevice
  let saved: NodeJS.Module | undefined
  let path = ''
  const platform: {
    OS: string
    isTV: boolean
    constants: Record<string, string>
  } = { OS: 'ios', isTV: false, constants: {} }

  before(async function () {
    path = require.resolve('react-native')
    saved = require.cache[path]
    const module = new Module(path)
    module.filename = path
    module.loaded = true
    module.exports = { Platform: platform }
    require.cache[path] = module
    native = await import('./thisDevice.native')
  })
  after(function () {
    if (saved != null) require.cache[path] = saved
    else Reflect.deleteProperty(require.cache, path)
  })

  it('sends nothing from a browser', function () {
    expect(web.signInDeviceModel()).equals(undefined)
  })

  it('names a phone, a tablet and an Android model as chat does', function () {
    Object.assign(platform, { OS: 'ios', isTV: false, constants: {} })
    expect(native.signInDeviceModel()).equals('iPhone')
    platform.constants = { interfaceIdiom: 'pad' }
    expect(native.signInDeviceModel()).equals('iPad')
    expect(native.signInDeviceModel()).equals(native.thisDevice().name)
    Object.assign(platform, {
      OS: 'android',
      constants: { Brand: 'samsung', Model: 'SM-S911B' }
    })
    expect(native.signInDeviceModel()).equals('samsung SM-S911B')
    expect(native.thisDevice()).deep.equals({
      name: 'samsung SM-S911B',
      platform: 'android'
    })
  })

  it('names a television by its kind', function () {
    Object.assign(platform, { OS: 'ios', isTV: true, constants: {} })
    expect(native.signInDeviceModel()).equals('Apple TV')
    platform.OS = 'android'
    expect(native.signInDeviceModel()).equals('Android TV')
  })
})
