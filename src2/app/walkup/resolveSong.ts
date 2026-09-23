import type { WalkUpSong } from '../../common/walkUpSong'
import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { matchSong, normaliseSongText } from './songMatch'
import type { WalkUpMusic } from './walkUpMusicTypes'

/** Whose song, on which team: a device link is kept per player per team. */
export interface SongOwner {
  teamId: string
  userId: string
}

/**
 * Which file on this phone a saved song is, as its songkeeper picked it.
 *
 * An Android file has no id that travels, and a file chosen through the
 * system picker is not in the phone's music search at all, so the phone that
 * saved it remembers its content address, under
 * `walkUp:<teamId>:<userId>:<providerId>`. Another phone finds the song by
 * matching instead.
 */
export interface DeviceLinks {
  read: (owner: SongOwner, providerId: string) => Promise<string | null>
  write: (owner: SongOwner, providerId: string, handle: string) => Promise<void>
}

export function deviceLinkStore(storage: PreferenceStorage): DeviceLinks {
  const key = (owner: SongOwner, providerId: string): string =>
    `walkUp:${owner.teamId}:${owner.userId}:${providerId}`
  return {
    async read(owner, providerId) {
      try {
        const handle = await storage.getItem(key(owner, providerId))
        return handle == null || handle === '' ? null : handle
      } catch {
        return null
      }
    },
    async write(owner, providerId, handle) {
      await storage.setItem(key(owner, providerId), handle)
    }
  }
}

export const deviceLinks = deviceLinkStore(deviceStorage)

/**
 * The handle `music` plays a saved song with on this phone, or null when it
 * is not here.
 *
 * In order: the device link this phone wrote when it saved the song; then a
 * search for its title and artist, taking the result with the same provider
 * id, then the same ISRC, then the same normalised title and artist within
 * two seconds (`matchSong`). A search that fails — no permission, no
 * network, no Apple Music — is the same answer as one that finds nothing.
 */
export async function resolveSong(
  music: WalkUpMusic,
  song: WalkUpSong,
  owner: SongOwner | null,
  links: DeviceLinks = deviceLinks
): Promise<string | null> {
  if (owner != null) {
    const linked = await links.read(owner, song.providerId)
    if (linked != null) return linked
  }
  try {
    const term =
      `${normaliseSongText(song.title)} ${normaliseSongText(song.artist)}`.trim()
    const found = await music.search(term === '' ? song.title : term)
    return matchSong(song, found)?.handle ?? null
  } catch {
    return null
  }
}
