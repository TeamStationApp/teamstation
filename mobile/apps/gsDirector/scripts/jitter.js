#!/usr/bin/env node
// Samples the per-tile frame-timing extremes once a second and reports where a stutter came from.
//
// A tile can show 30 fps and still hitch visibly: the average hides one late frame in thirty. This
// prints the widest arrival gap for each second (`gap`, with `k` when that gap ended on a keyframe)
// beside the longest a single frame spent in our own decode-and-deliver work (`dlv`). A gap of two
// frame intervals with a small `dlv` is the camera's pacing; a gap that tracks `dlv` is ours.
//
// `release` is the same widest gap measured where frames leave the delay line, which is what the
// screen actually shows: `gap` spiking while `release` stays near one frame interval is the buffer
// working. `held` is how much video the delay line is holding to achieve that, and `late` counts
// frames that arrived after they were due, each of which was a visible stall.
//
//   node scripts/jitter.js --device --seconds 20
//   node scripts/jitter.js --device --seconds 20 --record

const { get, resolveHost } = require('./deviceTarget')

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const useDevice = process.argv.includes('--device')
  const seconds = Number(argument('seconds', 20))
  const host = await resolveHost(useDevice)

  if (process.argv.includes('--record')) {
    await get(host, '/record?on=true')
    process.stdout.write('recording on\n')
  }

  const samples = new Map()
  for (let second = 0; second < seconds; second += 1) {
    const state = JSON.parse(await get(host, '/dump-state'))
    for (const tile of state.tiles) {
      if (tile.state !== 'live') continue
      const key = tile.index + 1
      const list = samples.get(key) ?? []
      // The app republishes each second's figures for a whole second, so the same window can be
      // sampled twice. Keeping distinct readings only avoids counting one stutter as two.
      const last = list[list.length - 1]
      const reading = {
        gap: tile.arrivalGapMaxMilliseconds,
        keyframe: tile.arrivalGapWasKeyframe,
        deliver: tile.deliverMaxMilliseconds,
        mean: tile.deliveryMilliseconds,
        buffer: tile.pacingSpreadMilliseconds,
        release: tile.releaseGapMaxMilliseconds,
        playout: tile.playoutMilliseconds,
        late: tile.playoutLateFrames,
        fps: tile.framesPerSecond
      }
      if (
        !last ||
        last.gap !== reading.gap ||
        last.release !== reading.release ||
        last.deliver !== reading.deliver ||
        last.fps !== reading.fps
      ) {
        list.push(reading)
      }
      samples.set(key, list)
    }
    await sleep(1000)
  }

  if (process.argv.includes('--record')) {
    await get(host, '/record?on=false')
    process.stdout.write('recording off\n')
  }

  for (const [tile, readings] of [...samples].sort((a, b) => a[0] - b[0])) {
    const gaps = readings.map(entry => entry.gap)
    const releases = readings.map(entry => entry.release)
    const delivers = readings.map(entry => entry.deliver)
    const playouts = readings.map(entry => entry.playout)
    const keyframes = readings.filter(entry => entry.keyframe).length
    // The buffer figure closes its own ten-second window, so most readings repeat the previous one;
    // only the changes are separate measurements. Zero means no window has closed yet.
    const buffers = readings
      .map(entry => entry.buffer)
      .filter((value, index, all) => value > 0 && value !== all[index - 1])
    process.stdout.write(
      [
        `tile ${tile}: ${readings.length} windows`,
        `gap median ${median(gaps).toFixed(0)}ms worst ${Math.max(...gaps).toFixed(0)}ms`,
        `release median ${median(releases).toFixed(0)}ms worst ${Math.max(...releases).toFixed(0)}ms`,
        `held median ${median(playouts).toFixed(0)}ms late ${readings[readings.length - 1].late}`,
        `keyframe-aligned ${keyframes}/${readings.length}`,
        `deliver mean ${readings[readings.length - 1].mean.toFixed(1)}ms median-worst ${median(delivers).toFixed(1)}ms worst ${Math.max(...delivers).toFixed(1)}ms`,
        `fps ${median(readings.map(entry => entry.fps)).toFixed(1)}`,
        `buffer needed median ${median(buffers).toFixed(0)}ms worst ${Math.max(0, ...buffers).toFixed(0)}ms`
      ].join('  ') + '\n'
    )
  }
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
