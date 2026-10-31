import type { ServerConfig } from '../serverConfig'
import type { ChangeFeed } from './feed'
import { PostgresFeed } from './postgresFeed'

/** The feed a process holds, on the database's own address. */
export function makeChangeFeed(
  config: Pick<ServerConfig, 'databaseUrl'>,
  log: (message: string) => void
): ChangeFeed {
  return new PostgresFeed({ databaseUrl: config.databaseUrl, log })
}
