import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import express from 'express'

import { maestro, type MaestroHandle } from '../../e2e/rigs/refinementsMaestro'

/**
 * Dictated force plays, the third out and the pitch before a ball in play,
 * in Safari on an iOS simulator that is already running. Each scenario of
 * `dictatedForcePlays.fixture.tsx` is played to completion while the
 * simulator screen is recorded; the fixture reports each picture and how the
 * play ended, and frames are pulled from the video at named moments.
 *
 *   SCORING_DEVICE_UDID=… SCORING_ARTIFACT_DIR=… SCORING_LABEL=after \
 *     TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/test/dictatedForcePlays.e2e.ts
 *
 * `SCORING_LABEL=before` records and extracts the before frames without
 * asserting, for the game as it was before.
 */
const F = { SS: 14, B1: 12, B3: 15 }
/** The runner the F2 sentence leaves on first, forced to second. */
const FIRST = 5

interface Picture {
  type: 'picture'
  at: number
  end?: number
  kind: string
  stage: string
  durationMs: number
  contactMs?: number
  pitched?: boolean
  thrower?: number
  receiver?: number
  runner?: number
  unassisted?: boolean
  safe?: boolean
  wild?: boolean
}
interface Report {
  name: string
  outs: number
  top: boolean
  runs: number
  errors: number
  bases: Record<'first' | 'second' | 'third', number | null>
  note: string | null
  /** What the screen asked, or why it refused, when it did not apply it. */
  unapplied: string | null
  timeline: Picture[]
  /** When the driver had the report: the play's end when it drew nothing. */
  reportedAt: number
}
/** A frame: at a moment of a picture, or after the play; `after` only once fixed. */
interface Frame {
  file: string
  picture?: number
  at: 'mid' | 'pass' | 'done' | number
  afterOnly?: boolean
}
interface Expected {
  pictures: string[]
  check: (report: Report) => void
  frames: Frame[]
}
const carry = (fielder: number): string => `${fielder}>${fielder}:unassisted`
const named = (p: Picture): string =>
  p.kind !== 'throw'
    ? p.kind
    : `${p.thrower}>${p.receiver}${p.unassisted === true ? ':unassisted' : ''}${p.wild === true ? ':wild' : ''}`
const EXPECTED: Record<string, Expected> = {
  F1: {
    pictures: ['hit', carry(F.SS)],
    check: report => {
      assert.equal(report.outs, 2, 'F1 outs')
      assert.notEqual(report.bases.first, null, 'F1 batter on first')
      assert.equal(report.bases.second, null, 'F1 second empty')
    },
    frames: [{ file: 'f1-force-second', picture: 1, at: 'mid' }]
  },
  F2: {
    pictures: ['hit', carry(F.B3)],
    check: report => {
      assert.equal(report.outs, 1, 'F2 outs')
      assert.notEqual(report.bases.first, null, 'F2 batter on first')
      assert.equal(report.bases.second, FIRST, 'F2 runner from first on second')
    },
    frames: [{ file: 'f2-force-third', picture: 1, at: 'mid' }]
  },
  F3: {
    pictures: ['hit', carry(F.SS), `${F.SS}>${F.B1}:wild`],
    check: report => {
      assert.equal(report.outs, 1, 'F3 outs')
      assert.equal(report.errors, 1, 'F3 error')
      assert.notEqual(report.bases.first, null, 'F3 batter on first')
    },
    frames: [{ file: 'f3-overthrow', picture: 2, at: 'pass' }]
  },
  F4: {
    pictures: ['hit', carry(F.SS)],
    check: report => {
      assert.equal(report.top, false, 'F4 half ended')
      assert.equal(report.errors, 0, 'F4 no error')
      assert.match(
        report.note ?? '',
        /^Left out after the third out: the error by /
      )
    },
    frames: [{ file: 'f4-third-out', at: 'done' }]
  },
  F5: {
    pictures: ['hit'],
    check: report => {
      assert.equal(report.top, false, 'F5 half ended')
      assert.equal(report.runs, 0, 'F5 no run')
      assert.match(report.note ?? '', /scoring$/)
    },
    frames: [{ file: 'f5-no-run', at: 'done' }]
  },
  F6: {
    pictures: ['hit'],
    check: report => {
      const hit = report.timeline[0]
      assert.equal(hit.contactMs, 1050, 'F6 contact at the plate')
      assert.equal(hit.pitched, true, 'F6 pitched')
    },
    frames: [
      { file: 'f6-windup', picture: 0, at: 300 },
      { file: 'f6-pitch', picture: 0, at: 850, afterOnly: true },
      { file: 'f6-contact', picture: 0, at: 1050, afterOnly: true }
    ]
  },
  F7: {
    pictures: ['hit'],
    check: report => {
      assert.equal(
        report.timeline[0].contactMs,
        1050,
        'F7 contact at the plate'
      )
    },
    frames: [{ file: 'f7-bunt', picture: 0, at: 'mid' }]
  }
}

/** When a frame is: a picture's middle, the wild ball passing the bag, its contact, or after the play. */
function frameAt(frame: Frame, report: Report): number | undefined {
  const pictures = report.timeline
  const last = pictures.at(-1)
  const done =
    last == null
      ? report.reportedAt + 800
      : (last.end ?? last.at + last.durationMs) + 800
  if (frame.at === 'done') return done
  const picture = pictures[frame.picture ?? 0]
  if (picture == null) return done
  if (frame.file === 'f7-bunt') return picture.at + (picture.contactMs ?? 450)
  if (frame.at === 'mid') return picture.at + picture.durationMs / 2
  if (frame.at === 'pass') return picture.at + picture.durationMs * 0.75
  return picture.at + frame.at
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
  const directory = await mkdtemp(path.join(tmpdir(), 'dictated-force-plays-'))
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
    entryPoints: ['src/test/dictatedForcePlays.fixture.tsx'],
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
    reports.set((req.body as Report).name, {
      ...(req.body as Report),
      reportedAt: Date.now()
    })
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
    daemon = await maestro('dictatedForcePlays')
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await m.openLink({ link: `http://127.0.0.1:${address.port}` })
    await m.assertVisible({ text: '^Play F1$', timeout: 60000 })
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
      // A beat between plays keeps their frames apart, and shows the status.
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    // A recorder that died mid-run has no video worth reading.
    assert(child.exitCode == null, `recordVideo exited ${child.exitCode}`)
    await stopRecording()
    const failures: string[] = []
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const report = reports.get(name)!
      console.log(
        `${name}: ${report.timeline.map(named).join(', ')}; ${report.top ? 'top' : 'bottom'}, outs ${report.outs}, runs ${report.runs}, errors ${report.errors}, bases ${JSON.stringify(report.bases)}, note ${JSON.stringify(report.note)}, unapplied ${JSON.stringify(report.unapplied)}`
      )
      for (const picture of report.timeline)
        console.log(
          `  ${named(picture)} ${Math.round(picture.durationMs)}ms${picture.contactMs == null ? '' : ` contact ${picture.contactMs}ms${picture.pitched === true ? ', pitched' : ''}`}`
        )
      for (const frame of expected.frames) {
        if (frame.afterOnly === true && label === 'before') continue
        const at = frameAt(frame, report)
        if (at == null) continue
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
        assert.deepEqual(
          report.timeline.map(named),
          expected.pictures,
          `${name} pictures`
        )
        assert.equal(report.unapplied, null, `${name} applied`)
        expected.check(report)
        console.log(`  PASS ${name}`)
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`)
        console.log(`  FAIL ${name}: ${(error as Error).message}`)
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'))
    console.log(
      label === 'before'
        ? `Recorded ${Object.keys(EXPECTED).length} scenarios as they were`
        : `PASS simulator Safari: ${Object.keys(EXPECTED).length} force plays, third outs and pitched balls in play drawn and scored as said`
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
          'Dictated force plays test cleanup failed'
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
