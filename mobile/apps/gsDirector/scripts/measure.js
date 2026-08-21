#!/usr/bin/env node
// Samples the control server twice and reports the rates in between. `framesPerSecond` in a
// single dump is instantaneous and jitters badly with network sources, so anything that claims
// a source is or is not keeping up should be measured over a window instead.
//
//   node scripts/measure.js --device --seconds 20

const { get, resolveHost } = require('./deviceTarget')

async function main() {
  const argv = process.argv.slice(2)
  const useDevice = argv.includes('--device')
  const secondsIndex = argv.indexOf('--seconds')
  const seconds = secondsIndex >= 0 ? Number(argv[secondsIndex + 1]) : 15

  const host = await resolveHost(useDevice)
  const first = JSON.parse(await get(host, '/dump-state'))
  await new Promise(resolve => setTimeout(resolve, seconds * 1000))
  const second = JSON.parse(await get(host, '/dump-state'))

  const elapsed = second.generatedAt - first.generatedAt
  process.stdout.write(
    `window ${elapsed.toFixed(1)}s  thermal=${second.thermalState}\n`
  )
  for (const [index, tile] of second.tiles.entries()) {
    const before = first.tiles[index]
    if (tile.state === 'empty' && before.state === 'empty') continue
    const received = (tile.receivedFrames - before.receivedFrames) / elapsed
    const archived = (tile.archivedFrames - before.archivedFrames) / elapsed
    const dropped = tile.droppedFrames - before.droppedFrames
    const proxy = (tile.proxyStills - before.proxyStills) / elapsed
    const source = tile.sourceWidth
      ? `${tile.sourceWidth}x${tile.sourceHeight}@${tile.sourceFrameRate.toFixed(2)} ${tile.sourcePixelFormat} conn=${tile.connections}`
      : 'no format yet'
    process.stdout.write(
      `  tile ${index + 1} ${tile.state.padEnd(9)} in ${received.toFixed(1)}/s  ` +
        `archived ${archived.toFixed(1)}/s at ${tile.archiveHeight}p  proxy ${proxy.toFixed(2)}/s  dropped ${dropped}\n` +
        `         source ${source}\n`
    )
  }
  const converted =
    (second.converter.convertedFrames - first.converter.convertedFrames) /
    elapsed
  const segments = second.dvr.segmentCount - first.dvr.segmentCount
  const megabytes = (second.dvr.byteCount - first.dvr.byteCount) / 1024 / 1024
  process.stdout.write(
    `  converter ${converted.toFixed(1)}/s at ${second.converter.averageMilliseconds.toFixed(2)}ms  ` +
      `failed ${second.converter.failedFrames}\n` +
      `  dvr +${segments} segments  +${megabytes.toFixed(1)} MB  ` +
      `encoders ${second.sessions.encodeSessions}  failures ${second.sessions.encodeFailures}\n`
  )
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
