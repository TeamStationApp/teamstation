/**
 * The stats builder process: starts Sentry before anything else loads, then
 * runs the builder. Kept apart from `main.ts` so the tests that import the
 * builder never start Sentry, whatever the workstation's `serverConfig.json`
 * says.
 */
import '../sentry/instrument'

import path from 'node:path'

import { versionOf } from '../buildVersion'
import { startServerLogging } from '../observability/logging'
import { serverConfig } from '../serverConfig'
import { reportFailure, runMain } from './main'

const stopLogging = startServerLogging({
  dsn: serverConfig.sentry.dsn,
  writeToken: serverConfig.logWriteToken,
  directory: path.join(serverConfig.workDir, 'logs'),
  role: 'stats',
  version: versionOf()
})
runMain(undefined, stopLogging).catch(async (error: unknown) => {
  console.error('stats builder:', error)
  await reportFailure(error)
  await stopLogging()
  process.exit(1)
})
