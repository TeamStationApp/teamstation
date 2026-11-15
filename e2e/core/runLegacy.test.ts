import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { browserKnown, rigSources, stopGroup, testChrome } from './runLegacy'

describe('runLegacy browsers', function () {
  it('fills every variable that names a browser, and nothing else', function () {
    expect(
      browserKnown(
        [
          'TS_CHROME_PATH',
          'F1_BROWSER',
          'LIVE_TEST_BROWSER',
          'TS_PLAYER_BROWSER_COVERAGE',
          'OBSERVABILITY_BROWSER_PROFILE'
        ],
        '/chrome'
      )
    ).deep.equals({
      TS_CHROME_PATH: '/chrome',
      F1_BROWSER: '/chrome',
      LIVE_TEST_BROWSER: '/chrome'
    })
    expect(browserKnown(['TS_CHROME_PATH'], null)).deep.equals({})
  })

  it('picks the newest Chrome for Testing in the cache', function () {
    const root = mkdtempSync(join(tmpdir(), 'test-chrome-'))
    try {
      expect(testChrome(join(root, 'missing'))).equals(undefined)
      expect(testChrome(root)).equals(undefined)
      for (const name of [
        'mac_arm-99.0.1.2',
        'mac_arm-153.0.8010.36',
        'win64-200.0.0.0'
      ]) {
        mkdirSync(join(root, name))
      }
      expect(testChrome(root)).equals(
        join(
          root,
          'mac_arm-153.0.8010.36',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        )
      )
      mkdirSync(join(root, 'linux-160.0.1.1'))
      expect(testChrome(root)).equals(
        join(root, 'linux-160.0.1.1', 'chrome-linux64/chrome')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runLegacy rigs', function () {
  it('reads the rigs a script imports from e2e/rigs, and nothing else', function () {
    const root = mkdtempSync(join(tmpdir(), 'rigs-'))
    try {
      mkdirSync(join(root, 'e2e/rigs'), { recursive: true })
      mkdirSync(join(root, 'src/app'), { recursive: true })
      writeFileSync(join(root, 'e2e/rigs/one.ts'), 'process.env.ONE_BROWSER')
      const script = join(root, 'src/app/a.e2e.ts')
      const source = [
        "import { a } from '../../e2e/rigs/one'",
        "import { b } from '../../e2e/rigs/missing'",
        "import { c } from './elsewhere'"
      ].join('\n')
      expect(rigSources(script, source)).deep.equals([
        'process.env.ONE_BROWSER'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runLegacy stopping', function () {
  it('stops the whole group a script started, and waits for it', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'runLegacyGroup-'))
    const pidFile = join(dir, 'grandchild')
    try {
      // Stands in for npx: it starts the real runner and ignores SIGTERM.
      const parent = spawn(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('child_process')
          const fs = require('fs')
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          process.on('SIGTERM', () => {})
          setInterval(() => {}, 1000)`
        ],
        { detached: true, stdio: 'ignore' }
      )
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const grandchild = Number(readFileSync(pidFile, 'utf8'))
      await stopGroup(parent, 300)
      expect(parent.signalCode).equals('SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(() => process.kill(grandchild, 0)).to.throw()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
