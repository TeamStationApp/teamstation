/**
 * Starts Sentry before anything else loads, so its instrumentation of `http`
 * and `express` is in place when they are imported. The first import of every
 * server process: the cluster primary and each worker (`index.ts`) and the
 * stats builder (`statsBuilder/start.ts`). Only those entry files import it, so
 * tests, which import the modules behind them, never start Sentry.
 */
import { init } from '@sentry/node'

import { deployedVersion } from '../buildVersion'
import { primaryHost, serverConfig } from '../serverConfig'
import { sentryOptions } from './options'

const options = sentryOptions(
  serverConfig.sentry,
  primaryHost,
  deployedVersion(),
  process.cwd()
)
if (options != null) init(options)
