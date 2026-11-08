import { asEither, asNumber, asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'
export const asTvPlatform = asLiteral('Apple TV', 'Google TV')
export type TvPlatform = ReturnType<typeof asTvPlatform>
export const asTvLoginRequest = asObject({
  requestId: asString,
  clientSecret: asString,
  displayCode: asString,
  qrUrl: asString,
  expiresAt: asNumber
})
export type TvLoginRequest = ReturnType<typeof asTvLoginRequest>
export const asTvLoginPreview = asObject({
  platform: asTvPlatform,
  location: asEither(asString, asLiteral(null)),
  expiresAt: asNumber
})
export type TvLoginPreview = ReturnType<typeof asTvLoginPreview>
/** The grouping is presentation only; the credential contains eight letters. */
export function normalizeTvCode(value: string): string | null {
  const code = value.replace(/[\s–-]/g, '').toUpperCase()
  return /^[A-Z]{8}$/.test(code) ? code : null
}
export function tvLinkOfUrl(
  value: string,
  origin: string
): { token: string; server?: string } | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.pathname !== '/tv-login'
    )
      return null
    const token = url.searchParams.get('token')
    const server = url.searchParams.get('server')
    if (
      url.searchParams.getAll('token').length !== 1 ||
      url.searchParams.getAll('server').length > 1
    )
      return null
    if (server != null && !isTvServerOrigin(server)) return null
    return token != null && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? { token, ...(server == null ? {} : { server }) }
      : null
  } catch {
    return null
  }
}

export function tvTokenOfUrl(value: string, origin: string): string | null {
  return tvLinkOfUrl(value, origin)?.token ?? null
}

/** Origin syntax only. Callers separately enforce issuer identity or redirect allowlists. */
export function isTvServerOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === value &&
      (url.protocol === 'https:' || url.protocol === 'http:')
    )
  } catch {
    return false
  }
}

/** The browser handoff is limited to public product servers. */
export function tvBrowserUrl(
  server: string,
  token: string
): string | undefined {
  if (!/^https:\/\/(web|develop[1-8]?)\.teamstation\.app$/.test(server))
    return undefined
  return `${server}/account/tv?token=${encodeURIComponent(token)}`
}

export function defaultTvAppOrigin(
  server: string | undefined,
  registered?: readonly string[]
): string {
  const selected = /^https:\/\/develop[1-8]?\.teamstation\.app$/.test(
    server ?? ''
  )
    ? 'https://develop.teamstation.app'
    : 'https://app.teamstation.app'
  return registered != null &&
    registered.length > 0 &&
    !registered.includes(selected)
    ? registered[0]
    : selected
}
