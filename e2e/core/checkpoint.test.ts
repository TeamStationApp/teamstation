import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import {
  type CheckpointRecord,
  Checkpoints,
  type CheckpointTarget,
  statusFromCheckpoints
} from './checkpoint'
import {
  acceptGolden,
  browserClassOf,
  deviceClassOf,
  goldenKey,
  type GoldenManifest,
  goldenPath,
  readGolden,
  readGoldenManifest,
  requireStore,
  rotateStore,
  storeRefs,
  syncStore,
  writeGoldenManifest
} from './goldens'
import {
  attributeServerErrors,
  checkInvariants,
  consoleErrorsIn,
  failedInvariants,
  findErrorText,
  frameVariance,
  hierarchyIsEmpty,
  type InvariantInputs,
  isBlankFrame,
  parseConsoleLogs,
  type ServerError
} from './invariants'
import { lintFile } from './lint'
import { eventually, readJson } from './readback'
import {
  BlockedError,
  HarnessError,
  type RunResult,
  writeResult
} from './result'
import { seatServerErrors } from './seatLog'
import { compareGolden } from './visual'

const TREE = { children: [{ text: 'Sox' }, { id: 'score-home', text: '3' }] }

/** A PNG with a dark band across a white page, or one solid colour. */
function png(solid = false, width = 40, height = 40): Buffer {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const value = !solid && y === 20 ? 0 : 255
      image.data[at] = value
      image.data[at + 1] = value
      image.data[at + 2] = value
      image.data[at + 3] = 255
    }
  }
  return PNG.sync.write(image)
}

function device(over: Record<string, unknown> = {}): any {
  return {
    hierarchy: async () => TREE,
    screenshot: async () => png(),
    state: async () => ({ foregroundApp: 'app.test' }),
    getConsoleLogs: async () => ({ data: '[]' }),
    assertVisible: async () => ({}),
    assertNotVisible: async () => ({}),
    ...over
  }
}

function inputs(over: Partial<InvariantInputs> = {}): InvariantInputs {
  return {
    surface: 'web-chromium',
    device: device(),
    serverErrors: async () => [],
    alone: true,
    worldIds: [],
    consoleSeen: 0,
    ...over
  }
}

const ERROR_500: ServerError = {
  at: 1,
  method: 'GET',
  path: '/api/v1/games/gam_1',
  status: 500
}

describe('invariants', function () {
  it('passes a healthy screen, and names what a surface cannot check', async function () {
    const web = await checkInvariants(inputs())
    expect(failedInvariants(web.report)).deep.equals([])
    expect(web.report.foreground.verdict).equals('not-available')
    expect(web.report.consoleErrors.verdict).equals('pass')
    const safari = await checkInvariants(inputs({ surface: 'web-safari-ios' }))
    expect(safari.report.consoleErrors.verdict).equals('not-available')
    const app = await checkInvariants(
      inputs({ surface: 'ios-app', appId: 'app.test' })
    )
    expect(app.report.foreground.verdict).equals('pass')
    expect(app.report.consoleErrors.verdict).equals('not-available')
  })

  it('fires on error text', async function () {
    expect(findErrorText({ children: [{ text: 'Sox' }] })).equals(undefined)
    const { report } = await checkInvariants(
      inputs({
        device: device({
          hierarchy: async () => ({
            children: [{ text: 'Something went wrong' }]
          })
        })
      })
    )
    expect(report.errorText).deep.equals({
      verdict: 'fail',
      detail: 'Something went wrong'
    })
  })

  it('fires on an empty hierarchy', async function () {
    expect(hierarchyIsEmpty({ children: [{ children: [] }] })).equals(true)
    expect(hierarchyIsEmpty({ children: [{ id: 'a' }] })).equals(false)
    // A browser lists accessibility nodes, and its page title is not content.
    const page = { role: { value: 'RootWebArea' }, name: { value: 'Title' } }
    expect(hierarchyIsEmpty([page])).equals(true)
    expect(
      hierarchyIsEmpty([page, { ignored: true, name: { value: 'hidden' } }])
    ).equals(true)
    expect(hierarchyIsEmpty([page, { name: { value: 'Sox' } }])).equals(false)
    expect(findErrorText([page, { value: { value: 'Render Error' } }])).equals(
      'Render Error'
    )
    const { report } = await checkInvariants(
      inputs({ device: device({ hierarchy: async () => ({}) }) })
    )
    expect(report.emptyHierarchy.verdict).equals('fail')
  })

  it('passes a normal frame and fails a solid one', async function () {
    const normal = frameVariance(png())
    const solid = frameVariance(png(true))
    expect(isBlankFrame(normal ?? 0)).equals(false)
    expect(isBlankFrame(solid ?? 99)).equals(true)
    expect(frameVariance(Buffer.from('not a png'))).equals(undefined)
    const blank = await checkInvariants(
      inputs({ device: device({ screenshot: async () => png(true) }) })
    )
    expect(blank.report.blankFrame.verdict).equals('fail')
    const jpeg = await checkInvariants(
      inputs({
        device: device({ screenshot: async () => Buffer.from([0xff, 0xd8]) })
      })
    )
    expect(jpeg.report.blankFrame.verdict).equals('not-available')
  })

  it('fires on a console error it has not seen, not on an expected 4xx', async function () {
    expect(
      consoleErrorsIn([
        { level: 'log', message: 'hello' },
        {
          level: 'error',
          message:
            'Failed to load resource: the server responded with a status of 401'
        }
      ])
    ).deep.equals([])
    expect(parseConsoleLogs({ not: 'a list' })).deep.equals([])
    const logs = JSON.stringify([{ level: 'exception', message: 'boom' }])
    const noisy = device({ getConsoleLogs: async () => ({ data: logs }) })
    const first = await checkInvariants(inputs({ device: noisy }))
    expect(first.report.consoleErrors).deep.equals({
      verdict: 'fail',
      detail: 'boom'
    })
    const second = await checkInvariants(
      inputs({ device: noisy, consoleSeen: first.consoleSeen })
    )
    expect(second.report.consoleErrors.verdict).equals('pass')
  })

  it('fires when the app leaves the foreground, and reports a slow device as absent', async function () {
    const native = { surface: 'android-app', appId: 'app.test' } as const
    const left = await checkInvariants(
      inputs({
        ...native,
        device: device({ state: async () => ({ foregroundApp: 'launcher' }) })
      })
    )
    expect(left.report.foreground).deep.equals({
      verdict: 'fail',
      detail: 'launcher is in front'
    })
    const slow = await checkInvariants(
      inputs({ ...native, device: device({ state: async () => ({}) }) })
    )
    expect(slow.report.foreground.verdict).equals('not-available')
  })

  it('fires on an API 5xx, and reports nothing to read from as absent', async function () {
    const failing = await checkInvariants(
      inputs({ serverErrors: async () => [ERROR_500] })
    )
    expect(failing.report.apiErrors.verdict).equals('fail')
    expect(failing.report.apiErrors.detail).includes('500 GET')
    expect(failedInvariants(failing.report)[0]).includes('apiErrors')
    const unseen = await checkInvariants(
      inputs({ serverErrors: async () => undefined })
    )
    expect(unseen.report.apiErrors.verdict).equals('not-available')
  })

  it('sends an unattributed seat 5xx to the report and not the scenario', async function () {
    const split = attributeServerErrors(
      [ERROR_500, { ...ERROR_500, path: '/api/v1/games/gam_mine' }],
      { alone: false, worldIds: ['gam_mine'] }
    )
    expect(split.attributed.map(e => e.path)).deep.equals([
      '/api/v1/games/gam_mine'
    ])
    expect(split.unattributed.map(e => e.path)).deep.equals([
      '/api/v1/games/gam_1'
    ])
    const outcome = await checkInvariants(
      inputs({ alone: false, serverErrors: async () => [ERROR_500] })
    )
    expect(outcome.report.apiErrors.verdict).equals('pass')
    expect(outcome.unattributed).deep.equals([ERROR_500])
  })
})

function clean(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
    env[name] = undefined
  }
  return env
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: clean(),
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** A bare origin named like the real store, with a clone of it. */
function makeStore(name = 'teamstation-e2e-goldens'): {
  store: string
  origin: string
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'goldens-'))
  const origin = join(dir, `${name}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin], {
    env: clean()
  })
  const store = clone(origin, dir, 'store')
  writeFileSync(join(store, 'README.md'), 'Goldens\n')
  mkdirSync(join(store, 'corpus'))
  writeFileSync(join(store, 'corpus', 'clean.png'), png())
  git(store, 'add', '.')
  git(store, 'commit', '-q', '-m', 'Start')
  git(store, 'push', '-q', 'origin', 'master')
  return { store, origin, dir }
}

function clone(origin: string, dir: string, name: string): string {
  const path = join(dir, name)
  execFileSync('git', ['clone', '-q', origin, path], {
    env: clean(),
    stdio: 'ignore'
  })
  git(path, 'config', 'user.name', 'Pat Neshek')
  git(path, 'config', 'user.email', 'pat@example.test')
  return path
}

function makeRun(
  over: Partial<RunResult> = {},
  key = 'a/b/c#d/screen/web-chromium@x'
): string {
  const runDir = mkdtempSync(join(tmpdir(), 'golden-run-'))
  const capturePath = join(runDir, 'captures', 'screen.png')
  mkdirSync(dirname(capturePath), { recursive: true })
  writeFileSync(capturePath, png())
  writeResult(runDir, {
    scenario: 'a/b/c#d',
    surface: 'web-chromium',
    ref: 'abc1234',
    deviceClass: 'x',
    status: 'unbaselined',
    durationMs: 1,
    costUsd: 0,
    degradations: [],
    target: { kind: 'isolated' },
    checkpoints: [
      {
        id: 'screen',
        visual: { key, capturePath, mask: [{ id: 'clock' }] }
      }
    ],
    ...over
  })
  return runDir
}

describe('golden keys', function () {
  it('change with device class and OS major', function () {
    const key = (osVersion: string, screenWidth: number): string =>
      goldenKey(
        's#t',
        'cp',
        'ios-app',
        deviceClassOf({
          platform: 'ios',
          isSimulator: true,
          osVersion,
          screenWidth,
          screenHeight: 800
        })
      )
    expect(key('27.1', 400)).equals('s#t/cp/ios-app@ios-simulator-400x800-27')
    expect(key('27.2', 400)).equals(key('27.1', 400))
    expect(key('28.0', 400)).not.equals(key('27.1', 400))
    expect(key('27.1', 500)).not.equals(key('27.1', 400))
    expect(deviceClassOf({ platform: 'android' })).equals(
      'android-device-0x0-unknown'
    )
    const size = { width: 1440, height: 900 }
    expect(browserClassOf('HeadlessChrome/144.0.1.2', size)).equals(
      'chromium-1440x900-144'
    )
    expect(browserClassOf('odd', size)).equals('chromium-1440x900-unknown')
  })
})

describe('golden store', function () {
  it('writes content-addressed bytes, updates the manifest, and leaves the store clean', function () {
    const { store } = makeStore()
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    const runDir = makeRun()
    const { key, sha256 } = acceptGolden({
      root,
      store,
      runDir,
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    expect(key).equals('a/b/c#d/screen/web-chromium@x')
    expect(existsSync(join(store, goldenPath(sha256)))).equals(true)
    expect(git(store, 'status', '--porcelain')).equals('')
    expect(readGoldenManifest(root).goldens[key]).deep.equals({
      sha256,
      size: png().length,
      masks: [{ id: 'clock' }]
    })
    expect(readGolden(store, sha256)?.equals(png())).equals(true)
    const before = git(store, 'rev-parse', 'HEAD')
    acceptGolden({
      root,
      store,
      runDir,
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    expect(git(store, 'rev-parse', 'HEAD')).equals(before)
  })

  it('refuses a run from another ref, or from a seat without fixture data', function () {
    const { store } = makeStore()
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    expect(() =>
      acceptGolden({
        root,
        store,
        runDir: makeRun(),
        checkpoint: 'screen',
        headRef: 'fffffff'
      })
    ).to.throw('The run is from abc1234')
    expect(() =>
      acceptGolden({
        root,
        store,
        runDir: makeRun({ target: { kind: 'seat', seat: 'develop2' } }),
        checkpoint: 'screen',
        headRef: 'abc1234'
      })
    ).to.throw('fixture data')
    expect(
      acceptGolden({
        root,
        store,
        runDir: makeRun({ target: { kind: 'seat', seat: 'tester' } }),
        checkpoint: 'screen',
        headRef: 'abc1234'
      }).sha256
    ).length(64)
    expect(() =>
      acceptGolden({
        root,
        store,
        runDir: makeRun(),
        checkpoint: 'missing',
        headRef: 'abc1234'
      })
    ).to.throw('no capture')
  })

  it('refuses a capture over 5 MB or one that is gone', function () {
    const { store } = makeStore()
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    const large = makeRun()
    const capture = join(large, 'captures', 'screen.png')
    writeFileSync(capture, Buffer.alloc(5 * 1024 * 1024 + 1))
    expect(() =>
      acceptGolden({
        root,
        store,
        runDir: large,
        checkpoint: 'screen',
        headRef: 'abc1234'
      })
    ).to.throw('over the 5 MB limit')
    const gone = makeRun()
    execFileSync('rm', [join(gone, 'captures', 'screen.png')])
    expect(() =>
      acceptGolden({
        root,
        store,
        runDir: gone,
        checkpoint: 'screen',
        headRef: 'abc1234'
      })
    ).to.throw('The capture is gone')
  })

  it('blocks on a missing store', function () {
    expect(() => requireStore(undefined)).to.throw(BlockedError)
    expect(() => requireStore('/nonexistent')).to.throw(BlockedError)
  })

  it('finds a golden another clone accepted, once synced', function () {
    const { store, origin, dir } = makeStore()
    const other = clone(origin, dir, 'other')
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    const { sha256 } = acceptGolden({
      root,
      store: other,
      runDir: makeRun(),
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    expect(readGolden(store, sha256)).equals(undefined)
    expect(syncStore(store)).deep.equals(['origin/master'])
    expect(readGolden(store, sha256)?.length).equals(png().length)
  })

  it('rotates: keeps what is referenced plus the corpus, and old goldens stay findable', function () {
    const { store, origin, dir } = makeStore()
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    const kept = acceptGolden({
      root,
      store,
      runDir: makeRun(),
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    const retiredRun = makeRun({}, 'a/b/c#d/screen/web-chromium@y')
    writeFileSync(join(retiredRun, 'captures', 'screen.png'), png(true))
    const retired = acceptGolden({
      root,
      store,
      runDir: retiredRun,
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    const keep: GoldenManifest = {
      goldens: { only: readGoldenManifest(root).goldens[kept.key] }
    }
    expect(rotateStore({ store, keep, date: '20261030' })).deep.equals({
      dated: 'master.20261030',
      kept: 1
    })
    expect(git(store, 'rev-list', '--count', 'origin/master')).equals('1')
    expect(existsSync(join(store, goldenPath(kept.sha256)))).equals(true)
    expect(existsSync(join(store, goldenPath(retired.sha256)))).equals(false)
    expect(existsSync(join(store, 'corpus', 'clean.png'))).equals(true)
    expect(existsSync(join(store, 'README.md'))).equals(false)
    expect(storeRefs(store)).deep.equals([
      'origin/master',
      'origin/master.20261030'
    ])
    expect(readGolden(store, retired.sha256)?.length).greaterThan(0)
    const fresh = clone(origin, dir, 'fresh')
    syncStore(fresh)
    expect(readGolden(fresh, retired.sha256)?.length).greaterThan(0)
  })

  it('refuses to rotate any other repository', function () {
    const { store } = makeStore('something-else')
    expect(() =>
      rotateStore({ store, keep: { goldens: {} }, date: '20261030' })
    ).to.throw('not the golden store')
    expect(git(store, 'rev-list', '--count', 'origin/master')).equals('1')
  })

  it('reads an absent manifest as empty, and writes keys in order', function () {
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    expect(readGoldenManifest(root)).deep.equals({ goldens: {} })
    const entry = { sha256: 'a', size: 1, masks: [] }
    writeGoldenManifest(root, { goldens: { z: entry, a: entry } })
    expect(Object.keys(readGoldenManifest(root).goldens)).deep.equals([
      'a',
      'z'
    ])
  })
})

/** Stands in for maestro-d's comparison: records its options and writes the capture. */
function comparer(reply: () => Promise<{ data?: unknown }>): {
  device: any
  calls: Array<Record<string, any>>
} {
  const calls: Array<Record<string, any>> = []
  return {
    calls,
    device: {
      assertScreenshot: async (options: Record<string, any>) => {
        calls.push(options)
        mkdirSync(dirname(options.captureOut), { recursive: true })
        writeFileSync(options.captureOut, png())
        return await reply()
      }
    }
  }
}

function commandFailure(data: unknown): Error {
  return Object.assign(new Error('mismatch'), {
    code: 'COMMAND_FAILED',
    result: { data }
  })
}

describe('visual', function () {
  it('copies the golden into the run directory and passes the options through', async function () {
    const { store } = makeStore()
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    const { key, sha256 } = acceptGolden({
      root,
      store,
      runDir: makeRun(),
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    const runDir = mkdtempSync(join(tmpdir(), 'visual-'))
    const { device: stub, calls } = comparer(async () => ({
      data: { matchPercentage: 100, differingPixels: 0, totalPixels: 1600 }
    }))
    const verdict = await compareGolden({
      device: stub,
      runDir,
      checkpoint: 'screen',
      key,
      golden: { mask: [{ id: 'clock' }] },
      manifest: readGoldenManifest(root),
      store
    })
    expect(verdict.verdict).equals('pass')
    expect(verdict.sha256).equals(sha256)
    expect(verdict.matchPercentage).equals(100)
    expect(calls[0].path).equals(join(runDir, 'goldens', 'screen.png'))
    expect(readFileSync(calls[0].path).equals(png())).equals(true)
    expect(calls[0].requireBaseline).equals(true)
    expect(calls[0].mask).deep.equals([{ id: 'clock' }])
    expect(calls[0].captureOut).equals(join(runDir, 'captures', 'screen.png'))
    expect(calls[0].thresholdPercentage).closeTo(99.9, 0.0001)
    expect(git(store, 'status', '--porcelain')).equals('')
  })

  it('finds a golden on a dated branch', async function () {
    const { store } = makeStore()
    const root = mkdtempSync(join(tmpdir(), 'golden-root-'))
    const { key } = acceptGolden({
      root,
      store,
      runDir: makeRun(),
      checkpoint: 'screen',
      headRef: 'abc1234'
    })
    const manifest = readGoldenManifest(root)
    rotateStore({ store, keep: { goldens: {} }, date: '20261030' })
    const runDir = mkdtempSync(join(tmpdir(), 'visual-'))
    const { device: stub, calls } = comparer(async () => ({}))
    await compareGolden({
      device: stub,
      runDir,
      checkpoint: 'screen',
      key,
      golden: {},
      manifest,
      store
    })
    expect(existsSync(calls[0].path)).equals(true)
  })

  it('reports a missing golden as unbaselined, creates none, and keeps the capture', async function () {
    const runDir = mkdtempSync(join(tmpdir(), 'visual-'))
    const { device: stub, calls } = comparer(async () => {
      throw commandFailure({ code: 'BASELINE_MISSING' })
    })
    const verdict = await compareGolden({
      device: stub,
      runDir,
      checkpoint: 'screen',
      key: 'k',
      golden: {},
      manifest: { goldens: {} },
      store: undefined
    })
    expect(verdict.verdict).equals('unbaselined')
    expect(verdict.detail).equals('no golden for k')
    expect(existsSync(calls[0].path)).equals(false)
    expect(existsSync(verdict.capturePath ?? '')).equals(true)
  })

  it('says so when the manifest names a golden no branch holds', async function () {
    const { store } = makeStore()
    const runDir = mkdtempSync(join(tmpdir(), 'visual-'))
    const { device: stub } = comparer(async () => {
      throw commandFailure({ code: 'BASELINE_MISSING' })
    })
    const verdict = await compareGolden({
      device: stub,
      runDir,
      checkpoint: 'screen',
      key: 'k',
      golden: {},
      manifest: { goldens: { k: { sha256: 'beef', size: 1, masks: [] } } },
      store
    })
    expect(verdict.verdict).equals('unbaselined')
    expect(verdict.detail).includes('in no branch')
  })

  it('fails on a mismatch with its numbers, and a daemon failure is the harness', async function () {
    const runDir = mkdtempSync(join(tmpdir(), 'visual-'))
    const data = {
      matchPercentage: 90,
      differingPixels: 160,
      totalPixels: 1600,
      diffPath: join(runDir, 'diff.png')
    }
    const { device: stub } = comparer(async () => {
      throw commandFailure(data)
    })
    const verdict = await compareGolden({
      device: stub,
      runDir,
      checkpoint: 'screen',
      key: 'k',
      golden: { maxDifferingPercent: 0.1 },
      manifest: { goldens: {} },
      store: undefined
    })
    expect(verdict.verdict).equals('fail')
    expect(verdict.diffPath).equals(data.diffPath)
    expect(verdict.differingPixels).equals(160)
    const down = comparer(async () => {
      throw Object.assign(new Error('gone'), { code: 'DAEMON_UNAVAILABLE' })
    })
    let thrown: unknown
    await compareGolden({
      device: down.device,
      runDir,
      checkpoint: 'screen',
      key: 'k',
      golden: {},
      manifest: { goldens: {} },
      store: undefined
    }).catch((error: unknown) => {
      thrown = error
    })
    expect(thrown).instanceOf(HarnessError)
  })
})

function checkpoints(root: string, runDir: string): Checkpoints {
  return new Checkpoints({
    scenarioId: 'a/b/c#d',
    surface: 'web-chromium',
    runDir,
    root,
    settings: {},
    serverErrors: async () => [],
    alone: true,
    worldIds: () => []
  })
}

function target(over: Record<string, unknown> = {}): CheckpointTarget {
  return {
    device: device(over),
    deviceClass: 'x',
    consoleSeen: 0
  }
}

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('checkpoints', function () {
  const dirs = (): { root: string; runDir: string } => ({
    root: mkdtempSync(join(tmpdir(), 'cp-root-')),
    runDir: mkdtempSync(join(tmpdir(), 'cp-run-'))
  })

  it('runs its layers in order and records each verdict', async function () {
    const { root, runDir } = dirs()
    const seen: Array<[string, unknown]> = []
    const run = checkpoints(root, runDir)
    const stub = comparer(async () => ({ data: { matchPercentage: 100 } }))
    await run.check(
      'screen',
      {
        expect: [
          { id: 'score', text: '3' },
          { text: 'Gone', absent: true }
        ],
        readBack: async () => {
          seen.push(['readBack', true])
        },
        golden: {}
      },
      target({
        assertVisible: async (s: unknown) => {
          seen.push(['visible', s])
        },
        assertNotVisible: async (s: unknown) => {
          seen.push(['absent', s])
        },
        assertScreenshot: stub.device.assertScreenshot
      })
    )
    expect(seen).deep.equals([
      ['visible', { id: 'score', text: '3' }],
      ['absent', { text: 'Gone' }],
      ['readBack', true]
    ])
    const [record] = run.records
    expect(record.expect).equals('pass')
    expect(record.readBack).equals('pass')
    expect(record.basis).equals('MEASURED')
    expect(record.visual?.key).equals('a/b/c#d/screen/web-chromium@x')
    expect(statusFromCheckpoints(run.records).status).equals('passed')
  })

  it('stops at a broken invariant before any later layer', async function () {
    const { root, runDir } = dirs()
    const run = checkpoints(root, runDir)
    const error = await rejection(
      run.check(
        'screen',
        { expect: [{ text: 'Sox' }] },
        target({
          hierarchy: async () => ({ text: 'Render Error' })
        })
      )
    )
    expect(error.message).includes('Checkpoint "screen": errorText')
    expect(run.records[0].expect).equals('not-run')
  })

  it('stops at a wrong value or a lost write', async function () {
    const { root, runDir } = dirs()
    const wrong = checkpoints(root, runDir)
    const missing = await rejection(
      wrong.check(
        'screen',
        { expect: [{ text: 'Sox' }] },
        target({
          assertVisible: async () => {
            throw new Error('not visible')
          }
        })
      )
    )
    expect(missing.message).includes('not visible')
    expect(wrong.records[0].expect).equals('fail')
    const lost = checkpoints(root, runDir)
    const unsaved = await rejection(
      lost.check(
        'screen',
        {
          readBack: async () => {
            throw new Error('not saved')
          }
        },
        target()
      )
    )
    expect(unsaved.message).includes('not saved')
    expect(lost.records[0].readBack).equals('fail')
    expect(lost.records[0].expect).equals('not-run')
  })

  it('records a golden mismatch and goes on, so the run fails with every moved screen', async function () {
    const { root, runDir } = dirs()
    const run = checkpoints(root, runDir)
    const stub = comparer(async () => {
      throw commandFailure({ matchPercentage: 50 })
    })
    const moved = target({ assertScreenshot: stub.device.assertScreenshot })
    await run.check('first', { golden: {} }, moved)
    await run.check('second', { golden: {} }, moved)
    expect(run.records.length).equals(2)
    const status = statusFromCheckpoints(run.records)
    expect(status.status).equals('failed')
    expect(status.reason).includes('first').and.includes('second')
    run.reset()
    expect(run.records).deep.equals([])
  })

  it('reports a passing run as passed', function () {
    const record: CheckpointRecord = {
      id: 'x',
      basis: 'MEASURED',
      expect: 'pass',
      readBack: 'not-run'
    }
    expect(statusFromCheckpoints([record]).status).equals('passed')
  })

  it('keeps an unattributed seat error for the report', async function () {
    const { root, runDir } = dirs()
    const run = new Checkpoints({
      scenarioId: 'a/b/c#d',
      surface: 'web-chromium',
      runDir,
      root,
      settings: {},
      serverErrors: async () => [ERROR_500],
      alone: false,
      worldIds: () => ['gam_mine']
    })
    await run.check('screen', {}, target())
    expect(run.unattributed).deep.equals([ERROR_500])
    run.reset()
    expect(run.unattributed).deep.equals([])
  })
})

describe('a seat log', function () {
  it('reads 5xx from the seat command, and nothing without one', function () {
    expect(seatServerErrors({}, 0)).equals(undefined)
    const script = join(mkdtempSync(join(tmpdir(), 'seat-')), 'seat.sh')
    writeFileSync(
      script,
      `#!/bin/sh
echo "$1 $2 $3" > "$0.args"
echo '{"at":1,"method":"GET","path":"/ok","status":200}'
echo '{"at":2,"method":"GET","path":"/bad","status":503}'
`,
      { mode: 0o755 }
    )
    expect(
      seatServerErrors({ seatCommand: script }, 0)?.map(row => row.path)
    ).deep.equals(['/bad'])
    expect(readFileSync(`${script}.args`, 'utf8').trim()).equals(
      'logs --since 1970-01-01T00:00:00.000Z'
    )
  })
})

describe('read-back', function () {
  it('returns stored state and refuses an error status', async function () {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: URL) =>
      url.pathname === '/ok'
        ? new Response('{"saved":true}')
        : new Response('', { status: 500 })) as typeof fetch
    try {
      expect(await readJson('http://x', '/ok')).deep.equals({ saved: true })
      const error = await rejection(readJson('http://x', '/lost'))
      expect(error.message).includes('answered 500')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('asks until the check holds, then gives up with its error', async function () {
    let calls = 0
    await eventually(
      async () => {
        if (++calls < 2) throw new Error('not yet')
      },
      1000,
      1
    )
    expect(calls).equals(2)
    const error = await rejection(
      eventually(
        async () => {
          throw new Error('never')
        },
        5,
        1
      )
    )
    expect(error.message).equals('never')
  })
})

describe('golden threshold lint', function () {
  it('rejects a checkpoint allowing more than 1%, or above the default with no reason', function () {
    const rules = (text: string): string[] =>
      lintFile('e2e/tests/a/b/c.e2e.ts', `ctx.checkpoint(); ${text}`).map(
        row => row.rule
      )
    const field = 'maxDifferingPercent' + ':'
    expect(rules(`golden: { ${field} 1.5, reason: "x" }`)).includes(
      'golden-threshold'
    )
    expect(rules(`golden: { ${field} 0.5 }`)).includes('golden-threshold')
    expect(
      rules(`golden: { ${field} 0.5, reason: "font hinting" }`)
    ).not.includes('golden-threshold')
  })
})
