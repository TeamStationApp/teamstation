import { asArray, asObject, asOptional, asString, type Cleaner } from 'cleaners'

/**
 * An origin exactly as a browser writes one: `https://host[:port]`, no path,
 * no trailing slash, no query. `http:` only for a loopback host, which is all
 * a development server on one machine needs; anything that a phone or another
 * server reaches is `https:`.
 */
export const asOrigin: Cleaner<string> = (raw: unknown): string => {
  const text = asString(raw)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new TypeError(`${text} is not an origin`)
  }
  if (url.origin !== text) throw new TypeError(`${text} is not an origin`)
  if (url.protocol === 'https:') return text
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return text
  throw new TypeError(`${text} must be https`)
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/**
 * A signing certificate's SHA-256, as Digital Asset Links write it: 32
 * uppercase hex pairs joined by `:`.
 */
export const asFingerprint: Cleaner<string> = (raw: unknown): string => {
  const text = asString(raw)
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(text))
    throw new TypeError('A fingerprint is 32 uppercase hex pairs joined by ":"')
  return text
}

const asAppLink = asObject({
  /** The host the app's sign-in links name, and that its OS verifies. */
  origin: asOrigin,
  /** `<team>.<bundle id>` for each iOS app the host opens. */
  apple: asOptional(asObject({ appIds: asArray(asString) })),
  /** The Android package the host opens, and the keys that sign it. */
  android: asOptional(
    asObject({
      packageName: asString,
      sha256CertFingerprints: asArray(asFingerprint)
    })
  )
})
export type AppLink = ReturnType<typeof asAppLink>

const asAppLinksShape = asObject({
  knownServers: asOptional(asArray(asOrigin), () => []),
  apps: asOptional(asArray(asAppLink), () => [])
})
export type AppLinksConfig = ReturnType<typeof asAppLinksShape>

/**
 * The apps this server signs in through their own link hosts, and the other
 * servers a link host may send a browser to.
 *
 * Every app is an entry here, not a name in the code: which hosts exist,
 * which team signs the iOS apps and which keys sign the Android ones belong
 * to the deployment. Two entries with one origin would make "which app is
 * this host" ambiguous, so that is refused at load.
 */
export const asAppLinksConfig: Cleaner<AppLinksConfig> = (
  raw: unknown
): AppLinksConfig => {
  const config = asAppLinksShape(raw)
  const seen = new Set<string>()
  for (const app of config.apps) {
    if (seen.has(app.origin))
      throw new TypeError(`${app.origin} is listed twice in appLinks.apps`)
    seen.add(app.origin)
  }
  return config
}
