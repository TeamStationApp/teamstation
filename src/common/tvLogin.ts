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
export function tvTokenOfUrl(value: string, origin: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.pathname !== '/tv-login'
    )
      return null
    const token = url.searchParams.get('token')
    return token != null && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  } catch {
    return null
  }
}
