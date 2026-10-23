/**
 * The Sentry SDK the iOS and Android apps report with. It catches native
 * crashes as well as JavaScript errors. The web bundle resolves `sentrySdk.ts`.
 */
import {
  addBreadcrumb,
  captureException,
  ErrorBoundary,
  init,
  nativeCrash,
  setTag,
  setUser
} from '@sentry/react-native'

import { hostOfUrl } from '../common/sentry/environment'
import { apiBaseUrl } from './native/config'

export {
  addBreadcrumb,
  captureException,
  ErrorBoundary,
  init,
  nativeCrash,
  setTag,
  setUser
}

/** The host of the server this build talks to. */
export function sentryHost(): string | undefined {
  return hostOfUrl(apiBaseUrl)
}

/**
 * The phone SDK collects nothing about the person unless told to. The native
 * hosts initialize their crash handlers with NativeSentryPrivacy before JS
 * starts. Keep those handlers and their beforeSend filters in place.
 */
export const sdkOptions = {
  autoInitializeNativeSdk: false,
  sendDefaultPii: false,
  enableAutoSessionTracking: false,
  sendClientReports: false,
  attachScreenshot: false,
  attachViewHierarchy: false,
  enableNetworkBreadcrumbs: false
}
