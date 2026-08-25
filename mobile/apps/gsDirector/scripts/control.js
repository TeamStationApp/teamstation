#!/usr/bin/env node
// Client for the app's control server. Works against the simulator (127.0.0.1) and against the
// iPad over the USB link, and is what the verification scripts and the docs use rather than
// spelling out curl invocations.
//
//   node scripts/control.js --device <udid> state
//   node scripts/control.js --device <udid> enable 1 2 3
//   node scripts/control.js --device <udid> send /record?on=true

const { get, resolveHost } = require('./deviceTarget')

const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{16}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/

async function main() {
  const argv = process.argv.slice(2)
  const args = []
  let useDevice = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--device') {
      useDevice = true
      const next = argv[index + 1]
      if (next && UDID_PATTERN.test(next)) {
        process.env.DIRECTOR_DEVICE_UDID = next
        index += 1
      }
      continue
    }
    args.push(value)
  }
  if (useDevice && !process.env.DIRECTOR_DEVICE_UDID) {
    throw new Error('pass --device <udid> or set DIRECTOR_DEVICE_UDID')
  }
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
