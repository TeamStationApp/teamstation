/**
 * The stats builder process: starts Sentry before anything else loads, then
 * runs the builder. Kept apart from `main.ts` so the tests that import the
 * builder never start Sentry, whatever the workstation's `serverConfig.json`
 * says.
 */
import '../sentry/instrument'

import { reportFailure, runMain } from './main'

/* c8 ignore start */
runMain().catch(async (error: unknown) => {
  console.error('stats builder:', error)
  await reportFailure(error)
  process.exit(1)
})
/* c8 ignore stop */
