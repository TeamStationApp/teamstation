import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  appLink,
  openInApp,
  parseSetServerArgs,
  runSetServerCli,
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
      tapOn: record('tapOn'),
      assertVisible: record('assertVisible')
    }
  }
}

describe('setServer', function () {
  it('opens links on a hub iPhone through its leased driver', async function () {
    const { device, calls } = phone()
    await openInApp({
      platform: 'ios',
      udid: 'phone-1@hub',
      appId: 'app.teamstation.develop',
      link: appLink('chat'),
      device,
      run: async () => {
        throw new Error('The phone belongs to the hub')
      }
    })
    expect(calls).deep.equals([
      ['stopApp', { appId: 'app.teamstation.develop' }],
      ['openLink', { link: 'teamstation-develop://chat' }],
      ['tapOn', { text: 'Open', optional: true }]
    ])
  })

  it('opens a page of the app from a stopped app, by its develop link', async function () {
    expect(appLink('/groups/league/l1/scheduler')).equals(
      'teamstation-develop://groups/league/l1/scheduler'
    )
    const android = phone()
    await openInApp({
      platform: 'android',
      udid: 'phone-1',
      appId: 'app.teamstation.develop',
      link: appLink('chat'),
      device: android.device
    })
    expect(android.calls).deep.equals([
      ['stopApp', { appId: 'app.teamstation.develop' }],
      ['openLink', { link: 'teamstation-develop://chat' }]
    ])
    const iphone = phone()
    const ran: string[][] = []
    await openInApp({
      platform: 'ios',
      udid: 'phone-2',
      appId: 'app.teamstation.develop',
      link: appLink('chat'),
      device: iphone.device,
      run: async (file, args) => {
        ran.push([file, ...args])
      }
    })
    expect(iphone.calls.map(([name]) => name)).deep.equals(['stopApp'])
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
        'teamstation-develop://chat',
        'app.teamstation.develop'
      ]
    ])
  })

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

  it('hands a hub iPhone the link through its leased device, and answers the system’s Open', async function () {
    const { device, calls } = phone()
    const ran: string[][] = []
    await setServer({
      platform: 'ios',
      udid: 'PHONE-UDID@hub',
      appId: 'app.teamstation.develop',
      origin: 'https://develop3.teamstation.app',
      device,
      hub: true,
      run: async (file, args) => {
        ran.push([file, ...args])
      }
    })
    expect(ran, 'devicectl here cannot see a hub device').deep.equals([])
    expect(calls.map(([name]) => name)).deep.equals([
      'stopApp',
      'openLink',
      'tapOn',
      'assertVisible',
      'launchApp'
    ])
    expect(calls[1][1]).deep.equals({
      link: serverLink('ios', 'https://develop3.teamstation.app')
    })
    // Tapped only when the system asks; skipped when it does not.
    expect(calls[2][1]).deep.equals({ text: 'Open', optional: true })
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

  it('hands an iOS simulator the link through simctl', async function () {
    const sim = phone()
    const ran: string[][] = []
    await setServer({
      platform: 'ios',
      udid: 'sim-1',
      appId: 'app.teamstation.develop',
      origin: 'https://e2e-03.teamstation.app',
      device: sim.device,
      simulator: true,
      run: async (file, args) => {
        ran.push([file, ...args])
      }
    })
    expect(ran).deep.equals([
      [
        'xcrun',
        'simctl',
        'openurl',
        'sim-1',
        serverLink('ios', 'https://e2e-03.teamstation.app')
      ]
    ])
    expect(sim.calls.map(([name]) => name)).deep.equals([
      'stopApp',
      'assertVisible',
      'launchApp'
    ])
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

  it('runs its command line through a hub device, a local one and the TV, and always lets go', async function () {
    const calls: unknown[][] = []
    const deps = (simulator = false): any => ({
      connect: async (_settings: unknown, name: string) => {
        calls.push(['connect', name])
        return {
          attach: async () => ({}),
          shutdown: async () => calls.push(['shutdown'])
        }
      },
      attach: async (_daemon: unknown, _dir: string, options: unknown) => {
        calls.push(['attach', options])
        return {}
      },
      settings: () => ({}),
      isSimulator: () => simulator,
      point: async (options: any) => {
        calls.push(['point', options.platform, options.hub, options.simulator])
      },
      log: (line: string) => calls.push(['log', line])
    })
    const base = [
      '--app-id',
      'app.teamstation.develop',
      '--origin',
      'https://develop3.teamstation.app'
    ]
    await runSetServerCli(
      ['--platform', 'ios', '--device', 'u@hub', '--daemon', 'd', ...base],
      deps(true)
    )
    expect(calls).deep.equals([
      ['connect', 'd'],
      ['attach', { device: 'u@hub', appId: 'app.teamstation.develop' }],
      ['point', 'ios', true, false],
      ['shutdown'],
      [
        'log',
        'app.teamstation.develop on u@hub uses https://develop3.teamstation.app from its next launch, and is launched'
      ]
    ])
    calls.length = 0
    await runSetServerCli(
      ['--platform', 'ios', '--device', 'sim-1', ...base],
      deps(true)
    )
    expect(calls[2]).deep.equals(['point', 'ios', false, true])
    calls.length = 0
    await runSetServerCli(
      [
        '--platform',
        'tvos',
        '--device',
        'tv',
        '--app-id',
        'a',
        '--origin',
        'clear'
      ],
      deps()
    )
    expect(calls).deep.equals([
      ['point', 'tvos', undefined, undefined],
      [
        'log',
        'a on tv uses its own server from its next launch, and is launched'
      ]
    ])
    // A failure still lets the device go.
    calls.length = 0
    const failing = {
      ...deps(),
      point: async () => {
        throw new Error('no notice')
      }
    }
    let error: unknown
    try {
      await runSetServerCli(
        ['--platform', 'android', '--device', 'p@hub', ...base],
        failing
      )
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes('no notice')
    expect(calls.at(-1)).deep.equals(['shutdown'])
  })
})
