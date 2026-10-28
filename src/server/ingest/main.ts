/**
 * The live ingest process: `npm run start.ingest`, or
 * `node lib/server/ingest/main.js` under its own service.
 *
 * `--print-health-port` prints the port its health listener uses and exits,
 * before Sentry, logging or anything else that writes. A deploy script reads
 * that line as the port, so nothing else may reach stdout first, and nothing
 * may be created by a check that runs as whoever asked. Everything below is
 * therefore loaded with `require` after the flag is looked at: an `import`
 * would run first whatever order it was written in.
 *
 * Otherwise Sentry starts before anything else loads, as in every server
 * entry, and then `runIngest`. Kept apart from `run.ts` so the tests that
 * import the ingest never start Sentry.
 */
import type * as NodePath from 'node:path'

import type * as BuildVersion from '../buildVersion'
import type * as Database from '../db/database'
import type * as Controller from '../live/controller'
import type * as Splitter from '../live/splitter'
import type * as Logging from '../observability/logging'
import type * as Config from '../serverConfig'
import type * as Run from './run'

if (process.argv.includes('--print-health-port')) {
  const { serverConfig } = require('../serverConfig') as typeof Config
  const { ingestHealthPort } = require('./run') as typeof Run
  process.stdout.write(`${ingestHealthPort(serverConfig)}\n`)
  process.exit(0)
}

require('../sentry/instrument')

const path = require('node:path') as typeof NodePath
const { versionOf } = require('../buildVersion') as typeof BuildVersion
const { makeDatabase } = require('../db/database') as typeof Database
const { drainLiveController, startLiveController, stopLiveController } =
  require('../live/controller') as typeof Controller
const { rtmpBound } = require('../live/splitter') as typeof Splitter
const { startServerLogging } =
  require('../observability/logging') as typeof Logging
const { serverConfig } = require('../serverConfig') as typeof Config
const { runIngest } = require('./run') as typeof Run

const stopLogging = startServerLogging({
  dsn: serverConfig.sentry.dsn,
  writeToken: serverConfig.logWriteToken,
  directory: path.join(serverConfig.workDir, 'logs'),
  role: 'ingest',
  version: versionOf()
})

const exit = (code: number): void => {
  const leave = (): never => process.exit(code)
  stopLogging().then(leave, leave)
}

runIngest({
  config: serverConfig,
  makeDatabase,
  startLiveController,
  stopLiveController,
  drainLiveController,
  rtmpBound,
  log: message => {
    console.log(message)
  },
  logError: message => {
    console.error(message)
  },
  exit,
  onSignal: (signal, handler) => {
    process.on(signal, handler)
  }
}).catch((error: unknown) => {
  console.error('live ingest:', error)
  exit(1)
})
