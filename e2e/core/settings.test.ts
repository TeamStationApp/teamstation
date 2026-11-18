import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { expandHome, loadSettings } from './settings'

describe('local settings', function () {
  it('reads ~/ as the home directory, and leaves every other value', function () {
    expect(expandHome('~/a/b', '/home/x')).equals('/home/x/a/b')
    expect(expandHome('/abs/a', '/home/x')).equals('/abs/a')
    expect(expandHome('~other', '/home/x')).equals('~other')
    expect(expandHome(3, '/home/x')).equals(3)
  })

  it('expands ~/ one level into an object, so a hub token file and the webcam block are absolute', function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-settings-'))
    try {
      const file = join(dir, 'local.json')
      writeFileSync(
        file,
        JSON.stringify({
          maestroHub: {
            address: '192.0.2.1:7433',
            tokenFile: '~/.config/teamstation-e2e/maestro-hub-token'
          },
          webcam: {
            url: 'rtsps://camera/x',
            crops: { 'p@hub': '1:2:3:4:1:ccw' }
          },
          stackProvider: { command: ['npm', '~/kept'] },
          seatCommand: '~/seat'
        })
      )
      expect(loadSettings(file)).deep.equals({
        maestroHub: {
          address: '192.0.2.1:7433',
          tokenFile: join(
            homedir(),
            '.config/teamstation-e2e/maestro-hub-token'
          )
        },
        webcam: {
          url: 'rtsps://camera/x',
          crops: { 'p@hub': '1:2:3:4:1:ccw' }
        },
        // Deeper than one level, values pass through as they are.
        stackProvider: { command: ['npm', '~/kept'] },
        seatCommand: join(homedir(), 'seat')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('expands the paths of a settings file, and answers nothing without one', function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-settings-'))
    try {
      expect(loadSettings(join(dir, 'missing.json'))).deep.equals({})
      const file = join(dir, 'local.json')
      writeFileSync(
        file,
        JSON.stringify({ maestroBin: '~/bin/maestro-d', judgeBudgetUsd: 1 })
      )
      expect(loadSettings(file)).deep.equals({
        maestroBin: join(homedir(), 'bin/maestro-d'),
        judgeBudgetUsd: 1
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
