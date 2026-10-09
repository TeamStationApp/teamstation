/**
 * The Sentry SDK the web bundle reports with: the browser SDK. The phone apps
 * resolve `sentrySdk.native.ts` instead, which has the same names.
 */
import {
  captureException,
  ErrorBoundary,
  init,
  setTag,
  setUser
} from '@sentry/react'

import { DATA_COLLECTION } from '../common/sentry/scrub'

export { captureException, ErrorBoundary, init, setTag, setUser }

/** The host this page was served from, which is the server it talks to. */
export function sentryHost(): string | undefined {
  return globalThis.location?.hostname
}

/** Only a phone has native code to crash. */
export const nativeCrash: (() => void) | undefined = undefined

/** Options only this SDK takes: the browser collects nothing about the person. */
export const sdkOptions = { dataCollection: DATA_COLLECTION }
