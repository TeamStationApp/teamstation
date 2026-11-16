import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { installedPackage, prepareApp } from './prepare'
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
      dir
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
          dir
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
})
