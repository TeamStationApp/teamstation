import type { NativeWalkUpMusicState } from './NativeWalkUpMusic'

/** How long reports gather before they are sent together. */
export const MUSIC_LOG_FLUSH_MS = 1000

type Post = (url: string, body: string) => Promise<unknown>

const defaultPost: Post = async (url, body) =>
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })

/**
 * Sends every `WalkUpMusicState` report to the server's `/logs`, tagged
 * `[client walkUpMusic-<platform>]`, so what a phone played — positions,
 * levels, fades — can be read next to what the server did. Reports gather
 * for a second, and an `idle` or `error` sends at once. Each is also written
 * to the console, which is the device log. A post that fails is dropped:
 * this is a record, never a reason for playback to stop.
 */
export function musicLog(
  apiBaseUrl: string,
  platform: string,
  post: Post = defaultPost
): (report: NativeWalkUpMusicState) => void {
  const run = Math.random().toString(36).slice(2, 10)
  let lines: Array<{
    at: string
    level: 'info'
    text: string
    data: NativeWalkUpMusicState
  }> = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer != null) clearTimeout(timer)
    timer = undefined
    if (lines.length === 0) return
    const body = JSON.stringify({
      source: `walkUpMusic-${platform}`,
      run,
      lines
    })
    lines = []
    post(`${apiBaseUrl}/logs`, body).catch(() => undefined)
  }

  return report => {
    console.log(`WalkUpMusicState ${JSON.stringify(report)}`)
    lines.push({
      at: new Date().toISOString(),
      level: 'info',
      text: `WalkUpMusicState ${report.kind}`,
      data: report
    })
    if (report.kind !== 'playing' || lines.length >= 50) flush()
    else timer ??= setTimeout(flush, MUSIC_LOG_FLUSH_MS)
  }
}
