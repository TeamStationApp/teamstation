/**
 * Where a live media playlist's newest footage ends, in media seconds: every
 * segment's `EXTINF`, across its discontinuities. Undefined for anything that
 * is not a media playlist, or lists nothing yet.
 *
 * Shared by both platforms, so it asks nothing of `fetch` a phone does not
 * have.
 */
export function realEndSec(playlist: string): number | undefined {
  if (!playlist.startsWith('#EXTM3U')) return undefined
  let total = 0
  for (const match of playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)) {
    total += Number(match[1])
  }
  return total > 0 ? total : undefined
}

/** Reads a live media playlist's real end (`realEndSec`), or undefined. */
export async function readRealEndSec(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, {
      headers: { 'cache-control': 'no-cache' }
    })
    return response.ok ? realEndSec(await response.text()) : undefined
  } catch {
    return undefined
  }
}
