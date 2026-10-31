import { scoreboardPrefix } from '../scoreboard/scoreboardStore'
import type { ServerConfig } from '../serverConfig'
import type { ChangeFeed } from './feed'
import { PostgresFeed } from './postgresFeed'
import { ValkeyFeed } from './valkeyFeed'

/** The feed a process holds: Postgres itself, or Valkey behind the relay. */
export function makeChangeFeed(
  config: Pick<ServerConfig, 'databaseUrl' | 'changeFeed' | 'redis'>,
  log: (message: string) => void
): ChangeFeed {
  if (config.changeFeed === 'valkey')
    return new ValkeyFeed({
      url: config.redis.url,
      caFile: config.redis.caFile,
      prefix: scoreboardPrefix(config.redis.prefix, config.databaseUrl),
      log
    })
  return new PostgresFeed({ databaseUrl: config.databaseUrl, log })
}
