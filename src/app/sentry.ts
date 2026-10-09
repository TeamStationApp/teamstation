import { useEffect } from 'react'
import { Platform } from 'react-native'

import { buildInfo } from '../common/distribution'
import { sentryEnvironment } from '../common/sentry/environment'
import { isExplained } from '../common/sentry/filter'
import { sentryRelease } from '../common/sentry/release'
import { scrubBreadcrumb, scrubEvent } from '../common/sentry/scrub'
import * as defaultSdk from './sentrySdk'

/**
 * Crash and error reporting for the app, on the web, iOS and Android.
 *
 * One Sentry project takes all three: every event carries a `platform` tag,
 * the release of the build that produced it, the environment of the server it
 * talks to, and the signed-in account's id and nothing else about them. The
 * DSN is inlined at build time from `TS_SENTRY_DSN`; a build without one
 * reports nothing.
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
  if (started || dsn === '') return false
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
    beforeSend: (event, hint) =>
      isExplained(event, hint) ? null : scrubEvent(event),
    beforeBreadcrumb: crumb => scrubBreadcrumb(crumb)
  })
  // Set on the scope, not as an initial scope, so the phone SDK copies it to
  // the native layer and a native crash names its platform too.
  sdk.setTag('platform', platform)
  return true
}

/** Forgets that Sentry was started, for tests that start it more than once. */
export function resetSentryForTest(): void {
  started = false
}

/** Names the signed-in account on every event by its id, and forgets it on sign-out. */
export function useSentryUser(
  userId: string | number | undefined,
  sdk: SentrySdk = defaultSdk
): void {
  useEffect(() => {
    sdk.setUser(userId == null ? null : { id: String(userId) })
  }, [sdk, userId])
}

/** Throws while rendering, so an administrator can see the error screen work. */
export function RenderErrorProbe(): never {
  throw new Error('Sentry test render error')
}
