import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import express from 'express'

import { maestro, type MaestroHandle } from '../../e2e/rigs/refinementsMaestro'
import type { ScoringAction } from '../common/scoring/actions'

/**
 * Where dictated balls and pitches went, on the production field, in Safari
 * on an iOS simulator that is already running. Each scenario plays what the
 * live interpreter said of its sentences (`SCORING_INTERPRETED`, written by
 * `dictatedDistance.integration.ts`) while the simulator screen is recorded;
 * the fixture reports where each ball came down and what was stored, and a
 * frame is pulled from the video as each ball comes down.
 *
 *   SCORING_DEVICE_UDID=… SCORING_ARTIFACT_DIR=… SCORING_INTERPRETED=… \
 *     SCORING_LABEL=after TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/test/dictatedDistance.e2e.ts
 *
 * `SCORING_LABEL=before` records and pulls the same frames without
 * asserting, for the game as it was before.
 */
interface Point {
  x: number
  z: number
}
interface Picture {
  at: number
  end?: number
  kind: string
  durationMs: number
  landsMs: number
  lands?: Point
  landingHeight?: number | null
  carom?: Point
  foul?: Point
}
interface Report {
  name: string
  outs: number
  count: { balls: number; strikes: number }
  stored: {
    coordinates: Point | null
    pitches: Array<{
      call: string
      type: { code: string } | null
      pitchData: { location?: unknown } | null
    }>
  }
  timeline: Picture[]
}
interface Scenario {
  name: string
  said: string
  actions: ScoringAction[]
}
/** Each scenario's sentences, as the integration run heard them. */
const SCENARIOS: Array<{ name: string; frame: string; said: string[] }> = [
  {
    name: 'E1',
    frame: 'e1-bloop',
    said: ['Bloop single to shallow center.']
  },
  {
    name: 'E2',
    frame: 'e2-track',
    said: ['Deep fly to right, caught at the warning track.']
  },
  {
    name: 'E3',
    frame: 'e3-wall',
    said: ['Line drive off the wall in left center, double.']
  },
  {
    name: 'E4',
    frame: 'e4-dribbler',
    said: ['Infield dribbler, the pitcher throws him out.']
  },
  {
    name: 'E5',
    frame: 'e5-foul',
    said: [
      'He fouls it off, just shy of first.',
      'Foul ball deep into the right field seats.'
    ]
  },
  { name: 'E6', frame: '', said: ['Fastball, misses high and inside.'] }
]
const FENCE_UNITS = 118
const feet = (point: Point): number =>
  (Math.hypot(point.x, point.z) * 200) / FENCE_UNITS
const radius = (point: Point): number => Math.hypot(point.x, point.z)

/** What each scenario must show, on the branch. */
function check(name: string, report: Report): void {
  const hits = report.timeline.filter(p => p.kind === 'hit')
  const pitches = report.timeline.filter(p => p.kind === 'pitch')
  const hit = hits.at(-1)
  switch (name) {
    case 'E1':
      assert(report.stored.coordinates != null, 'E1 stored no spot')
      // Two depths said: the deeper, shallow, 110 ft at a 200 ft fence.
      assert(
        Math.abs(feet(report.stored.coordinates) - 110) <= 12,
        `E1 bloop at ${feet(report.stored.coordinates)} ft`
      )
      return
    case 'E2':
      assert(hit?.lands != null, 'E2 drew no hit')
      assert(
        radius(hit.lands) >= 109 && radius(hit.lands) <= FENCE_UNITS,
        `E2 caught at ${radius(hit.lands)}`
      )
      return
    case 'E3':
      assert(hit?.lands != null, 'E3 drew no hit')
      assert(radius(hit.lands) > 116, `E3 met the wall at ${radius(hit.lands)}`)
      assert.equal(hit.landingHeight, 3, 'E3 met the wall in the air')
      assert(hit.carom != null, 'E3 has no carom')
      return
    case 'E4':
      assert(hit?.lands != null, 'E4 drew no hit')
      assert(
        Math.abs(radius(hit.lands) - 24) <= 3 && Math.abs(hit.lands.x) < 2,
        `E4 dribbler at ${JSON.stringify(hit.lands)}`
      )
      return
    case 'E5':
      assert.equal(pitches.length, 2, 'E5 two fouls')
      for (const pitch of pitches) {
        assert(pitch.foul != null, 'E5 foul has no spot')
        assert(pitch.foul.x > 0, 'E5 foul on the right')
        assert(Math.abs(pitch.foul.x) > -pitch.foul.z, 'E5 foul is foul')
      }
      assert(
        radius(pitches[1].foul!) > radius(pitches[0].foul!),
        'E5 the deep foul is deeper'
      )
      assert.deepEqual(report.count, { balls: 0, strikes: 2 }, 'E5 count')
      return
    case 'E6': {
      const pitch = report.stored.pitches.at(-1)
      assert.equal(pitch?.type?.code, 'FA', 'E6 fastball')
      assert.deepEqual(
        pitch?.pitchData?.location,
        { height: 'high', side: 'inside', inZone: false },
        'E6 location'
      )
      assert.deepEqual(report.count, { balls: 1, strikes: 0 }, 'E6 count')
    }
  }
}

async function main(): Promise<void> {
  const device = process.env.SCORING_DEVICE_UDID
  const output = process.env.SCORING_ARTIFACT_DIR
  const interpretedFile = process.env.SCORING_INTERPRETED
  const label = process.env.SCORING_LABEL ?? 'after'
  assert(
    device != null && output != null && interpretedFile != null,
    'Supply SCORING_DEVICE_UDID, SCORING_ARTIFACT_DIR and SCORING_INTERPRETED'
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
  const heard = JSON.parse(await readFile(interpretedFile, 'utf8')) as Array<{
    said: string
    actions: ScoringAction[]
  }>
  const scenarios: Scenario[] = SCENARIOS.map(({ name, said }) => ({
    name,
    said: said.join(' '),
    actions: said.flatMap(sentence => {
      const found = heard.find(entry => entry.said === sentence)
      assert(found != null, `No interpreted actions for "${sentence}"`)
      return found.actions
    })
  }))
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(path.join(tmpdir(), 'dictated-distance-'))
  try {
    await play(directory, device, output, label, scenarios)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Bundles the fixture into `directory`, then plays every scenario. */
async function play(
  directory: string,
  device: string,
  output: string,
  label: string,
  scenarios: Scenario[]
): Promise<void> {
  const { build } = await import('esbuild')
  const { webSettings } = require('../../scripts/web-build-settings.mjs')
  await build({
    ...webSettings,
    entryPoints: ['src/test/dictatedDistance.fixture.tsx'],
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
  app.get('/scenarios', (_req, res) => {
    res.json(scenarios)
  })
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
    daemon = await maestro('scoring-fixes-2')
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
    for (const { name } of scenarios) {
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
    for (const { name } of scenarios) {
      const report = reports.get(name)!
      console.log(
        `${name}: ${JSON.stringify({ stored: report.stored, count: report.count, timeline: report.timeline.map(({ at, end, ...rest }) => rest) })}`
      )
      const frame = SCENARIOS.find(s => s.name === name)!.frame
      // A frame as each ball comes down: the hit, or each of E5's fouls.
      const landings = report.timeline.filter(
        p => p.kind === 'hit' || (p.kind === 'pitch' && name === 'E5')
      )
      for (const [index, landed] of landings.entries()) {
        if (frame === '') break
        const at = landed.at + landed.landsMs
        const file = path.join(
          output,
          `${frame}${index === 0 ? '' : String(index + 1)}-${label}.png`
        )
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
        check(name, report)
        console.log(`  PASS ${name}`)
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`)
        console.log(`  FAIL ${name}: ${(error as Error).message}`)
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'))
    console.log(
      label === 'before'
        ? `Recorded ${scenarios.length} scenarios as they were`
        : `PASS simulator Safari: ${scenarios.length} dictated balls and pitches land where the words put them`
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
          'Dictated distance test cleanup failed'
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
