import { makeConfig } from 'cleaner-config'

import {
  asAuthority,
  type Authority,
  hostOf,
  httpOrigin,
  PRIMARY_HOST
} from '../common/primaryUrl'
import { asServerConfig, type ServerConfig } from './serverConfigSchema'

export {
  asServerConfig,
  type LiveSettings,
  type ServerConfig,
  type SmtpSettings
} from './serverConfigSchema'

function loadServerConfig(): ServerConfig {
  try {
    return makeConfig(asServerConfig, './serverConfig.json')
  } catch {
    // cleaner-config includes the entire input in validation errors, which
    // can contain OAuth client secrets and other private configuration.
    throw new Error('Invalid server configuration')
  }
}
export const serverConfig: ServerConfig = loadServerConfig()

/**
 * What this server is called: a host, with a port only where it has one.
 *
 * The override when a deployment sets one, and otherwise the name in the
 * source, which is what production runs on. Resolved once, here, so no caller
 * has to remember which of the two it is.
 */
export const primaryAuthority: Authority =
  serverConfig.primaryUrlOverride === ''
    ? PRIMARY_HOST
    : asAuthority(serverConfig.primaryUrlOverride)

/** The same name with the scheme it implies: the origin links are built on. */
export const publicUrl: string = httpOrigin(primaryAuthority)

/**
 * The issuer device event control keys are derived from: the configured
 * `eventControlIssuer`, or else the public origin.
 */
export function eventControlIssuerOf(
  config: Pick<ServerConfig, 'eventControlIssuer'>,
  origin: string
): string {
  return config.eventControlIssuer ?? origin
}

/**
 * Where request traffic connects: the pooler when there is one, and otherwise
 * the database itself. `databaseUrl` stays the database's own address, for
 * what a transaction pool cannot carry and for the name it holds.
 */
export function requestDatabaseUrl(
  config: Pick<ServerConfig, 'databaseUrl' | 'databasePoolUrl'>
): string {
  return config.databasePoolUrl === ''
    ? config.databaseUrl
    : config.databasePoolUrl
}

/** What Tess calls the Messages API with. Never sent to a client. */
export interface TessSettings {
  apiKey: string
  baseUrl: string
  model: string
}

/** Tess's settings, or null when nothing has a key for her. */
export function tessSettings(
  config: Pick<ServerConfig, 'tess' | 'dictation'>
): TessSettings | null {
  const apiKey = config.tess?.apiKey ?? config.dictation?.anthropic?.apiKey
  if (apiKey == null || apiKey === '') return null
  return {
    apiKey,
    baseUrl: config.tess?.baseUrl ?? 'https://api.anthropic.com/v1',
    model: config.tess?.model ?? 'claude-sonnet-5-5'
  }
}

/** The same name again with no port, which is what a stream URL names. */
export const primaryHost: string = hostOf(primaryAuthority)
