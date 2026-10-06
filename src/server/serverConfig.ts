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

/** The same name again with no port, which is what a stream URL names. */
export const primaryHost: string = hostOf(primaryAuthority)
