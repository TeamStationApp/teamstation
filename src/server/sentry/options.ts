import type { NodeOptions } from '@sentry/node'
import {
  onUnhandledRejectionIntegration,
  rewriteFramesIntegration
} from '@sentry/node'

import { sentryEnvironment } from '../../common/sentry/environment'
import { isExplained } from '../../common/sentry/filter'
import { sentryRelease } from '../../common/sentry/release'
import {
  DATA_COLLECTION,
  scrubBreadcrumb,
  scrubEvent
} from '../../common/sentry/scrub'

/** A rejection nobody handled still ends the process, as it did before Sentry. */
export const UNHANDLED_REJECTION_MODE = 'strict'

export interface SentrySettings {
  dsn: string
  environment: string
}

/**
 * How the server starts Sentry, or `undefined` when it reports nothing.
 *
 * The console integration is left out: the server logs sign-in codes and
 * email addresses when it has no mail to send them with, and a console line
 * would ride along on the next event as a breadcrumb. Unhandled rejections are
 * `strict`, so a process still dies of one, as it did before Sentry, and the
 * cluster primary replaces the worker. Stack frames are named from `root`, the
 * checkout, so no event says where on a machine the server was unpacked.
 */
export function sentryOptions(
  settings: SentrySettings,
  primaryHost: string,
  version: string | undefined,
  root: string
): NodeOptions | undefined {
  if (settings.dsn === '') return undefined
  return {
    dsn: settings.dsn,
    environment:
      settings.environment !== ''
        ? settings.environment
        : sentryEnvironment(primaryHost),
    ...sentryRelease('teamstation-server', version ?? 'development'),
    dataCollection: DATA_COLLECTION,
    integrations: defaults => [
      ...defaults.filter(
        integration =>
          integration.name !== 'Console' &&
          integration.name !== 'OnUnhandledRejection'
      ),
      onUnhandledRejectionIntegration({ mode: UNHANDLED_REJECTION_MODE }),
      // Frames name files from the checkout's root, not where it was
      // unpacked on this machine.
      rewriteFramesIntegration({ root })
    ],
    beforeSend: (event, hint) =>
      isExplained(event, hint) ? null : scrubEvent(event),
    beforeBreadcrumb: crumb => scrubBreadcrumb(crumb)
  }
}
