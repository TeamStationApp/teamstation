import { useEffect } from 'react'
import { AppState, Platform } from 'react-native'

import { buildInfo } from '../common/distribution'
import { safeErrorEvent } from '../common/observability/errors'
import { logEndpoint } from '../common/observability/logger'
import { sentryEnvironment } from '../common/sentry/environment'
import { isExplained } from '../common/sentry/filter'
import { sentryRelease } from '../common/sentry/release'
import {
  emitAppLog,
  flushAppLogs,
  resetAppLogging,
  startAppLogging
} from './observability/log'
import * as defaultSdk from './sentrySdk'

/**
 * Crash and error reporting for the app, on the web, iOS and Android.
 *
 * SDK envelopes go to the log collector, which assigns app and environment.
 * Only approved error classes, code locations and release survive the scrub.
 * The public DSN is inlined from `TS_SENTRY_DSN`; an unconfigured build sends
 * nothing.
 */

declare const process: { env: Record<string, string | undefined> }

export type SentrySdk = Pick<
  typeof defaultSdk,
  'init' | 'setUser' | 'setTag' | 'sentryHost' | 'sdkOptions'
>

let started = false

export function startSentry({
  dsn = process.env.TS_SENTRY_DSN ?? '',
  sdk = defaultSdk,
  platform = Platform.OS
}: { dsn?: string; sdk?: SentrySdk; platform?: string } = {}): boolean {
  if (started || logEndpoint(dsn) == null) return false
  started = true
  // A phone build names itself and its build number; a web build's number is
  // the deploy's whole version, which is what its source maps are uploaded as.
  const release =
    platform === 'web'
      ? sentryRelease('app.teamstation.web', buildInfo.buildNumber)
      : sentryRelease(
          'app.teamstation.app',
          buildInfo.version,
          buildInfo.buildNumber
        )
  sdk.init({
    ...sdk.sdkOptions,
    dsn,
    ...release,
    environment: sentryEnvironment(sdk.sentryHost()),
    sendDefaultPii: false,
    sendClientReports: false,
    integrations: defaults =>
      defaults.filter(integration => integration.name !== 'BrowserSession'),
    maxBreadcrumbs: 0,
    beforeSend: (event, hint) =>
      isExplained(event, hint) ? null : safeErrorEvent(event),
    beforeBreadcrumb: () => null
  })
  // Set on the scope, not as an initial scope, so the phone SDK copies it to
  // the native layer and a native crash names its platform too.
  sdk.setTag('platform', platform)
  startAppLogging(
    dsn,
    platform,
    platform === 'web'
      ? buildInfo.buildNumber
      : buildInfo.version + '+' + buildInfo.buildNumber
  )
  return true
}

/** Forgets that Sentry was started, for tests that start it more than once. */
export function resetSentryForTest(): void {
  started = false
  resetAppLogging()
}

/** Keeps the local SDK scope current; the transport scrub omits account identity. */
export function useSentryUser(
  userId: string | number | undefined,
  sdk: SentrySdk = defaultSdk
): void {
  useEffect(() => {
    sdk.setUser(userId == null ? null : { id: String(userId) })
  }, [sdk, userId])
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      emitAppLog(state === 'active' ? 'app_foreground' : 'app_background')
      if (state !== 'active') flushAppLogs().catch(() => {})
    })
    return () => {
      listener.remove()
    }
  }, [])
}

/** Throws while rendering, so an administrator can see the error screen work. */
export function RenderErrorProbe(): never {
  throw new Error('Sentry test render error')
}
