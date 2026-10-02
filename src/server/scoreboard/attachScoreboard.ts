import type { Server } from 'node:http'

import type { ScoreboardHub } from './scoreboardHub'

export interface AttachScoreboardOptions {
  /**
   * When false, nothing here listens for upgrades. The server hands the hub
   * whatever its other sockets decline. Default true: this hub is the only
   * socket, and it destroys any other path.
   */
  listen?: boolean
}

/**
 * Hands the server's WebSocket upgrades to the scoreboard hub, which serves
 * its three paths and destroys anything else. Returns what shutdown calls:
 * an upgraded socket is no longer one of the server's connections, so
 * closing the server would not close it.
 */
export function attachScoreboard(
  server: Server,
  hub: ScoreboardHub,
  options: AttachScoreboardOptions = {}
): () => Promise<void> {
  if (options.listen === false) {
    return async () => {
      await hub.close()
    }
  }
  const onUpgrade: Parameters<Server['on']>[1] = (req, socket, head) => {
    hub.handleUpgrade(req, socket, head)
  }
  server.on('upgrade', onUpgrade)
  return async () => {
    server.off('upgrade', onUpgrade)
    await hub.close()
  }
}
