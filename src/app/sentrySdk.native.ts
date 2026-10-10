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
 * SDKs send their crash reports without passing through the JavaScript scrub,
 * so they record no network breadcrumbs of their own: those hold full request
 * URLs, invite and media paths included. Requests still appear as breadcrumbs
 * through the JavaScript layer, scrubbed. (Android records none to begin
 * with; the iOS SDK reads this option.)
 */
export const sdkOptions = {
  sendDefaultPii: false,
  enableNetworkBreadcrumbs: false
}
