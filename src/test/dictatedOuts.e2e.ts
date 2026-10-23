import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import express from 'express'

import { BASES } from '../app/field/fieldModel'
import { maestro, type MaestroHandle } from './refinementsMaestro.e2e'

/**
 * Dictated outs on the production field, in Safari on an iOS simulator that
 * is already running. Each scenario of `dictatedOuts.fixture.tsx` is played
 * to completion while the simulator screen is recorded; the fixture reports
 * every picture and runner motion, and frames from the middle of each named
 * throw are pulled from the video.
 *
 *   SCORING_DEVICE_UDID=… SCORING_ARTIFACT_DIR=… SCORING_LABEL=after \
 *     TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/test/dictatedOuts.e2e.ts
 *
 * `SCORING_LABEL=before` records and extracts the same frames without
 * asserting the pictures, for the game as it was before.
 */
const F = { P: 10, C: 11, B1: 12, B2: 13, SS: 14, B3: 15, LF: 16 }
const RUNNER = 5
/** The leadoff batter of the fixture's game. */
const BATTER = 1

interface Picture {
  type: 'picture'
  at: number
  end?: number
  kind: string
  stage: string
  durationMs: number
  thrower?: number
  receiver?: number
  runner?: number
  to?: { x: number; z: number }
  runnerFrom?: { x: number; z: number }
  unassisted?: boolean
  safe?: boolean
}
interface Motion {
  type: 'motion'
  at: number
  playerId: number
  first: { x: number; z: number }
  last: { x: number; z: number }
}
interface Report {
  name: string
  outs: number
  bases: Record<'first' | 'second' | 'third', number | null>
  timeline: Array<Picture | Motion>
}
interface Expected {
  throws: string[]
  outs: number
  /** Frames to pull: a throw by its index among the throws, and when. */
  frames: Array<{ file: string; throw: number; at: 'mid' | 'walkoff' }>
}
const ground = (point: { x: number; z: number }): { x: number; z: number } => ({
  x: Math.round(point.x * 1000) / 1000,
  z: Math.round(point.z * 1000) / 1000
})
const tag = (from: number, to: number): string => `${from}>${to}:tag`
const EXPECTED: Record<string, Expected> = {
  E1: {
    throws: [tag(F.SS, F.B1)],
    outs: 1,
    frames: [{ file: 'e1-throw-mid', throw: 0, at: 'mid' }]
  },
  E2: {
    throws: [tag(F.SS, F.B2), tag(F.B2, F.B1)],
    outs: 2,
    frames: [
      { file: 'e2-throw1-mid', throw: 0, at: 'mid' },
      { file: 'e2-walkoff', throw: 0, at: 'walkoff' },
      { file: 'e2-throw2-mid', throw: 1, at: 'mid' }
    ]
  },
  E3: {
    throws: [tag(F.LF, F.SS)],
    outs: 2,
    frames: [{ file: 'e3-throw-mid', throw: 0, at: 'mid' }]
  },
  E4: {
    throws: [tag(F.B1, F.P)],
    outs: 1,
    frames: [{ file: 'e4-throw-mid', throw: 0, at: 'mid' }]
  },
  E5: { throws: [tag(F.B3, F.B2)], outs: 1, frames: [] },
  E6: {
    throws: [`${F.B3}>${F.B2}:transfer:safe`, `${F.B2}>${F.B1}:transfer:safe`],
    outs: 0,
    frames: []
  },
  E7: {
    throws: [tag(F.C, F.SS)],
    outs: 1,
    frames: [{ file: 'e7-throw-mid', throw: 0, at: 'mid' }]
  },
  E8: {
    throws: [`${tag(F.B3, F.B3)}:unassisted`],
    outs: 1,
    frames: [{ file: 'e8-walkoff', throw: 0, at: 'walkoff' }]
  }
}
const named = (p: Picture): string =>
  `${p.thrower}>${p.receiver}:${p.stage}${p.unassisted === true ? ':unassisted' : ''}${p.safe === true ? ':safe' : ''}`

/** Every tag's runner walks off from the base he was tagged at. */
function checkWalkOffs(report: Report, throws: Picture[]): void {
  for (const thrown of throws.filter(t => t.stage === 'tag')) {
    const walk = report.timeline.find(
      (entry): entry is Motion =>
        entry.type === 'motion' &&
        entry.playerId === thrown.runner &&
        entry.at >= thrown.at - 50
    )
    assert(walk != null, `${report.name}: no walk off for ${thrown.runner}`)
    assert.deepEqual(walk.first, thrown.to, `${report.name}: walk-off start`)
    assert.deepEqual(
      [Math.abs(walk.last.x), walk.last.z],
      [32, 6],
      `${report.name}: walk-off end`
    )
  }
}

async function main(): Promise<void> {
  const device = process.env.SCORING_DEVICE_UDID
  const output = process.env.SCORING_ARTIFACT_DIR
  const label = process.env.SCORING_LABEL ?? 'after'
  assert(
    device != null && output != null,
    'Supply SCORING_DEVICE_UDID and SCORING_ARTIFACT_DIR'
  )
  assert(label === 'before' || label === 'after', 'SCORING_LABEL')
  const booted = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf8'
    })
  ) as { devices: Record<string, Array<{ udid: string }>> }
  assert(
    Object.values(booted.devices)
      .flat()
      .some(simulator => simulator.udid === device),
    'Use an already-running iOS simulator'
  )
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(path.join(tmpdir(), 'dictated-outs-'))
  try {
    await play(directory, device, output, label)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Bundles the fixture into `directory`, then plays every scenario. */
async function play(
  directory: string,
  device: string,
  output: string,
  label: string
): Promise<void> {
  const { build } = await import('esbuild')
  const { webSettings } = require('../../scripts/web-build-settings.mjs')
  await build({
    ...webSettings,
    entryPoints: ['src/test/dictatedOuts.fixture.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(directory, 'app.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"',
      'process.env.TS_SENTRY_DSN': '""'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  await cp('src/app/assets/fonts', path.join(directory, 'fonts'), {
    recursive: true
  })
  const html = (await readFile('src/app/web/index.html', 'utf8')).replace(
    '</head>',
    '<style>body{overflow:hidden}#root{display:block}</style></head>'
  )
  await writeFile(path.join(directory, 'index.html'), html)
  const reports = new Map<string, Report>()
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.post('/timeline', (req, res) => {
    reports.set((req.body as Report).name, req.body as Report)
    res.sendStatus(204)
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  const video = path.join(output, `${label}-plays.mp4`)
  let recorder:
    | { child: ReturnType<typeof spawn>; exited: Promise<number | null> }
    | undefined
  /** Stops the recording, which writes the video; safe once it has ended. */
  const stopRecording = async (): Promise<void> => {
    const current = recorder
    recorder = undefined
    if (current == null) return
    const { child, exited } = current
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGINT')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
    await exited
    clearTimeout(timeout)
  }
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let m: MaestroHandle | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    assert(address != null && typeof address !== 'string')
    daemon = await maestro('scoring-fixes')
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await m.openLink({ link: `http://127.0.0.1:${address.port}` })
    await m.assertVisible({ text: '^Play E1$', timeout: 60000 })
    // Let the field finish loading before anything is timed against it.
    await new Promise(resolve => setTimeout(resolve, 3000))
    const child = spawn('xcrun', [
      'simctl',
      'io',
      device,
      'recordVideo',
      '--codec=h264',
      '--force',
      video
    ])
    // A recorder that cannot start reports `error`, not `exit`.
    const exited = new Promise<number | null>(resolve => {
      child.once('exit', resolve)
      child.once('error', () => {
        resolve(null)
      })
    })
    recorder = { child, exited }
    const zero = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('recordVideo did not start within 15s'))
      }, 15000)
      const watch = (chunk: Buffer): void => {
        if (!chunk.toString().includes('Recording started')) return
        clearTimeout(timeout)
        resolve(Date.now())
      }
      child.stdout.on('data', watch)
      child.stderr.on('data', watch)
      exited
        .then(code => {
          clearTimeout(timeout)
          reject(new Error(`recordVideo exited ${code}`))
        })
        .catch(reject)
    })
    for (const name of Object.keys(EXPECTED)) {
      await m.tapOn({ text: `^Play ${name}$` })
      await m.assertVisible({ text: `^${name} — Complete$`, timeout: 60000 })
      const deadline = Date.now() + 10000
      while (!reports.has(name)) {
        assert(Date.now() < deadline, `${name} did not report its timeline`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      // A beat between plays keeps their frames apart in the video.
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    // A recorder that died mid-run has no video worth reading.
    assert(child.exitCode == null, `recordVideo exited ${child.exitCode}`)
    await stopRecording()
    const failures: string[] = []
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const report = reports.get(name)!
      const pictures = report.timeline.filter(
        (entry): entry is Picture => entry.type === 'picture'
      )
      const throws = pictures.filter(p => p.kind === 'throw')
      console.log(
        `${name}: ${pictures.map(p => (p.kind === 'throw' ? named(p) : p.kind)).join(', ')}; outs ${report.outs}`
      )
      for (const entry of report.timeline)
        if (entry.type === 'picture' && entry.kind === 'throw')
          console.log(
            `  throw ${named(entry)} runner ${entry.runner} from ${JSON.stringify(entry.runnerFrom)} to ${JSON.stringify(entry.to)} ${Math.round(entry.durationMs)}ms`
          )
        else if (entry.type === 'motion')
          console.log(
            `  motion ${entry.playerId} ${JSON.stringify(entry.first)} -> ${JSON.stringify(entry.last)}`
          )
      for (const frame of expected.frames) {
        const thrown = throws[frame.throw]
        if (thrown == null) continue
        const at =
          frame.at === 'mid'
            ? thrown.at + thrown.durationMs / 2
            : (thrown.end ?? thrown.at + thrown.durationMs) + 300
        const file = path.join(output, `${frame.file}-${label}.png`)
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-ss',
          String(Math.max(0, (at - zero) / 1000)),
          '-i',
          video,
          '-frames:v',
          '1',
          file
        ])
        console.log(
          `  frame ${path.basename(file)} at ${Math.round(at - zero)}ms`
        )
      }
      if (label === 'before') continue
      try {
        assert.deepEqual(throws.map(named), expected.throws, `${name} throws`)
        assert.equal(report.outs, expected.outs, `${name} outs`)
        // He runs inside the picture: it starts him short of the base. A
        // fielder's choice runs him there with the hit, before its throw.
        if (name !== 'E5')
          for (const thrown of throws.filter(t => t.stage === 'tag'))
            assert.notDeepEqual(thrown.runnerFrom, thrown.to, `${name} run`)
        checkWalkOffs(report, throws)
        // The hit runs an out batter toward first: the tag, or his trot after
        // a catch, takes him on from there, never from the plate again.
        const offPlate = (point?: { z: number }): boolean =>
          point != null && point.z < -1
        // Nor does it run him to the bag ahead of the ball: the tag still
        // has ground for him to cover.
        for (const thrown of throws.filter(
          t => t.runner === BATTER && t.stage === 'tag'
        )) {
          assert(offPlate(thrown.runnerFrom), `${name} batter restarts`)
          const left = Math.hypot(
            thrown.to!.x - thrown.runnerFrom!.x,
            thrown.to!.z - thrown.runnerFrom!.z
          )
          assert(left > 5, `${name} batter beats the ball`)
        }
        if (name === 'E3') {
          const trot = report.timeline.find(
            (entry): entry is Motion =>
              entry.type === 'motion' && entry.playerId === BATTER
          )
          assert(offPlate(trot?.first), 'E3 batter trot restarts')
        }
        if (name === 'E2' || name === 'E5' || name === 'E7')
          assert.deepEqual(throws[0].to, ground(BASES[2]), `${name} tag base`)
        if (name === 'E6')
          assert.deepEqual(
            [report.bases.first != null, report.bases.second],
            [true, RUNNER],
            'E6 runners'
          )
        console.log(`  PASS ${name}`)
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`)
        console.log(`  FAIL ${name}: ${(error as Error).message}`)
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'))
    console.log(
      label === 'before'
        ? `Recorded ${Object.keys(EXPECTED).length} plays as they were`
        : `PASS simulator Safari: ${Object.keys(EXPECTED).length} dictated plays draw each out as runner and ball arriving together, then walk off from the tag base`
    )
  } finally {
    await stopRecording()
    server.closeAllConnections()
    const cleanup = await Promise.allSettled([
      (async () => {
        try {
          await m?.detach()
        } finally {
          await daemon?.shutdown()
        }
      })(),
      new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    ])
    const failures = cleanup.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      console.error(
        new AggregateError(
          failures.map(result => result.reason),
          'Dictated outs test cleanup failed'
        )
      )
      process.exitCode = 1
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
