#!/usr/bin/env node
// Resolves the app's data container and the paths inside it that the verification scripts
// read. Simulator containers come from `simctl`; on a device the app is sandboxed and the only
// way in is the control server's state dump, so `--device` returns the control-server view.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const BUNDLE_ID = process.env.DIRECTOR_BUNDLE_ID ?? 'co.gamestation.director'

function simulatorUDID() {
  const udid = process.env.DIRECTOR_SIMULATOR_UDID
  if (!udid) {
    throw new Error('set DIRECTOR_SIMULATOR_UDID to the simulator UDID')
  }
  return udid
}

function dataContainer(udid = simulatorUDID()) {
  return execFileSync(
    'xcrun',
    ['simctl', 'get_app_container', udid, BUNDLE_ID, 'data'],
    { encoding: 'utf8' }
  ).trim()
}

// Mirrors DirectorCore/DirectorPaths.swift. If one side moves, the other has to move with it.
function directorPaths(container) {
  const applicationSupport = path.join(
    container,
    'Library',
    'Application Support',
    'GSDirector'
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
    prepared: path.join(applicationSupport, 'Prepared'),
    telemetryDump: path.join(documents, 'telemetry.json')
  }
}

module.exports = {
  BUNDLE_ID,
  simulatorUDID,
  bootedSimulatorUDID: simulatorUDID,
  dataContainer,
  directorPaths
}

if (require.main === module) {
  const paths = directorPaths(dataContainer())
  process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`)
}
