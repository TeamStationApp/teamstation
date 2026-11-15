import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userAgents } from '../../test/userAgents'
import { appType, type DeviceFacts, deviceLabel } from './deviceLabels'

const facts = (patch: Partial<DeviceFacts>): DeviceFacts => ({
  deviceName: null,
  chatDeviceName: null,
  chatPlatform: null,
  userAgent: null,
  ...patch
})

describe('device labels', function () {
  it('names the device by what it signed in as, then by chat, then by its agent', function () {
    expect(
      deviceLabel(
        facts({
          deviceName: ' Dugout iPad ',
          chatDeviceName: 'iPad',
          userAgent: userAgents.nativeApple
        })
      )
    ).equals('Dugout iPad')
    expect(
      deviceLabel(
        facts({
          deviceName: ' ',
          chatDeviceName: 'Samsung SM-S911B',
          userAgent: userAgents.nativeAndroid
        })
      )
    ).equals('Samsung SM-S911B')
    expect(deviceLabel(facts({ userAgent: userAgents.iPhoneSafari }))).equals(
      'iPhone'
    )
    expect(deviceLabel(facts({ userAgent: userAgents.iPadSafari }))).equals(
      'iPad'
    )
  })

  it('reads an Android model when the agent keeps one, and not Chrome’s K', function () {
    expect(
      deviceLabel(facts({ userAgent: userAgents.androidWithModel }))
    ).equals('Pixel 8')
    expect(
      deviceLabel(facts({ userAgent: userAgents.androidChromeReduced }))
    ).equals('Android device')
    expect(deviceLabel(facts({ userAgent: userAgents.nativeAndroid }))).equals(
      'Android device'
    )
    expect(deviceLabel(facts({ userAgent: 'Android tablet' }))).equals(
      'Android device'
    )
  })

  it('names computers, and says when nothing is known', function () {
    expect(deviceLabel(facts({ userAgent: userAgents.macChrome }))).equals(
      'Mac'
    )
    expect(deviceLabel(facts({ userAgent: userAgents.windowsEdge }))).equals(
      'Windows PC'
    )
    expect(deviceLabel(facts({ userAgent: userAgents.linuxFirefox }))).equals(
      'Linux PC'
    )
    expect(deviceLabel(facts({ userAgent: userAgents.nativeApple }))).equals(
      'Unknown device'
    )
    expect(deviceLabel(facts({ userAgent: userAgents.curl }))).equals(
      'Unknown device'
    )
    expect(deviceLabel(facts({}))).equals('Unknown device')
  })

  it('tells the app from a TV’s name, chat’s platform, then the agent', function () {
    expect(appType(facts({ deviceName: 'Apple TV' }))).equals('tvOS')
    expect(appType(facts({ deviceName: 'Google TV' }))).equals('Android')
    expect(appType(facts({ deviceName: 'Android TV' }))).equals('Android')
    expect(
      appType(facts({ chatPlatform: 'web', userAgent: userAgents.nativeApple }))
    ).equals('Web')
    expect(appType(facts({ chatPlatform: 'ios' }))).equals('iOS')
    expect(appType(facts({ chatPlatform: 'android' }))).equals('Android')
    expect(appType(facts({ userAgent: userAgents.iPhoneSafari }))).equals('Web')
    expect(appType(facts({ userAgent: userAgents.nativeAndroid }))).equals(
      'Android'
    )
    expect(appType(facts({ userAgent: 'Dalvik/2.1.0' }))).equals('Android')
    expect(
      appType(
        facts({ deviceName: 'iPhone', userAgent: userAgents.nativeApple })
      )
    ).equals('iOS')
    expect(appType(facts({ userAgent: userAgents.curl }))).equals('Unknown')
    expect(appType(facts({}))).equals('Unknown')
  })
})
