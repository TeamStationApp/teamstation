import { statfs } from 'node:fs/promises'

/**
 * How much room is left where the video goes.
 *
 * A live game writes steadily for hours and nothing stops it: at 8 Mbit an
 * hour is about 3.6 GB, and a Saturday can hold five games. When the volume
 * fills, ffmpeg dies mid-game and what an operator sees is a stream that
 * stopped for no reason they can find.
 *
 * So the floor is checked before a stream is allowed to start, which is the
 * one moment when refusing costs nothing but a sentence.
 */
export async function freeBytes(path: string): Promise<number | undefined> {
  try {
    const stats = await statfs(path)
    // `bavail` rather than `bfree`: what this user may actually write, which on
    // most filesystems is less than what is unused.
    return stats.bsize * stats.bavail
  } catch {
    // No such path, or a filesystem that will not answer. A guard that cannot
    // measure must not be the thing that stops a game being recorded.
    return undefined
  }
}

export interface RoomToRecord {
  ok: boolean
  /** What to put on the stream's row, when there is not room. */
  reason?: string
}

/**
 * Whether a new stream may start.
 *
 * Unknown free space is a yes: this is a safety net, not a gate, and a net
 * that cannot see is worse than no net if it stops a game from being filmed.
 */
export function roomToRecord(
  free: number | undefined,
  floorBytes: number
): RoomToRecord {
  if (free == null) return { ok: true }
  if (free >= floorBytes) return { ok: true }
  return {
    ok: false,
    reason:
      `There is not enough room to record: ${gigabytes(free)} free, and ` +
      `${gigabytes(floorBytes)} is the floor. Something has to be deleted.`
  }
}

function gigabytes(bytes: number): string {
  const gb = bytes / 1_000_000_000
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}
