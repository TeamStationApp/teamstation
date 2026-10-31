import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import path from 'node:path'

import { attach } from '../../../test/maestroD'

/**
 * A cut on TS Director's programme, frame by frame: the outgoing camera keeps
 * moving up to the new camera's first picture, in the recorded master and in
 * the stream a viewer gets.
 *
 * Two marked fake cameras (scripts/markedRtspCameras.js) on this Mac, both
 * enabled on the iPad, with a local RTMP sink for the stream. Three takes, each
 * its own recording and rule: `cuts`, slow then fast; `replays`, in and out;
 * and `rapid`, cuts faster than the live delay. Every picture of each master
 * and saved stream is read (scripts/programmeCutFrames.js).
 *
 * Install a build first (`LAUNCH=0 bash scripts/build-device.sh`), then:
 *
 *   MAESTRO_D=programme-cut DIRECTOR_DEVICE_UDID=<udid> MAESTRO_D_TEAM_ID=<team> \
 *     node -r sucrase/register mobile/apps/tsDirector/e2e/programmeCut.e2e.ts
 *
 * CUT_MAX_HELD_MS is the longest the outgoing picture may stay on at a cut
 * (default 50), and CUT_MAX_RAPID_HOLD_MS the longest any picture may stay on
 * in `rapid` (default 100, what a healthy camera's own delivery can repeat).
 * E2E_ARTIFACT_DIR keeps the run's files. CUT_SCENARIO=slow runs only the slow
 * cuts, for a quick regular check. CUT_REPORTED_AGE=0,300 has the second camera
 * report its pictures 300 ms older than they are, as a phone's clock can, so
 * the two cameras' pictures reach the programme at different ages. CUT_DELAY_MS
 * runs at another live delay, restored to 1 s after, and only reports what it
 * finds: above about 1.2 s a cut can hold, because the compositor's pool runs dry.
 */

const require_ = createRequire(__filename)
const ROOT = path.resolve(__dirname, '..')
const APP_ID = 'app.teamstation.director'
const { get, resolveHost } = require_(path.join(ROOT, 'scripts/deviceTarget.js'))
const { analyse, readPictures } = require_(path.join(ROOT, 'scripts/programmeCutFrames.js'))

const device = process.env.DIRECTOR_DEVICE_UDID
const daemon = process.env.MAESTRO_D ?? 'programme-cut'
const maxHeldMs = Number(process.env.CUT_MAX_HELD_MS ?? 50)
const scenario = process.env.CUT_SCENARIO ?? 'full'
const artifactDir =
  process.env.E2E_ARTIFACT_DIR ?? path.join(ROOT, 'artifacts', 'programme-cut')
const maxRapidHoldMs = Number(process.env.CUT_MAX_RAPID_HOLD_MS ?? 100)
const takes: Take[] = scenario === 'slow' ? ['cuts'] : ['cuts', 'replays', 'rapid']
const SINK_PORT = 19351
const SETTLE_SECONDS = 12
/// Pictures with no camera's strip a take may open on: a second of whatever was on air before.
const MAX_UNREAD = 60
/// The hard cap stressFourHour.js holds the app to.
const MEMORY_CAP_MB = 1200

const wait = async (seconds: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, seconds * 1000))

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && address.address.startsWith('10.')) {
        return address.address
      }
    }
  }
  throw new Error('no LAN IPv4 address')
}

async function untilLine(child: ChildProcess, line: string, seconds: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no "${line}" within ${seconds} s`))
    }, seconds * 1000)
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      if (chunk.toString().includes(line)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`exited ${code ?? 'on a signal'} before "${line}"`))
    })
  })
}

interface Step {
  path: string
  seconds: number
}

/** The takes of a run: each its own recording, judged by its own rule. */
type Take = 'cuts' | 'replays' | 'rapid'

function cut(source: number, seconds: number): Step {
  return { path: `/program?source=${source}`, seconds }
}

function steps(take: Take, first: number, second: number): Step[] {
  if (take === 'rapid') {
    // Faster than the live delay: each camera goes off air before its first picture is due. Each
    // control call takes about a quarter of a second, so no wait goes between them.
    return [
      cut(second, 0), cut(first, 0), cut(second, 0),
      cut(first, 0), cut(second, 0), cut(first, 0), cut(second, 3)
    ]
  }
  if (take === 'replays') {
    return [
      { path: `/replay?source=${second}&seconds=5&speed=full`, seconds: 8 },
      cut(second, 4),
      cut(first, 4),
      { path: `/replay?source=${first}&seconds=5&speed=full`, seconds: 8 },
      { path: '/set-slowmo?percent=50', seconds: 0 },
      { path: `/replay?source=${first}&seconds=4&speed=slow`, seconds: 3 },
      // A cut away in the middle of a replay, and back.
      cut(second, 3),
      cut(first, 4)
    ]
  }
  const slow = [
    cut(second, 4), cut(first, 4), cut(second, 4), cut(first, 4), cut(second, 4), cut(first, 4)
  ]
  if (scenario === 'slow') return slow
  return [...slow, cut(second, 1), cut(first, 1), cut(second, 1), cut(first, 1), cut(second, 3)]
}

function newestMaster(): string {
  const listing = execFileSync(
    'xcrun',
    [
      'devicectl', 'device', 'info', 'files',
      '--device', device as string,
      '--domain-type', 'appDataContainer',
      '--domain-identifier', APP_ID,
      '--username', 'mobile',
      '--subdirectory', 'Documents/Program'
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const names = listing.match(/program-\d{8}-\d{6}(-\d+)?\.mp4/g) ?? []
  const newest = names.sort().at(-1)
  assert.ok(newest != null, 'no programme master on the iPad')
  return newest
}

function pullMaster(name: string, destination: string): void {
  execFileSync('xcrun', [
    'devicectl', 'device', 'copy', 'from',
    '--device', device as string,
    '--domain-type', 'appDataContainer',
    '--domain-identifier', APP_ID,
    '--source', `Documents/Program/${name}`,
    '--destination', destination
  ], { stdio: 'ignore' })
}

interface Seam {
  kind: string
  from: number
  to: number
  at: number
  heldMs: number
}

interface Report {
  pictures: number
  unread: number
  seams: Seam[]
  flashes: unknown[]
  worstHeldMs: number
  longestHoldElsewhereTicks: number
  longestHoldMs: number
}

/** Changes of camera the steps make, from `first` on air. */
function commandedCuts(run: Step[], first: number): number {
  let onAir = `/program?source=${first}`
  let count = 0
  for (const step of run) {
    if (!step.path.startsWith('/program') || step.path === onAir) continue
    onAir = step.path
    count += 1
  }
  return count
}

async function read(file: string): Promise<Report> {
  const report: Report = analyse(await readPictures(file))
  writeFileSync(`${file}.cuts.json`, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

/** What is wrong with one file of one take. */
function judge(name: string, take: Take, report: Report, commanded: number): string[] {
  // A take opens on the picture that was on air before it, for its first moments.
  const cuts = report.seams.filter(seam => seam.kind === 'cut' && seam.at >= SETTLE_SECONDS)
  const jumps = report.seams.filter(seam => seam.kind === 'jump')
  const held = cuts.map(seam => Math.round(seam.heldMs))
  console.log(`${name}: ${report.pictures} pictures, ${report.unread} unread, ${cuts.length} cuts held ${held.join(' ')} ms; jumps held ${jumps.map(seam => Math.round(seam.heldMs)).join(' ')} ms; ${report.flashes.length} flashes; longest hold ${Math.round(report.longestHoldMs)} ms`)
  const problems: string[] = []
  if (report.flashes.length > 0) problems.push(`${name}: ${report.flashes.length} flashes of a camera`)
  if (take === 'rapid') {
    // One camera plays on through the chain and hands over to the last, and a camera whose pictures
    // come due early may go on air on the way: judged on the whole take, not on how many cuts it saw.
    if (report.longestHoldMs > maxRapidHoldMs) problems.push(`${name}: a picture held ${report.longestHoldMs} ms, over ${maxRapidHoldMs}`)
    if (jumps.length > 0) problems.push(`${name}: ${jumps.length} jumps within a camera`)
    if (cuts.length === 0) problems.push(`${name}: the chain never handed over to the last camera`)
    if (cuts.length > 0 && cuts[cuts.length - 1].to === cuts[0].from) problems.push(`${name}: ended on the camera it started on`)
    if (report.unread > MAX_UNREAD) problems.push(`${name}: ${report.unread} pictures read no camera`)
    return problems
  }
  if (cuts.length !== commanded) problems.push(`${name}: ${cuts.length} cuts, ${commanded} commanded`)
  if (report.unread > MAX_UNREAD) problems.push(`${name}: ${report.unread} pictures read no camera`)
  // The replays take has one cut away from a replay, which holds by design and is reported above.
  const allowed = take === 'replays' ? 1 : 0
  const over = held.filter(ms => ms > maxHeldMs)
  if (over.length > allowed) problems.push(`${name}: cuts held the outgoing picture ${over.join(' ')} ms, over ${maxHeldMs}`)
  return problems
}

async function main(): Promise<void> {
  assert.ok(device != null && device !== '', 'set DIRECTOR_DEVICE_UDID')
  mkdirSync(artifactDir, { recursive: true })
  const lan = lanAddress()
  const sinkDirectory = path.join(artifactDir, 'stream')
  mkdirSync(sinkDirectory, { recursive: true })

  const cameras = spawn(process.execPath, [
    path.join(ROOT, 'scripts/markedRtspCameras.js'),
    '--host', lan,
    '--reported-age', process.env.CUT_REPORTED_AGE ?? '0,0'
  ], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const sink = spawn(process.execPath, [
    path.join(ROOT, 'scripts/rtmpSink.js'),
    '--port', String(SINK_PORT),
    '--dir', sinkDirectory
  ], { stdio: 'ignore' })
  const stop = (): void => {
    cameras.kill('SIGTERM')
    sink.kill('SIGTERM')
  }
  process.on('exit', stop)

  await untilLine(cameras, 'ready', 300)
  const m = await attach({ daemon, device, appId: APP_ID, artifactDir })
  try {
    await m.launchApp({
      appId: APP_ID,
      stopApp: true,
      arguments: {
        uiTest: true,
        sourceProfile: 'rtsp',
        rtspScan: false,
        rtspHosts: `${lan}:18554;${lan}:18555`,
        streamURL: `rtmp://${lan}:${SINK_PORT}/live/cut`
      }
    })
    await wait(8)

    process.env.DIRECTOR_DEVICE_UDID = device
    // By its LAN address: resolving the device's name costs seconds, and a cut's timing is the point.
    const name: string = await resolveHost(true)
    const addresses: string[] = JSON.parse(await get(name, '/dump-state')).localAddresses
    const host = addresses.find(address => /^(10|192\.168)\./.test(address)) ?? name
    const send = async (target: string): Promise<void> => {
      console.log(`$ curl -s 'http://<ipad>:8765${target}'   # ${new Date().toISOString()}`)
      console.log(await get(host, target))
    }

    // A take left open by an earlier session resumes at launch, ahead of any camera.
    await send('/record?on=false')
    await wait(3)
    await send('/enable-source?index=1&on=true')
    await send('/enable-source?index=2&on=true')
    await send('/start')
    await wait(6)
    const started = JSON.parse(await get(host, '/dump-state'))
    const slots: number[] = started.tiles
      .filter((tile: { state: string }) => tile.state === 'live')
      .map((tile: { index: number }) => tile.index + 1)
    assert.equal(slots.length, 2, `two cameras live, got tiles ${slots.join(', ')}`)
    const [first, second] = slots
    await send(`/program?source=${first}`)
    // Saved by the app, so a run never inherits another's.
    await send(`/display-latency-cap?ms=${process.env.CUT_DELAY_MS ?? 1000}`)

    const peak = { mb: 0 }
    const sample = (): void => {
      get(host, '/dump-state').then((text: string) => {
        peak.mb = Math.max(peak.mb, JSON.parse(text).physFootprintMB ?? 0)
      }, () => undefined)
    }
    const sampling = setInterval(sample, 1000)

    const problems: string[] = []
    for (const take of takes) {
      await send(`/program?source=${first}`)
      await wait(2)
      await send('/record?on=true')
      await send('/stream?on=true')
      // Long enough for each camera's delay line to settle before the first cut.
      await wait(15)
      const before = JSON.parse(await get(host, '/dump-state'))
      console.log(`take ${take}: tiles`, JSON.stringify(before.tiles.filter((tile: { state: string }) => tile.state === 'live').map((tile: { index: number, framesPerSecond: number, playoutMilliseconds: number, frameAgeMilliseconds: number }) => ({
        tile: tile.index + 1,
        fps: tile.framesPerSecond,
        playoutMs: tile.playoutMilliseconds,
        ageMs: Math.round(tile.frameAgeMilliseconds)
      }))))

      const run = steps(take, first, second)
      for (const step of run) {
        await send(step.path)
        // A cut holds the most pictures just before the new camera's first comes due.
        if (step.path.startsWith('/program')) setTimeout(sample, 500)
        await wait(step.seconds)
      }
      await wait(3)
      const after = JSON.parse(await get(host, '/dump-state'))
      console.log('counters', JSON.stringify({
        late: after.programmeLatePictures - before.programmeLatePictures,
        skipped: after.programmeSkippedPictures - before.programmeSkippedPictures,
        composerDropped: after.programmeComposeDropped - before.programmeComposeDropped,
        composeMisses: after.programmeComposeMisses - before.programmeComposeMisses,
        missedTicks: after.programmeMissedTicks - before.programmeMissedTicks
      }))
      await send('/stream?on=false')
      await send('/record?on=false')
      await wait(8)

      const master = path.join(artifactDir, `${take}-master.mp4`)
      pullMaster(newestMaster(), master)
      const newest = readdirSync(sinkDirectory).filter(name => name.endsWith('.flv')).sort().at(-1)
      assert.ok(newest != null, 'the sink saved no stream')
      const stream = path.join(artifactDir, `${take}-stream.flv`)
      copyFileSync(path.join(sinkDirectory, newest), stream)

      const commanded = take === 'rapid' ? 1 : commandedCuts(run, first)
      problems.push(
        ...judge(`${take} master`, take, await read(master), commanded),
        ...judge(`${take} stream`, take, await read(stream), commanded)
      )
    }
    clearInterval(sampling)
    if (process.env.CUT_DELAY_MS != null) await send('/display-latency-cap?ms=1000')
    console.log(`memory peak ${peak.mb} MB`)
    if (peak.mb >= MEMORY_CAP_MB) problems.push(`memory peak ${peak.mb} MB, cap ${MEMORY_CAP_MB}`)
    if (process.env.CUT_DELAY_MS != null) {
      console.log('long delay, reported only:', problems)
    } else {
      assert.deepEqual(problems, [])
    }
    console.log('programme cuts OK')
  } finally {
    await m.stopApp({ appId: APP_ID }).catch(() => undefined)
    await m.detach().catch(() => undefined)
    stop()
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error)
    process.exit(1)
  }
)
