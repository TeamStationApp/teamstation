// A fake RTMP broadcaster: a camera, or TS Director's programme, for the live
// scoreboard tests, without an iPad or a phone.
//
//   node scripts/e2e/scoreboardLog/fakeBroadcaster.mjs \
//     --url rtmp://127.0.0.1:1946/live/<key> [--stamped] [--duration 180] \
//     [--outage <at>:<seconds>]... [--stall <at>:<seconds>]... \
//     [--jump <at>:<seconds>]... [--lead <seconds>] [--size 1280x720] \
//     [--fps 30] [--ffmpeg /opt/homebrew/bin/ffmpeg]
//
// 1. Plans the start, T0, `--lead` seconds ahead (by default long enough to
//    encode), and says so: `{"event":"planned","t0":…}`.
// 2. Encodes `--duration` seconds of a test picture to HEVC with the local
//    FFmpeg (libx265, a keyframe a second, no B-frames), every frame carrying
//    its wall clock, T0 plus its presentation time, burned in as LIVE_MARKER's
//    32 cells (mobile/apps/tsDirector/scripts/rtspLoopServer.js) at the
//    picture's bottom-left. `readMarker.ts` reads them back.
// 3. `--stamped` runs the file through the wall-clock stamper with T0, so
//    every frame also carries the SEI, as TS Director's programme does.
// 4. At T0 publishes it at real speed with `ffmpeg -re -c copy -f flv`, which
//    FFmpeg sends as enhanced RTMP for HEVC. Never `-tag:v hvc1` on the
//    publish.
// 5. `--outage 60:20` stops publishing 60 s in and starts again 20 s later
//    from where the picture would be by then, as a camera that lost its
//    network does: the twenty seconds in between are never sent, and the new
//    publish's timestamps start again from zero. Repeat it for more outages.
// 6. `--stall 70:20` stops the publishing FFmpeg (SIGSTOP) 70 s in, for 20 s,
//    and lets it go on (SIGCONT) on the same connection. `-re` then sends the
//    twenty seconds it owes as a burst, as an uplink that held its queue
//    does. Keep it under 30 s or the server closes the quiet publisher.
// 7. `--jump 40:34` moves every timestamp from 40 s in forward by 34 s, on
//    the same connection (the `setts` bitstream filter, the publish still
//    `-c copy`): an encoder that dropped its queue. PTS and DTS move
//    together; the picture, and the wall clock burned into it, do not.
//
// Several at once publish several angles. Each line it prints is one JSON
// event; the last is `{"event":"done"}`. It exits 1 if a publish fails.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(import.meta.url), '../../../..')
const { LIVE_MARKER } = require(
  join(root, 'mobile/apps/tsDirector/scripts/rtspLoopServer.js')
)

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    stamped: { type: 'boolean', default: false },
    duration: { type: 'string', default: '180' },
    outage: { type: 'string', multiple: true, default: [] },
    stall: { type: 'string', multiple: true, default: [] },
    jump: { type: 'string', multiple: true, default: [] },
    lead: { type: 'string' },
    size: { type: 'string', default: '1280x720' },
    fps: { type: 'string', default: '30' },
    ffmpeg: { type: 'string', default: '/opt/homebrew/bin/ffmpeg' }
  }
})
if (values.url == null)
  throw new Error('Give --url rtmp://<host>:<port>/<app>/<key>')
const duration = Number(values.duration)
const fps = Number(values.fps)
const [width, height] = values.size.split('x').map(Number)
const outages = values.outage
  .map(one => one.split(':').map(Number))
  .map(([at, seconds]) => ({ at, seconds }))
  .sort((a, b) => a.at - b.at)
for (const { at, seconds } of outages)
  if (!(at > 0 && seconds > 0 && at + seconds < duration))
    throw new Error(`--outage ${at}:${seconds} is not inside the stream`)
const timed = (list, name) =>
  list
    .map(one => one.split(':').map(Number))
    .map(([at, seconds]) => {
      if (!(at > 0 && seconds > 0 && at < duration))
        throw new Error(`--${name} ${at}:${seconds} is not inside the stream`)
      return { at, seconds }
    })
    .sort((a, b) => a.at - b.at)
const stalls = timed(values.stall, 'stall')
const jumps = timed(values.jump, 'jump')
// libx265 runs several times faster than real time at this size; a quarter
// of the length, and ten seconds to spare, covers the encode and the stamp.
const lead = values.lead == null ? 10 + duration / 4 : Number(values.lead)
const t0 = Math.ceil((Date.now() + lead * 1000) / 1000) * 1000

const say = event => console.log(JSON.stringify({ at: Date.now(), ...event }))
const pause = async ms =>
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

/** LIVE_MARKER's cells for wall ms `t0 + t`, at the bottom-left. */
function markerFilters() {
  const { bits, originX, stride, cell, sentinelSlot } = LIVE_MARKER
  const originY = height - 40 - cell
  const filters = [
    `drawbox=x=20:y=${originY - 20}:w=${originX + (sentinelSlot + 1) * stride - 16}:h=72:color=black:t=fill`
  ]
  for (let bit = 0; bit < bits; bit += 1) {
    filters.push(
      `drawbox=x=${originX + bit * stride}:y=${originY}:w=${cell}:h=${cell}:color=white:t=fill:` +
        `enable='mod(floor((${t0}+t*1000)/pow(2\\,${bit}))\\,2)'`
    )
  }
  filters.push(
    `drawbox=x=${originX + sentinelSlot * stride}:y=${originY}:w=${cell}:h=${cell}:color=white:t=fill`
  )
  return filters.join(',')
}

const work = mkdtempSync(join(tmpdir(), 'tsFakeBroadcaster-'))
let failed = false
/** The FFmpeg publishing now, stopped with this process. */
let publishing = null
// Stopped from outside — the player-layouts fixture's `--stop-live` ends a
// live angle this way — it left its encode behind, some 600 MB a time, and
// its FFmpeg publishing on with nothing to stop it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    publishing?.kill('SIGTERM')
    rmSync(work, { recursive: true, force: true })
    process.exit(1)
  })
}
try {
  say({
    event: 'planned',
    t0,
    t0Iso: new Date(t0).toISOString(),
    duration,
    outages,
    stalls,
    jumps,
    stamped: values.stamped
  })

  const encoded = join(work, 'picture.mp4')
  execFileSync(values.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-vf',
    markerFilters(),
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-crf',
    '30',
    '-x265-params',
    `log-level=error:keyint=${fps}:min-keyint=${fps}:scenecut=0:bframes=0`,
    '-pix_fmt',
    'yuv420p',
    '-tag:v',
    'hvc1',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    encoded
  ])
  let file = encoded
  if (values.stamped) {
    file = join(work, 'stamped.mp4')
    execFileSync(
      process.execPath,
      [
        '-r',
        'sucrase/register',
        join(root, 'scripts/stampWallClockSei.ts'),
        '--in',
        encoded,
        '--out',
        file,
        '--start',
        String(t0),
        '--ffmpeg',
        values.ffmpeg
      ],
      { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
    )
  }
  say({ event: 'encoded', stamped: values.stamped })
  if (Date.now() > t0)
    throw new Error(`the encode ran past T0; give a longer --lead than ${lead}`)

  // The stretches that are sent: from the start to the first outage, from
  // the end of each outage to the next, and on to the end.
  const parts = []
  let from = 0
  for (const { at, seconds } of outages) {
    parts.push({ from, to: at })
    from = at + seconds
  }
  parts.push({ from, to: duration })

  for (const part of parts) {
    await pause(t0 + part.from * 1000 - Date.now())
    say({ event: 'publish', fromSec: part.from, toSec: part.to })
    // Each jump inside this part, in the part's own timestamps, which start
    // again from zero; the later ones carry the earlier ones' offsets.
    const shifts = []
    let carried = 0
    for (const { at, seconds } of jumps) {
      if (at <= part.from || at >= part.to) continue
      shifts.push({ at: at - part.from + carried, seconds })
      carried += seconds
    }
    const moved = name =>
      shifts.reduce(
        (expr, { at, seconds }) =>
          `${expr}+if(gte(${name}\\,${at}/TB)\\,${seconds}/TB\\,0)`,
        name
      )
    const bsf =
      shifts.length === 0
        ? []
        : ['-bsf:v', `setts=pts=${moved('PTS')}:dts=${moved('DTS')}`]
    const code = await new Promise(resolve => {
      const child = spawn(
        values.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          ...(part.from > 0 ? ['-ss', String(part.from)] : []),
          '-i',
          file,
          '-t',
          String(part.to - part.from),
          '-c',
          'copy',
          ...bsf,
          '-f',
          'flv',
          values.url
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] }
      )
      publishing = child
      const timers = []
      for (const { at, seconds } of stalls) {
        if (at <= part.from || at >= part.to) continue
        timers.push(
          setTimeout(
            () => {
              child.kill('SIGSTOP')
              say({ event: 'stall', atSec: at, seconds })
              timers.push(
                setTimeout(() => {
                  child.kill('SIGCONT')
                  say({ event: 'resumed', atSec: at + seconds })
                }, seconds * 1000)
              )
            },
            Math.max(0, t0 + at * 1000 - Date.now())
          )
        )
      }
      child.on('exit', code => {
        publishing = null
        for (const timer of timers) clearTimeout(timer)
        resolve(code)
      })
    })
    say({ event: 'stopped', fromSec: part.from, toSec: part.to, code })
    if (code !== 0) {
      failed = true
      break
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
say({ event: 'done', failed })
process.exit(failed ? 1 : 0)
