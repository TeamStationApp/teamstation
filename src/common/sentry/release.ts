/**
 * The release a Sentry event names, so its stack is matched with the symbols
 * uploaded for the build that produced it: `<appId>@<version>+<build>`, with
 * the build also sent as the event's `dist`. A build without a number names
 * the version alone.
 */
export interface SentryRelease {
  release: string
  dist?: string
}

export function sentryRelease(
  appId: string,
  version: string,
  build?: string
): SentryRelease {
  if (build == null || build === '' || build === '—')
    return { release: `${appId}@${version}` }
  return { release: `${appId}@${version}+${build}`, dist: build }
}
