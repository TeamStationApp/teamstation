#!/usr/bin/env node
// Client for the app's control server. Works against the simulator (127.0.0.1) and against the
// iPad over the USB link, and is what the verification scripts and the docs use rather than
// spelling out curl invocations.
//
//   node scripts/control.js --device state
//   node scripts/control.js --device enable 1 2 3
//   node scripts/control.js --device send /record?on=true

const { get, resolveHost } = require('./deviceTarget')

async function main() {
  const argv = process.argv.slice(2)
  const useDevice = argv.includes('--device')
  const args = argv.filter(value => value !== '--device')
  const command = args[0] ?? 'state'
  const host = await resolveHost(useDevice)

  switch (command) {
    case 'state': {
      process.stdout.write(`${await get(host, '/dump-state')}\n`)
      break
    }
    case 'summary': {
      const state = JSON.parse(await get(host, '/dump-state'))
      const tiles = state.tiles
        .map(
          tile =>
            `t${tile.index + 1}=${tile.state}/${tile.framesPerSecond.toFixed(1)}fps/arch${tile.archivedFrames}@${tile.archiveHeight}p`
        )
        .join('  ')
      process.stdout.write(
        [
          `profile=${state.sourceProfile} live=${state.sourceAvailable} sources=${state.discoveredSourceCount}`,
          `recording=${state.dvr.isRecording} segments=${state.dvr.segmentCount} proxy=${state.dvr.proxyStills}`,
          `encoders=${state.sessions.encodeSessions} failures=${state.sessions.encodeFailures} thermal=${state.thermalState}`,
          tiles
        ].join('\n') + '\n'
      )
      break
    }
    case 'enable': {
      for (const index of args.slice(1)) {
        await get(host, `/enable-source?index=${index}&on=true`)
      }
      process.stdout.write(`enabled ${args.slice(1).join(', ')}\n`)
      break
    }
    case 'send': {
      const target = args[1]
      if (!target) throw new Error('usage: control.js send <path>')
      process.stdout.write(`${await get(host, target)}\n`)
      break
    }
    default:
      throw new Error(
        `unknown command '${command}' (state|summary|enable|send)`
      )
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
