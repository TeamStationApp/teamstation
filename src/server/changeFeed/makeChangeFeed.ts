import type * as ScoreboardStore from '../scoreboard/scoreboardStore'
import type { ServerConfig } from '../serverConfig'
import type { ChangeFeed } from './feed'
import { PostgresFeed } from './postgresFeed'
import type * as Valkey from './valkeyFeed'

/** The feed a process holds: Postgres itself, or Valkey behind the relay. */
export function makeChangeFeed(
  config: Pick<ServerConfig, 'databaseUrl' | 'changeFeed' | 'redis'>,
  log: (message: string) => void
): ChangeFeed {
  if (config.changeFeed === 'valkey') {
    // Loaded here, so a process on Postgres does not load a Valkey client: the
    // stats builder has no other use for one.
    const { ValkeyFeed } = require('./valkeyFeed') as typeof Valkey
    const { scoreboardPrefix } =
      require('../scoreboard/scoreboardStore') as typeof ScoreboardStore
    return new ValkeyFeed({
      url: config.redis.url,
      caFile: config.redis.caFile,
      prefix: scoreboardPrefix(config.redis.prefix, config.databaseUrl),
      log
    })
  }
  return new PostgresFeed({ databaseUrl: config.databaseUrl, log })
}
