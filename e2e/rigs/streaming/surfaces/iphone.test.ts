import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type Call, fakeDevice, jsonFixture, noSleep, png } from './fakes.test'
import type { HierarchyNode } from './hierarchy'
import { IphoneSurface } from './iphone'
import { MobileSafariSurface, SAFARI } from './mobileSafari'
import { NativeAppSurface } from './nativeApp'

function phone(): { iphone: IphoneSurface; calls: Call[] } {
  let front = 'app.example.develop'
  const { device, calls } = fakeDevice({
    hierarchy: () =>
      (front === SAFARI
        ? jsonFixture('safariHierarchy.json')
        : jsonFixture('nativeHierarchy.json')) as HierarchyNode,
    state: () => ({ foregroundApp: front }),
    screenshot: () => png(390, 844),
    launchApp: (arg: unknown) => {
      front = (arg as { appId: string }).appId
      return { status: 'passed' }
    }
  })
  const app = new NativeAppSurface({
    name: 'iphone-app',
    device,
    appId: 'app.example.develop',
    gameLink: 'https://app.example.test/games/game_0000',
    sleep: noSleep
  })
  const safari = new MobileSafariSurface({
    name: 'iphone-safari',
    device,
    gameUrl: 'https://app.example.test/games/game_0000',
    sleep: noSleep
  })
  return {
    iphone: new IphoneSurface({ device, app, safari, sleep: noSleep }),
    calls
  }
}

describe('the iPhone router', function () {
  it('starts in the app and sends every action to the surface in front', async function () {
    const { iphone, calls } = phone()
    expect(iphone.front).equals('app')
    expect(iphone.surface).equals('iphone-app')
    await iphone.join()
    expect(calls.some(call => call[0] === 'openLink')).equals(true)
    calls.length = 0
    await iphone.cut('PhoneA')
    expect(calls).deep.equals([['tapOn', { text: 'PhoneA angle' }]])
  })

  it("switches through the Home screen, opening Safari's tab once and bringing it back after", async function () {
    const { iphone, calls } = phone()
    calls.length = 0
    expect(await iphone.switchTo('safari')).deep.equals({ newTab: true })
    expect(calls[0]).deep.equals(['pressKey', 'HOME'])
    expect(calls.some(call => call[0] === 'inputText')).equals(true)
    expect(iphone.surface).equals('iphone-safari')
    const probe = await iphone.probe()
    expect(probe.foreground).equals(true)
    expect(probe.tiles!.map(tile => tile.notice)[1]).equals(
      'Camera catching up…'
    )
    calls.length = 0
    expect(await iphone.switchTo('app')).deep.equals({ newTab: false })
    expect(calls).deep.equals([
      ['pressKey', 'HOME'],
      ['launchApp', { appId: 'app.example.develop', stopApp: false }]
    ])
    calls.length = 0
    await iphone.switchTo('safari')
    expect(calls).deep.equals([
      ['pressKey', 'HOME'],
      ['launchApp', { appId: SAFARI, stopApp: false }]
    ])
    calls.length = 0
    expect(await iphone.switchTo('safari')).deep.equals({ newTab: false })
    expect(calls).deep.equals([])
  })

  it('routes each action kind', async function () {
    const { iphone, calls } = phone()
    await iphone.scrub(0.5)
    await iphone.rapidScrub([0.2], 1)
    await iphone.skip([10])
    await iphone.slowMotion(10)
    await iphone.jumpToPresent()
    await iphone.exitAndReenter(1)
    await iphone.relaunch()
    expect(calls.filter(call => call[0] === 'swipe')).length(2)
    expect(calls.some(call => call[0] === 'stopApp')).equals(true)
    expect(iphone.name).equals('iphone')
  })
})
