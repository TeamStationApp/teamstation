import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  parseSetServerArgs,
  type ServerDevice,
  serverLink,
  setServer
} from './setServer'

function phone(): { device: ServerDevice; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  const record = (name: string) => async (options: unknown) => {
    calls.push([name, options])
  }
  return {
    calls,
    device: {
      launchApp: record('launchApp'),
      stopApp: record('stopApp'),
      openLink: record('openLink'),
      assertVisible: record('assertVisible')
    }
  }
}

describe('setServer', function () {
  it('names the server in its develop build’s own link', function () {
    expect(serverLink('ios', 'https://e2e-03.teamstation.app')).equals(
      'teamstation-develop://server?origin=https%3A%2F%2Fe2e-03.teamstation.app'
    )
    expect(serverLink('tvos', 'https://e2e-03.teamstation.app')).matches(
      /^teamstationtv-develop:\/\/server\?origin=/
    )
    expect(serverLink('android', null)).equals(
      'teamstation-develop://server?clear=1'
    )
  })

  it('opens the link on a phone, waits for the app to keep it, then launches it fresh', async function () {
    const { device, calls } = phone()
    await setServer({
      platform: 'android',
      udid: 'phone-1',
      appId: 'app.teamstation.develop',
      origin: 'https://e2e-03.teamstation.app',
      device
    })
    expect(calls.map(([name]) => name)).deep.equals([
      'stopApp',
      'openLink',
      'assertVisible',
      'launchApp'
    ])
    expect(calls[1][1]).deep.equals({
      link: serverLink('android', 'https://e2e-03.teamstation.app')
    })
    expect(String((calls[2][1] as { text: string }).text)).includes(
      'e2e-03\\.teamstation\\.app'
    )
    expect(calls[3][1]).deep.equals({
      appId: 'app.teamstation.develop',
      stopApp: true
    })
    // An iPhone gets the link handed to the develop app by its id.
    const iphone = phone()
    const ran: string[][] = []
    await setServer({
      platform: 'ios',
      udid: 'phone-2',
      appId: 'app.teamstation.develop',
      origin: 'https://e2e-03.teamstation.app',
      device: iphone.device,
      run: async (file, args) => {
        ran.push([file, ...args])
      }
    })
    expect(iphone.calls.map(([name]) => name)).deep.equals([
      'stopApp',
      'assertVisible',
      'launchApp'
    ])
    expect(ran).deep.equals([
      [
        'xcrun',
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        'phone-2',
        '--terminate-existing',
        '--payload-url',
        serverLink('ios', 'https://e2e-03.teamstation.app'),
        'app.teamstation.develop'
      ]
    ])
    let failure: unknown
    await setServer({
      platform: 'android',
      udid: 'p',
      appId: 'a',
      origin: null
    }).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('needs a maestro-d device')
  })

  it('launches the TV with the link, then plainly', async function () {
    const ran: string[][] = []
    await setServer({
      platform: 'tvos',
      udid: 'tv-1',
      appId: 'app.teamstation.tv',
      origin: 'https://e2e-03.teamstation.app',
      run: async (file, args) => {
        ran.push([file, ...args])
      },
      sleep: async () => {}
    })
    expect(ran).deep.equals([
      [
        'xcrun',
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        'tv-1',
        '--terminate-existing',
        '--payload-url',
        serverLink('tvos', 'https://e2e-03.teamstation.app'),
        'app.teamstation.tv'
      ],
      [
        'xcrun',
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        'tv-1',
        '--terminate-existing',
        'app.teamstation.tv'
      ]
    ])
  })

  it('reads its command line', function () {
    expect(
      parseSetServerArgs([
        '--platform',
        'tvos',
        '--device',
        'tv-1',
        '--app-id',
        'a',
        '--origin',
        'clear',
        '--daemon',
        'd'
      ])
    ).deep.equals({
      platform: 'tvos',
      udid: 'tv-1',
      appId: 'a',
      origin: null,
      daemon: 'd'
    })
    expect(() => parseSetServerArgs(['--platform', 'web'])).to.throw(
      'ios, android or tvos'
    )
    expect(() =>
      parseSetServerArgs(['--platform', 'ios', '--device', 'x'])
    ).to.throw('--app-id is needed')
    expect(() => parseSetServerArgs(['--platform'])).to.throw(
      'unknown or empty option'
    )
  })
})
