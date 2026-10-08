import { createPrivateKey } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'
import type { JWK } from 'oidc-provider'

export const asOAuthConfig = asObject({
  enabled: asOptional(asBoolean, false),
  signingKeysFile: asString,
  storageKeyFile: asString,
  cookieKeysFile: asString,
  clients: asArray(
    asObject({
      id: asString,
      name: asString,
      secret: asString,
      redirectUris: asArray(asString)
    })
  )
})
export type OAuthConfig = ReturnType<typeof asOAuthConfig>

/** Key contents never appear in diagnostics, logs, or browser configuration. */
export function readPrivateFile(file: string): string {
  const stat = statSync(file)
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error('OAuth key files must be owner-only regular files')
  return readFileSync(file, 'utf8')
}

export function loadOAuthSecrets(config: OAuthConfig): {
  jwks: { keys: JWK[] }
  storageKey: Buffer
  cookieKeys: string[]
} {
  try {
    const raw = asObject({
      keys: asArray(
        asObject({
          kid: asString,
          pem: asString
        })
      )
    })(JSON.parse(readPrivateFile(config.signingKeysFile)))
    const keys = raw.keys.map(({ kid, pem }) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid)) throw new Error()
      const key = createPrivateKey(pem)
      if (
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error()
      return {
        ...key.export({ format: 'jwk' }),
        kid,
        use: 'sig',
        alg: 'RS256'
      }
    })
    if (keys.length === 0 || new Set(keys.map(k => k.kid)).size !== keys.length)
      throw new Error()
    const storageKey = Buffer.from(
      readPrivateFile(config.storageKeyFile).trim(),
      'base64url'
    )
    if (storageKey.length !== 32) throw new Error()
    const cookieKeys = asArray(asString)(
      JSON.parse(readPrivateFile(config.cookieKeysFile))
    )
    if (cookieKeys.length === 0 || cookieKeys.some(key => key.length < 43))
      throw new Error()
    const ids = new Set<string>()
    for (const client of config.clients) {
      if (
        ids.has(client.id) ||
        client.id === '' ||
        client.name === '' ||
        client.secret.length < 32 ||
        client.redirectUris.length === 0
      )
        throw new Error()
      ids.add(client.id)
      for (const redirect of client.redirectUris) {
        const url = new URL(redirect)
        if (
          url.protocol !== 'https:' ||
          url.username !== '' ||
          url.password !== '' ||
          url.hash !== ''
        )
          throw new Error()
      }
    }
    return { jwks: { keys }, storageKey, cookieKeys }
  } catch {
    throw new Error('OAuth private configuration is invalid')
  }
}
