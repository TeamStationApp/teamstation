import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { goldenPinPath, readGoldenSuite } from './goldens'
import { ROOT } from './manifest'
import { compareGoldenInDir, goldensOf, goldensOutPath } from './visual'

const KEY =
  'app-shell/lists/list-screens#row/videos-list/web-chromium@chromium-1440x900-128'

/** A device whose screenshot compare answers `reply`, writing its capture as maestro-d does. */
function device(
  reply: 'match' | 'mismatch' | 'missing' | 'broken',
  seen: Array<Record<string, any>>
): any {
  return {
    assertScreenshot: async (options: Record<string, any>) => {
      seen.push(options)
      writeFileSync(options.captureOut, `capture of ${reply}`)
      if (reply === 'match') return { data: { matchPercentage: 100 } }
      const error: any = new Error(
        reply === 'broken' ? 'the daemon went away' : 'screens differ'
      )
      error.code = reply === 'broken' ? 'DAEMON_GONE' : 'COMMAND_FAILED'
      error.result = {
        data:
          reply === 'missing'
            ? { code: 'BASELINE_MISSING' }
            : { matchPercentage: 97, differingPixels: 30, totalPixels: 1000 }
      }
      throw error
    }
  }
}

describe('goldens from a folder', function () {
  let scratch: string
  let goldensDir: string
  let n = 0
  before(function () {
    scratch = mkdtempSync(join(tmpdir(), 'goldens-dir-test-'))
    goldensDir = join(scratch, 'goldens')
    mkdirSync(dirname(join(goldensDir, `${KEY}.png`)), { recursive: true })
    writeFileSync(join(goldensDir, `${KEY}.png`), 'golden bytes')
  })
  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })
  const compare = async (
    reply: 'match' | 'mismatch' | 'missing' | 'broken',
    key = KEY
  ): Promise<{ verdict: any; runDir: string; seen: any[] }> => {
    const runDir = join(scratch, `run-${n++}`)
    const seen: any[] = []
    const verdict = await compareGoldenInDir({
      device: device(reply, seen),
      runDir,
      key,
      golden: { mask: [{ id: 'clock' }] },
      goldensDir
    })
    return { verdict, runDir, seen }
  }

  it('passes a match against <goldensDir>/<goldenKey>.png and writes nothing out', async function () {
    const { verdict, runDir, seen } = await compare('match')
    expect(verdict.verdict).equals('pass')
    expect(verdict.goldenPath).equals(join(goldensDir, `${KEY}.png`))
    expect(seen[0].path).equals(join(goldensDir, `${KEY}.png`))
    expect(seen[0].mask).deep.equals([{ id: 'clock' }])
    expect(seen[0].thresholdPercentage).equals(99.9)
    expect(existsSync(goldensOutPath(runDir, KEY))).equals(false)
  })

  it('writes a mismatch out to goldens-out and fails it', async function () {
    const { verdict, runDir } = await compare('mismatch')
    expect(verdict.verdict).equals('fail')
    expect(verdict.differingPixels).equals(30)
    expect(readFileSync(goldensOutPath(runDir, KEY), 'utf8')).equals(
      'capture of mismatch'
    )
    expect(goldensOf([{ visual: verdict }])).deep.equals({
      differs: [KEY],
      missing: []
    })
  })

  it('reports a key with no golden unbaselined, with its screen written out', async function () {
    const key = 'a/b/c#d/e/ios-app@ios-device-1x1-1'
    const { verdict, runDir, seen } = await compare('missing', key)
    expect(verdict.verdict).equals('unbaselined')
    expect(verdict.detail).equals(`no golden for ${key}`)
    expect(seen[0].requireBaseline).equals(true)
    expect(existsSync(goldensOutPath(runDir, key))).equals(true)
    expect(goldensOf([{ visual: verdict }, {}])).deep.equals({
      differs: [],
      missing: [key]
    })
  })

  it('is a harness error when the compare itself breaks', async function () {
    let message = ''
    try {
      await compare('broken')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).equals('assertScreenshot: the daemon went away')
  })
})

describe('e2e/goldens.json', function () {
  let scratch: string
  before(function () {
    scratch = mkdtempSync(join(tmpdir(), 'goldens-suite-test-'))
    mkdirSync(join(scratch, 'e2e'))
  })
  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })
  const suite = (text: string): string => {
    writeFileSync(join(scratch, 'e2e', 'goldens.json'), text)
    try {
      readGoldenSuite(scratch)
      return 'read'
    } catch (error) {
      return (error as Error).message
    }
  }

  it('is committed with the suite folder and each stage parents', function () {
    expect(readGoldenSuite(ROOT)).deep.equals({
      directory: 'teamstation',
      parents: { develop: ['master'], '*': ['develop', 'master'] }
    })
    expect(goldenPinPath('teamstation', KEY)).equals(
      `e2e/goldens/teamstation/${KEY}.sha256`
    )
  })

  it('names what is wrong with a malformed one', function () {
    expect(suite('{')).contains('is not JSON')
    expect(suite('{"directory":"../up","parents":{}}')).contains(
      'directory is a plain folder name'
    )
    expect(
      suite('{"directory":"teamstation","parents":{"develop":"master"}}')
    ).contains('parents maps each stage')
    expect(suite('{"directory":"teamstation","parents":[]}')).contains(
      'parents maps each stage'
    )
    expect(suite('{"directory":"teamstation","parents":{}}')).equals('read')
  })
})
