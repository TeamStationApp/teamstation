import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isHubDevice, type MaestroDaemon } from './maestro'
import {
  installedPackage,
  iosIsPhysical,
  prepareApp,
  prepareAppOnHub,
  preparesOnHub
} from './prepare'
import { BlockedError, HarnessError } from './result'

function thrown(run: () => void): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a failure')
}

describe('prepare', function () {
  it('installs a phone’s package and notes it, for that phone’s attach', function () {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-'))
    const ipa = join(dir, 'ios-546.ipa')
    writeFileSync(ipa, 'ipa')
    const ran: string[][] = []
    prepareApp(
      { app: 'teamstation-ios', device: 'phone-1', packagePath: ipa },
      (command, args) => {
        ran.push([command, ...args])
      },
      dir,
      () => false
    )
    expect(ran).deep.equals([
      [
        'xcrun',
        'devicectl',
        'device',
        'install',
        'app',
        '--device',
        'phone-1',
        ipa
      ]
    ])
    expect(
      JSON.parse(readFileSync(join(dir, 'phone-1.json'), 'utf8'))
    ).deep.equals({ app: 'teamstation-ios', packagePath: ipa })
    expect(installedPackage('phone-1', dir)).equals(ipa)
    // Nothing noted, or a package since moved, is no package.
    expect(installedPackage('phone-2', dir)).equals(undefined)
    writeFileSync(
      join(dir, 'phone-3.json'),
      JSON.stringify({ packagePath: join(dir, 'gone.ipa') })
    )
    expect(installedPackage('phone-3', dir)).equals(undefined)
  })

  it('installs a simulator build with simctl, and notes it the same way', function () {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-'))
    const app = join(dir, 'TeamStation Develop.app')
    writeFileSync(app, 'app')
    const ran: string[][] = []
    prepareApp(
      { app: 'teamstation-ios', device: 'sim-1', packagePath: app },
      (command, args) => {
        ran.push([command, ...args])
      },
      dir,
      device => device === 'sim-1'
    )
    expect(ran).deep.equals([['xcrun', 'simctl', 'install', 'sim-1', app]])
    expect(installedPackage('sim-1', dir)).equals(app)
  })

  it('installs an Android package with adb, and blocks on a failed install', function () {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-'))
    const ran: string[][] = []
    prepareApp(
      { app: 'teamstation-android', device: 'pixel', packagePath: 'a.apk' },
      (command, args) => {
        ran.push([command, ...args])
      },
      dir
    )
    expect(ran).deep.equals([['adb', '-s', 'pixel', 'install', '-r', 'a.apk']])
    expect(
      thrown(() => {
        prepareApp(
          { app: 'teamstation-ios', device: 'p', packagePath: 'x.ipa' },
          () => {
            throw new Error('no device')
          },
          dir,
          () => false
        )
      })
    ).instanceOf(BlockedError)
    expect(installedPackage('p', dir)).equals(undefined)
    expect(
      thrown(() => {
        prepareApp({ app: 'teamstation-ios', device: 'p' }, () => {}, dir)
      })
    ).instanceOf(HarnessError)
    expect(
      thrown(() => {
        prepareApp(
          { app: 'teamstation-web', device: 'p', packagePath: 'x' },
          () => {},
          dir
        )
      }).message
    ).includes('Unknown app')
  })

  it('installs through a hub under a lease it ends, and notes the package under the hub id', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-'))
    const apk = join(dir, 'android-600.apk')
    writeFileSync(apk, 'apk')
    const calls: unknown[][] = []
    const hub: MaestroDaemon = {
      attach: async options => {
        calls.push(['attach', options])
        return {
          installApp: async (file: string) => calls.push(['installApp', file]),
          screenshot: async () => new Uint8Array(),
          hierarchy: async () => ({}),
          state: async () => ({}),
          detach: async () => undefined
        }
      },
      shutdown: async () => calls.push(['shutdown'])
    }
    await prepareAppOnHub(
      {
        app: 'teamstation-android',
        device: 'ANDROID-SERIAL@hub',
        packagePath: apk
      },
      hub,
      dir
    )
    expect(calls).deep.equals([
      ['attach', { device: 'ANDROID-SERIAL@hub' }],
      ['installApp', apk],
      ['shutdown']
    ])
    expect(installedPackage('ANDROID-SERIAL@hub', dir)).equals(apk)

    // A failed install blocks, and still ends the lease.
    calls.length = 0
    const failing: MaestroDaemon = {
      ...hub,
      attach: async () => {
        throw new Error('DEVICE_NOT_FOUND')
      }
    }
    let error: unknown
    try {
      await prepareAppOnHub(
        { app: 'teamstation-ios', device: 'x@hub', packagePath: apk },
        failing,
        dir
      )
    } catch (caught) {
      error = caught
    }
    expect(error).instanceOf(BlockedError)
    expect(calls).deep.equals([['shutdown']])
    for (const options of [
      { app: 'teamstation-ios', device: 'x@hub' },
      { app: 'teamstation-web', device: 'x@hub', packagePath: apk }
    ]) {
      let refused: unknown
      try {
        await prepareAppOnHub(options, hub, dir)
      } catch (caught) {
        refused = caught
      }
      expect(refused).instanceOf(HarnessError)
    }
  })

  it('takes a hub device for a real one without asking this machine’s simulators', function () {
    const asked: string[] = []
    const simulator = (device: string): boolean => {
      asked.push(device)
      return device === 'sim-1'
    }
    expect(isHubDevice('PHONE-UDID@hub')).equals(true)
    expect(isHubDevice('PHONE-UDID')).equals(false)
    expect(iosIsPhysical('PHONE-UDID@hub', simulator)).equals(true)
    expect(asked, 'no simctl for a hub device').deep.equals([])
    expect(iosIsPhysical('sim-1', simulator)).equals(false)
    expect(iosIsPhysical('phone-1', simulator)).equals(true)
  })

  it('installs through the hub only a hub’s own device, even with a hub configured', function () {
    const hub = { maestroHub: { address: '192.0.2.1:7433', tokenFile: '/t' } }
    expect(preparesOnHub(hub, 'ANDROID-SERIAL@hub')).equals(true)
    expect(preparesOnHub(hub, 'SIM-UDID')).equals(false)
    expect(preparesOnHub({}, 'ANDROID-SERIAL@hub')).equals(false)
  })
})
