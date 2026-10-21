/**
 * What a deployment decides and this repository does not name: the server a
 * build talks to, each development seat's server, the app link host, Sentry
 * and the Android Maps key. It is one Mason project secret,
 * `TS_PIPELINE_CONFIG`, a JSON object:
 *
 *   apiOrigin             the server a build without a seat talks to
 *   seats                 { "<n>": origin } for the `seat` parameter
 *   appOrigin             the app link host's origin (`clientConfig.json`)
 *   sentry                { origin, org, token, apps: { <app ID>: { project, dsn } } }
 *   googleMapsAndroidKey  the Maps key the TeamStation Android app is built with
 *
 * Every field is optional; a build without a server, a link host or Sentry
 * leaves that part out, as builds made without the deploy settings do.
 */

export interface SentryApp {
  project: string
  dsn: string
}
export interface PipelineConfig {
  apiOrigin?: string
  seats: Record<string, string>
  appOrigin?: string
  sentry?: {
    origin: string
    org: string
    token: string
    apps: Record<string, SentryApp>
  }
  googleMapsAndroidKey?: string
}

const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i

/** An `https://host[:port]` origin with nothing else, never a loopback host. */
export function httpsOrigin(value: unknown, what: string): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(`${what} is not an https origin`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    loopback.test(url.hostname)
  )
    throw new Error(`${what} is not an https origin`)
  return url.origin
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what} must be an object`)
  return value as Record<string, unknown>
}
function only(
  value: Record<string, unknown>,
  keys: string[],
  what: string
): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      throw new Error(`${what} has an unknown field ${key}`)
}
function word(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value))
    throw new Error(`${what} must be a plain name`)
  return value
}
function secret(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || /\s/.test(value))
    throw new Error(`${what} must be a non-empty string`)
  return value
}

/** Reads and checks the `TS_PIPELINE_CONFIG` secret. */
export function pipelineConfig(text: string): PipelineConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('TS_PIPELINE_CONFIG is not JSON')
  }
  const value = record(raw, 'TS_PIPELINE_CONFIG')
  only(
    value,
    ['apiOrigin', 'seats', 'appOrigin', 'sentry', 'googleMapsAndroidKey'],
    'TS_PIPELINE_CONFIG'
  )
  const out: PipelineConfig = { seats: {} }
  if (value.apiOrigin != null)
    out.apiOrigin = httpsOrigin(value.apiOrigin, 'apiOrigin')
  if (value.appOrigin != null)
    out.appOrigin = httpsOrigin(value.appOrigin, 'appOrigin')
  if (value.seats != null)
    for (const [seat, origin] of Object.entries(record(value.seats, 'seats'))) {
      if (!/^[1-9]$/.test(seat)) throw new Error(`Seat ${seat} is not 1–9`)
      out.seats[seat] = httpsOrigin(origin, `Seat ${seat}`)
    }
  if (value.sentry != null) {
    const sentry = record(value.sentry, 'sentry')
    only(sentry, ['origin', 'org', 'token', 'apps'], 'sentry')
    const apps: Record<string, SentryApp> = {}
    for (const [app, entry] of Object.entries(
      record(sentry.apps, 'sentry.apps')
    )) {
      const fields = record(entry, `sentry.apps.${app}`)
      only(fields, ['project', 'dsn'], `sentry.apps.${app}`)
      const dsn = new URL(secret(fields.dsn, `The DSN of ${app}`))
      if (dsn.protocol !== 'https:' || dsn.username === '')
        throw new Error(`The DSN of ${app} is not a Sentry DSN`)
      apps[app] = {
        project: word(fields.project, `The Sentry project of ${app}`),
        dsn: dsn.href
      }
    }
    out.sentry = {
      origin: httpsOrigin(sentry.origin, 'sentry.origin'),
      org: word(sentry.org, 'sentry.org'),
      token: secret(sentry.token, 'sentry.token'),
      apps
    }
  }
  if (value.googleMapsAndroidKey != null)
    out.googleMapsAndroidKey = secret(
      value.googleMapsAndroidKey,
      'googleMapsAndroidKey'
    )
  return out
}

/** The server a build talks to: the seat's when one was chosen, else the default. */
export function serverOrigin(
  config: PipelineConfig,
  seat: string
): string | undefined {
  if (seat === 'none' || seat === '') return config.apiOrigin
  const origin = config.seats[seat]
  if (origin == null)
    throw new Error(`Seat ${seat} has no server in TS_PIPELINE_CONFIG`)
  return origin
}

export interface BuildInfo {
  app: string
  version: string
  buildNumber: string
  branch: string
  commit: string
  builtAt: string
}

/** The variables the apps' build scripts read: build info, the server and the Sentry DSN. */
export function buildEnvironment(
  info: BuildInfo,
  origin: string | undefined,
  config: PipelineConfig
): Record<string, string> {
  const dsn = config.sentry?.apps[info.app]?.dsn
  return {
    NODE_BINARY: process.execPath,
    TS_BUILD_INFO: JSON.stringify(info),
    ...(origin == null
      ? {}
      : {
          TS_API_BASE_URL: `${origin}/api/v1`,
          TS_PRIMARY_HOST: new URL(origin).host
        }),
    ...(dsn == null ? {} : { TS_SENTRY_DSN: dsn })
  }
}

/** sentry-cli's variables for an app, or nothing when the app has no Sentry project. */
export function sentryEnvironment(
  config: PipelineConfig,
  app: string
): Record<string, string> | undefined {
  const sentry = config.sentry
  const project = sentry?.apps[app]
  if (sentry == null || project == null) return undefined
  return {
    SENTRY_URL: sentry.origin,
    SENTRY_ORG: sentry.org,
    SENTRY_PROJECT: project.project,
    SENTRY_AUTH_TOKEN: sentry.token
  }
}

/** The release a Sentry event names: `<app ID>@<version>+<build>`, the build as its dist. */
export function sentryRelease(
  app: string,
  version: string,
  buildNumber: string
): { release: string; dist: string } {
  return { release: `${app}@${version}+${buildNumber}`, dist: buildNumber }
}
