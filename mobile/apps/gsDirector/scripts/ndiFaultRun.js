#!/usr/bin/env node
// Drives the NDI fault sweep: start the farm, launch Director, then apply one fault at a time and
// assert on what the app did about it.
//
//   node scripts/ndiFaultRun.js --device <udid> --sim
//   node scripts/ndiFaultRun.js --device <udid> --sim --only tooLarge,stall
//
// Every case asserts three things, because any one of them alone can look like a pass: the app is
// still alive, the *named* counter moved, and the tiles that were not the target are unaffected.
// A fault that takes the whole board down while moving the right counter is not a pass.

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { get, resolveHost } = require('./deviceTarget')
const FARM = path.join(__dirname, 'fakeNdiCameras.js')
const FAULT_PORT = 8770

function parseArgs(argv) {
  const options = { device: null, sim: false, only: null, settle: 12 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[(index += 1)]
    if (arg === '--device') options.device = next()
    else if (arg === '--sim') options.sim = true
    else if (arg === '--only') options.only = next().split(',')
    else if (arg === '--settle') options.settle = Number(next())
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.device) throw new Error('pass --device <udid>')
  return options
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

async function state(host) {
  return JSON.parse(await get(host, '/dump-state'))
}

async function fault(query) {
  const response = await fetch(`http://127.0.0.1:${FAULT_PORT}/fault?${query}`)
  return response.json()
}

/// What the generator says it did with camera 1: frames it put on the wire, and frames it threw
/// away before sending. Every claim about what the app received is really a claim about the
/// difference between two counters, and without these the app's is unfalsifiable.
async function generatorCounts() {
  const response = await fetch(`http://127.0.0.1:${FAULT_PORT}/clock`)
  const camera = (await response.json()).cameras[0]
  return { sent: camera.framesSent, dropped: camera.framesDropped }
}

/// What is *not* here, and why.
///
/// A sender cannot put a structurally invalid frame on an NDI network. The SDK reads the sender's
/// header, converts to its own wire format, and builds a fresh header on the receiving side from
/// the colour format that receiver asked for — so a bad FourCC, a stride shorter than the row, or
/// a zero frame-rate denominator never reach a receiver as such. Measured: `fourcc=PA16` arrived
/// as ordinary UYVY and moved no counter, and `badstride=1` killed the *generator* rather than
/// producing a bad frame anywhere.
///
/// Those rules are still enforced — `NDIFrameValidator` refuses every one of them and names which
/// rule fired — but they are proved by `NDIFrameValidatorTests` against hand-built headers, which
/// is the only place they can be reached. Leaving them in this sweep would have produced cases
/// that pass because nothing happened.
///
/// Each case below names the tile it targets, the fault, and what must be true afterwards.
/// `expect` is given the before and after dumps plus what the generator says it sent.
const CASES = [
  {
    name: 'drop',
    fault: 'cam=1&drop=0.2',
    // Against the generator's own count, not against a nominal rate: the app receiving 24 of 30
    // frames is only a pass if the generator sent 24. Twenty percent so the shortfall is larger
    // than the noise in a one-second rate reading.
    // Two halves, and both are needed. The generator's `sent` already excludes what it threw
    // away, so "received equals sent" alone passes even when the fault never applied; and
    // "frames were dropped" alone passes even if the app then lost more of its own.
    expect: (before, after, counts) => {
      const received = after.tiles[0].capturedFrames - before.tiles[0].capturedFrames
      if (counts.dropped === 0) return 'the generator dropped nothing, so the fault never applied'
      if (counts.sent === 0) return 'the generator sent nothing'
      const ratio = received / counts.sent
      if (ratio < 0.95) {
        return `app received ${received} of the ${counts.sent} actually sent — it lost some of its own`
      }
      const share = counts.dropped / (counts.dropped + counts.sent)
      return share > 0.1 && share < 0.35
        ? null
        : `expected about 20% dropped at the sender, saw ${(share * 100).toFixed(0)}%`
    }
  },
  {
    name: 'burst',
    fault: 'cam=1&burst=45',
    // A dropout of a second and a half. The tile has to still be receiving afterwards.
    expect: (before, after) =>
      after.tiles[0].framesPerSecond > 20
        ? null
        : `tile did not recover from a burst loss (${after.tiles[0].framesPerSecond} fps)`
  },
  {
    name: 'stall',
    fault: 'cam=1&stall=12',
    // Sampled *during* the stall, not after it: waiting for the stall to end and then measuring
    // reads a camera that has already recovered, which passes for the wrong reason.
    settle: 6,
    // Not exactly zero. The fault takes effect on the generator's next loop iteration and the
    // SDK keeps a short receive queue, so a frame or two already in flight lands after the fault
    // is applied. Demanding zero fails on that race about one run in three and says nothing about
    // the app; what matters is that a twelve-second stall does not keep delivering.
    expect: (before, after, sent) => {
      const arrived = after.tiles[0].capturedFrames - before.tiles[0].capturedFrames
      return arrived <= 3
        ? null
        : `frames still arriving during a stall (+${arrived})`
    }
  },
  {
    name: 'stallRecovery',
    fault: 'cam=1&stall=6',
    settle: 12,
    // And it has to come back on its own, with the tile live again.
    expect: (before, after) =>
      after.tiles[0].framesPerSecond > 20
        ? null
        : `camera did not recover from a stall (${after.tiles[0].framesPerSecond} fps)`
  },
  {
    name: 'jitter',
    fault: 'cam=1&jitter=120',
    // The delay line absorbs it. What must not happen is frames arriving after they were due.
    expect: (before, after) => {
      const late = after.tiles[0].playoutLateFrames - before.tiles[0].playoutLateFrames
      return after.tiles[0].framesPerSecond > 15
        ? null
        : `jitter collapsed the tile (${after.tiles[0].framesPerSecond} fps, ${late} late)`
    }
  },
  {
    name: 'tooLarge',
    fault: 'cam=1&size=3840x2160',
    // 4K is out of scope and must be refused by name, with no encode session taken and the app
    // still alive.
    expect: (before, after) =>
      after.tiles[0].sourceStatus.includes('4K')
        ? null
        : `4K was not refused with a reason (status: "${after.tiles[0].sourceStatus}")`
  },
  {
    name: 'backwardsTimecode',
    fault: 'cam=1&timecode=back',
    expect: (before, after) =>
      after.tiles[0].outOfOrderFrames > before.tiles[0].outOfOrderFrames
        ? null
        : 'backwards timestamps did not move outOfOrderFrames'
  },
  {
    name: 'audioOff',
    fault: 'cam=1&audio=off',
    // A camera may send video only. The picture must be unaffected.
    expect: (before, after) =>
      after.tiles[0].framesPerSecond > 20
        ? null
        : `losing audio disturbed the picture (${after.tiles[0].framesPerSecond} fps)`
  },
  {
    name: 'audioRate44k',
    fault: 'cam=1&samplerate=44100',
    expect: (before, after) =>
      after.tiles[0].audioFrames > before.tiles[0].audioFrames
        ? null
        : 'audio stopped when the camera changed sample rate'
  },
  {
    name: 'malformedMetadata',
    fault: 'cam=1&metadata=malformed',
    // Nothing may happen. Malformed XML from a sender is documented as normal.
    expect: (before, after) =>
      after.tiles[0].framesPerSecond > 20
        ? null
        : 'malformed metadata disturbed the picture'
  },
  {
    name: 'resolutionChange',
    fault: 'cam=1&size=1280x720',
    expect: (before, after) =>
      after.tiles[0].sourceHeight === 720
        ? null
        : `resolution change not followed (height ${after.tiles[0].sourceHeight})`
  },
  {
    name: 'frameRateChange',
    fault: 'cam=1&fps=60',
    expect: (before, after) =>
      after.tiles[0].sourceFrameRate === 60
        ? null
        : `frame-rate change not followed (rate ${after.tiles[0].sourceFrameRate})`
  },
  {
    name: 'killAndRevive',
    fault: 'cam=1&kill=1',
    settle: 10,
    after: 'cam=1&revive=1',
    afterSettle: 15,
    expect: (before, after) =>
      after.tiles[0].framesPerSecond > 15
        ? null
        : `camera did not come back after being killed (${after.tiles[0].framesPerSecond} fps)`
  }
]

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const host = await resolveHost(!options.sim)

  const cases = options.only
    ? CASES.filter((entry) => options.only.includes(entry.name))
    : CASES

  const results = []
  for (const entry of cases) {
    // Every case starts from a clean fleet, or the previous fault's damage is attributed to this
    // one — which is how a sweep ends up with one real failure and eleven phantom ones.
    spawnSync('node', [FARM, '--fault', 'reset=1'], { stdio: 'ignore' })
    await sleep(options.settle)

    const before = await state(host)
    const countsBefore = await generatorCounts()
    await fault(entry.fault)
    await sleep(entry.settle ?? options.settle)

    if (entry.after) {
      await fault(entry.after)
      await sleep(entry.afterSettle ?? options.settle)
    }

    let after
    let counts
    try {
      after = await state(host)
      const countsAfter = await generatorCounts()
      counts = {
        sent: countsAfter.sent - countsBefore.sent,
        dropped: countsAfter.dropped - countsBefore.dropped
      }
    } catch (error) {
      results.push({ name: entry.name, failure: `app did not answer: ${error.message}` })
      process.stdout.write(`✗ ${entry.name} — app did not answer\n`)
      continue
    }

    // Every case also asserts the fleet is otherwise unharmed: a fault that moves the right
    // counter while taking the other three tiles down is not a pass.
    const bystanders = after.tiles.slice(1, 4).filter((tile) => tile.sourceID)
    const collapsed = bystanders.find((tile) => tile.framesPerSecond < 15)
    const failure = collapsed
      ? `tile ${collapsed.index} collapsed to ${collapsed.framesPerSecond} fps as a bystander`
      : entry.expect(before, after, counts)
    results.push({ name: entry.name, failure })
    process.stdout.write(
      `${failure ? '✗' : '✓'} ${entry.name}${failure ? ` — ${failure}` : ''}\n`
    )
  }

  spawnSync('node', [FARM, '--fault', 'reset=1'], { stdio: 'ignore' })

  const failures = results.filter((result) => result.failure)
  process.stdout.write(`\n${results.length - failures.length}/${results.length} passed\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
