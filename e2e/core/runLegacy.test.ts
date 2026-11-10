import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { browserKnown, testChrome } from './runLegacy'

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
