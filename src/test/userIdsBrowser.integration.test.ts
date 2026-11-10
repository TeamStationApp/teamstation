import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { browserLock, cleanupBrowser, userIdsOrigin } from './userIdsBrowser'

const fails = async (
  operation: Promise<unknown>,
  message: string
): Promise<void> => {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(String(failure)).includes(message)
}

describe('user ID browser isolation', () => {
  it('defaults to local-only and accepts only the explicitly assigned HTTPS seat', () => {
    expect(userIdsOrigin({})).equals('http://127.0.0.1:8180')
    expect(
      userIdsOrigin({
        TS_USER_IDS_SEAT_ORIGIN: 'https://develop7.teamstation.app'
      })
    ).equals('https://develop7.teamstation.app')
    for (const seat of [
      'https://app.teamstation.app',
      'https://develop6.teamstation.app',
      'http://develop7.teamstation.app',
      'https://develop7.teamstation.app/'
    ])
      expect(() => userIdsOrigin({ TS_USER_IDS_SEAT_ORIGIN: seat })).throws(
        'assigned development seat'
      )
    for (const local of [
      'https://app.teamstation.app',
      'http://example.test',
      'http://user:password@localhost',
      'http://localhost/path',
      'http://localhost?x=1',
      'http://localhost#x'
    ])
      expect(() => userIdsOrigin({ TS_SCORING_TEST_URL: local })).throws()
  })
  it('serializes owners and retains the lock while any owned browser remains alive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'user-id-browser-test-'))
    const path = join(directory, 'lock')
    let pids: number[] = []
    try {
      const release = await browserLock(
        'profile',
        path,
        () => true,
        () => pids
      )
      await fails(
        browserLock(
          'other',
          path,
          () => true,
          () => []
        ),
        'still owns'
      )
      pids = [123]
      await fails(release(), 'retaining lock')
      expect(JSON.parse(await readFile(path, 'utf8')).profile).equals('profile')
      pids = []
      await release()
      const again = await browserLock(
        'other',
        path,
        () => true,
        () => []
      )
      await again()
      await writeFile(path, JSON.stringify({ pid: 42, profile: 'stale' }))
      await fails(
        browserLock(
          'new',
          path,
          () => false,
          () => [123]
        ),
        'still owns'
      )
      await fails(
        browserLock(
          'new',
          path,
          () => false,
          () => []
        ),
        'Stale browser lock'
      )
      expect(JSON.parse(await readFile(path, 'utf8')).profile).equals('stale')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('closes and shuts down even when export, browser closure and detach all fail', async () => {
    const called: string[] = []
    const step =
      (name: string, fail = false) =>
      async (): Promise<void> => {
        called.push(name)
        if (fail) throw new Error(name)
      }
    await fails(
      cleanupBrowser({
        exportCoverage: step('export', true),
        closeBrowser: step('close', true),
        detach: step('detach', true),
        shutdown: step('shutdown'),
        confirmExit: step('exit'),
        release: step('release')
      }),
      'cleanup reported failures'
    )
    expect(called).deep.equals([
      'export',
      'close',
      'detach',
      'shutdown',
      'exit',
      'release'
    ])
    called.length = 0
    await fails(
      cleanupBrowser({
        shutdown: step('shutdown'),
        confirmExit: step('exit', true),
        release: step('release')
      }),
      'exit'
    )
    expect(called).deep.equals(['shutdown', 'exit'])
    called.length = 0
    await cleanupBrowser({
      shutdown: step('shutdown'),
      confirmExit: step('exit'),
      release: step('release')
    })
    expect(called).deep.equals(['shutdown', 'exit', 'release'])
  })
})
