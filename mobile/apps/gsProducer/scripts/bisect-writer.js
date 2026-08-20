#!/usr/bin/env node
// Runs the on-device AVAssetWriter probe across a matrix of configurations so a writer failure can
// be attributed to a specific setting rather than guessed at. One app launch, many probes.
const { execFileSync } = require('child_process')
const path = require('path')

const control = path.join(__dirname, 'control.js')

const configurations = [
  { label: 'baseline (segmented, full settings, own pool)', query: '' },
  { label: 'non-segmented file writer', query: 'segmented=0' },
  { label: 'segmented, minimal compression settings', query: 'minimal=1' },
  { label: 'segmented, adaptor-provided pool', query: 'adaptorpool=1' },
  {
    label: 'non-segmented + minimal + adaptor pool',
    query: 'segmented=0&minimal=1&adaptorpool=1'
  },
  { label: '640x360 segmented', query: 'width=640&height=360&bitrate=1500000' },
  { label: 'hevc segmented', query: 'codec=hevc' }
]

function send(route) {
  return execFileSync('node', [control, '--device', 'send', route], {
    encoding: 'utf8'
  })
}

function probeResult() {
  const raw = execFileSync('node', [control, '--device', 'state'], {
    encoding: 'utf8'
  })
  return JSON.parse(raw).encodeProbe
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function main() {
  const frames = process.argv[2] ? Number(process.argv[2]) : 30
  for (const configuration of configurations) {
    const query = ['frames=' + frames, configuration.query]
      .filter(Boolean)
      .join('&')
    send('/probe-writer?' + query)
    // The probe paces itself at the source frame rate, plus finishWriting.
    sleep(frames * 34 + 6000)
    console.log(configuration.label.padEnd(46), '->', probeResult())
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
