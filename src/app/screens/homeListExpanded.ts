import { deviceStorage } from '../platform/deviceStorage'

/** This device's choice of which home sections are open. */
export const HOME_LIST_EXPANDED_KEY = 'home.listExpanded'

export interface HomeListExpanded {
  teams: boolean
  seasons: boolean
  leagues: boolean
}

const collapsed = (): HomeListExpanded => ({
  teams: false,
  seasons: false,
  leagues: false
})

function flagsOf(raw: string | null): HomeListExpanded {
  if (raw == null) return collapsed()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object') return collapsed()
    const record = parsed as Partial<HomeListExpanded>
    return {
      teams: record.teams === true,
      seasons: record.seasons === true,
      leagues: record.leagues === true
    }
  } catch {
    return collapsed()
  }
}

/** The sections this device left open. Missing or unreadable storage is collapsed. */
export async function readHomeListExpanded(): Promise<HomeListExpanded> {
  try {
    return flagsOf(await deviceStorage.getItem(HOME_LIST_EXPANDED_KEY))
  } catch {
    return collapsed()
  }
}

/** Remembers which sections are open on this device. */
export async function writeHomeListExpanded(
  flags: HomeListExpanded
): Promise<void> {
  try {
    await deviceStorage.setItem(HOME_LIST_EXPANDED_KEY, JSON.stringify(flags))
  } catch {
    // The lists stay as they are on screen. The next launch starts collapsed.
  }
}

/** Sign-out and account switch forget the choice. Another account starts collapsed. */
export async function clearHomeListExpanded(): Promise<void> {
  try {
    await deviceStorage.removeItem?.(HOME_LIST_EXPANDED_KEY)
  } catch {
    // A storage that will not forget still starts the next account collapsed
    // once the key can be read as empty.
  }
}
