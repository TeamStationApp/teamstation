import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  chownSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync
} from 'node:fs'

import { asArray, asObject, asString } from 'cleaners'

import { asOAuthConfig } from '../../../src/server/oauth/config'
import { noSymlinks } from '../state'
import { integer } from '../validation'
import type { Remote } from './config'
import type { Exec } from './remote'

/** Prepare an operator-reviewed provider configuration; never restart or deploy TeamStation. */
export async function prepareOAuth(
  remote: Remote,
  mason: unknown,
  exec: Exec
): Promise<void> {
  const config = remote.oauth
  if (config == null) return
  const parsed = asObject({
    origin: asString,
    providers: asArray(
      asObject({
        id: asString,
        type: asString,
        issuer: asString,
        clientId: asString,
        clientSecret: asString
      })
    )
  })(mason)
  const provider = parsed.providers.find(item => item.id === config.providerId)
  if (
    provider?.type !== 'oidc' ||
    provider.issuer !== `${remote.teamstationOrigin}/oauth` ||
    provider.clientSecret.length < 32
  )
    throw new Error('TeamStation provider configuration does not match')
  const uid = integer(1)(Number(await exec('id', ['-u', config.user])))
  const gid = integer(1)(
    Number((await exec('getent', ['group', config.group])).split(':')[2])
  )
  const read = (file: string): string => {
    noSymlinks(file)
    const stat = lstatSync(file)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== uid ||
      stat.size > 1024 * 1024
    )
      throw new Error('Provider configuration is not private')
    return readFileSync(file, 'utf8')
  }
  const server = JSON.parse(read(config.serverConfigFile)) as Record<
    string,
    unknown
  >
  if (server == null || typeof server !== 'object' || Array.isArray(server))
    throw new Error('Invalid provider server configuration')
  const existing =
    server.oauth == null ? undefined : asOAuthConfig(server.oauth)
  if (
    existing != null &&
    (existing.signingKeysFile !== config.signingKeysFile ||
      existing.storageKeyFile !== config.storageKeyFile ||
      existing.cookieKeysFile !== config.cookieKeysFile)
  )
    throw new Error(
      'Existing provider key locations differ; review rotation explicitly'
    )
  const privateFile = (file: string, create: () => string): void => {
    noSymlinks(file)
    if (existsSync(file)) {
      read(file)
      return
    }
    if (existing != null) throw new Error('Existing provider key is missing')
    writeFileSync(file, create(), { flag: 'wx', mode: 0o600 })
    chownSync(file, uid, gid)
  }
  privateFile(config.signingKeysFile, () =>
    JSON.stringify({
      keys: [
        {
          kid: randomBytes(16).toString('hex'),
          pem: generateKeyPairSync('rsa', {
            modulusLength: 3072
          }).privateKey.export({ type: 'pkcs8', format: 'pem' })
        }
      ]
    })
  )
  privateFile(config.storageKeyFile, () =>
    randomBytes(32).toString('base64url')
  )
  privateFile(config.cookieKeysFile, () =>
    JSON.stringify([
      randomBytes(32).toString('base64url'),
      randomBytes(32).toString('base64url')
    ])
  )
  const client = {
    id: provider.clientId,
    name: config.clientName,
    secret: provider.clientSecret,
    redirectUris: [`${parsed.origin}/auth/callback/${provider.id}`]
  }
  const previous = existing?.clients.find(item => item.id === client.id)
  if (previous != null && JSON.stringify(previous) !== JSON.stringify(client))
    throw new Error(
      'Existing client differs; review client rotation explicitly'
    )
  const clients = existing?.clients ?? []
  if (previous == null) clients.push(client)
  server.oauth = {
    enabled: true,
    signingKeysFile: config.signingKeysFile,
    storageKeyFile: config.storageKeyFile,
    cookieKeysFile: config.cookieKeysFile,
    clients
  }
  server.buildsUrl = parsed.origin
  const candidate = `${config.serverConfigFile}.mason-candidate.json`
  const content = JSON.stringify(server, null, 2) + '\n'
  if (existsSync(candidate)) {
    if (read(candidate) !== content)
      throw new Error('Provider candidate changed; review before replacing')
    return
  }
  writeFileSync(candidate, content, { mode: 0o600, flag: 'wx' })
  chownSync(candidate, uid, gid)
}
