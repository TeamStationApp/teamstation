#!/usr/bin/env node
// Resolves the app's data container and the paths inside it that the verification scripts
// read. Simulator containers come from `simctl`; on a device the app is sandboxed and the only
// way in is the control server's state dump, so `--device` returns the control-server view.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const BUNDLE_ID = process.env.PRODUCER_BUNDLE_ID ?? 'co.gamestation.producer'

function bootedSimulatorUDID() {
  const raw = execFileSync(
    'xcrun',
    ['simctl', 'list', 'devices', 'booted', '-j'],
    {
      encoding: 'utf8'
    }
  )
  const data = JSON.parse(raw)
  for (const runtime of Object.keys(data.devices)) {
    for (const device of data.devices[runtime]) {
      if (device.state === 'Booted') return device.udid
    }
  }
  throw new Error('no booted simulator — run `socket npm run boot:sim`')
}

function dataContainer(udid = bootedSimulatorUDID()) {
  return execFileSync(
    'xcrun',
    ['simctl', 'get_app_container', udid, BUNDLE_ID, 'data'],
    { encoding: 'utf8' }
  ).trim()
}

// Mirrors ProducerCore/ProducerPaths.swift. If one side moves, the other has to move with it.
function producerPaths(container) {
  const applicationSupport = path.join(
    container,
    'Library',
    'Application Support',
    'GSProducer'
  )
  const documents = path.join(container, 'Documents')
  return {
    container,
    applicationSupport,
    documents,
    archives: path.join(applicationSupport, 'Archives'),
    proxies: path.join(applicationSupport, 'Proxies'),
    indexDatabase: path.join(applicationSupport, 'index.sqlite'),
    program: path.join(documents, 'Program'),
    exports: path.join(documents, 'Exports'),
    telemetryDump: path.join(documents, 'telemetry.json')
  }
}

module.exports = {
  BUNDLE_ID,
  bootedSimulatorUDID,
  dataContainer,
  producerPaths
}

if (require.main === module) {
  const paths = producerPaths(dataContainer())
  process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`)
}
