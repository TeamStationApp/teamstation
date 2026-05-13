#!/usr/bin/env node
/*
 * streamTestPattern: dev helper that pushes a synthetic lavfi pattern
 * (testsrc2 + 1 kHz tone) to an arbitrary RTMP URL. Useful for poking
 * the /split UI by hand without needing an actual camera / OBS.
 *
 * Usage:
 *   node tools/streamTestPattern.js --url rtmp://localhost:1935/split/myevent
 *   node tools/streamTestPattern.js --url rtmp://... --duration 60
 *   node tools/streamTestPattern.js --url rtmp://... --duration 60 --size 1920x1080 --rate 30
 *
 * Requires `ffmpeg` on PATH. Stop early with Ctrl-C; ffmpeg will exit cleanly.
 */
const { spawn } = require('child_process')

function parseArgs(argv) {
  const out = {
    url: '',
    duration: 30,
    size: '1280x720',
    rate: 30
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--url') {
      out.url = next
      i += 1
    } else if (a === '--duration') {
      out.duration = parseInt(next, 10)
      i += 1
    } else if (a === '--size') {
      out.size = next
      i += 1
    } else if (a === '--rate') {
      out.rate = parseInt(next, 10)
      i += 1
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: streamTestPattern.js --url <rtmp-url> [--duration <s>] [--size WxH] [--rate fps]'
      )
      process.exit(0)
    } else {
      console.error('Unknown arg:', a)
      process.exit(2)
    }
  }
  if (out.url === '') {
    console.error('--url is required, e.g. rtmp://localhost:1935/split/myevent')
    process.exit(2)
  }
  return out
}

function main() {
  const opts = parseArgs(process.argv)
  console.log(
    `Pushing lavfi pattern to ${opts.url} for ${opts.duration}s (${opts.size} @ ${opts.rate}fps)`
  )
  const args = [
    '-hide_banner',
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${opts.size}:rate=${opts.rate}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(opts.rate * 2),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-t',
    String(opts.duration),
    '-f',
    'flv',
    opts.url
  ]
  const child = spawn('ffmpeg', args, { stdio: 'inherit' })
  const onSignal = signal => () => {
    console.log(`\nReceived ${signal}, stopping ffmpeg...`)
    child.kill(signal)
  }
  process.on('SIGINT', onSignal('SIGINT'))
  process.on('SIGTERM', onSignal('SIGTERM'))
  child.on('exit', code => process.exit(code ?? 0))
}

main()
