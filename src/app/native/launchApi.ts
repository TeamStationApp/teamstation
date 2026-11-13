import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { apiBaseUrl, appOrigin } from './config'
import { apiBaseFor, loadServerOverride } from './serverOverride'

/**
 * The API a launch talks to, worked out once and shared by everything that
 * calls it from the phone: the app (`native/index.tsx`), its session store
 * and Android's background tasks (`chatWakeTask.native.ts`). A develop
 * build's server override, or the built one.
 */
export async function launchApiOf(
  storage: PreferenceStorage,
  origin: string | undefined,
  built: string
): Promise<string> {
  return apiBaseFor(await loadServerOverride(storage, origin), built)
}

let launched: Promise<string> | undefined
/**
 * This launch's API, for this build and device. Read once: an override
 * changed later is for the next launch.
 */
export async function launchApi(): Promise<string> {
  launched ??= launchApiOf(deviceStorage, appOrigin, apiBaseUrl)
  return await launched
}
