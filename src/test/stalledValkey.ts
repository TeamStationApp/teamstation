import type { ScoreboardClient } from '../server/scoreboard/scoreboardStore'

/** A call a test settles by hand. */
export interface Pending<T> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/**
 * A client that stays connected and never answers on its own: each MULTI
 * and LRANGE waits until the test settles it. For the tests of live
 * playlists when Valkey stalls; `notify` announces entries of `videoId`.
 */
export function stalledValkey(videoId: string): {
  client: ScoreboardClient
  subscriber: ScoreboardClient
  reloads: Array<Pending<[string[], string | null]>>
  notify: (n: number, g: number) => void
} {
  const reloads: Array<Pending<[string[], string | null]>> = []
  let listener: (message: string) => void = () => {}
  const multi = {
    lRange: () => multi,
    get: () => multi,
    exec: async () =>
      await new Promise((resolve, reject) => {
        reloads.push({ resolve, reject })
      })
  }
  const client = {
    isReady: true,
    multi: () => multi
  }
  const subscriber = {
    on: () => subscriber,
    subscribe: async (_channel: string, heard: (message: string) => void) => {
      listener = heard
    }
  }
  // Only the calls the playlist code makes are here.
  return {
    client: client as unknown as ScoreboardClient,
    subscriber: subscriber as unknown as ScoreboardClient,
    reloads,
    notify: (n, g) => {
      listener(JSON.stringify({ v: videoId, n, g }))
    }
  }
}
