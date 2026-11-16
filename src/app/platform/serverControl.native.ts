import { appOrigin } from '../native/config'
import { isDevelopBuild, saveServerOverride } from '../native/serverOverride'
import { deviceStorage } from './deviceStorage'
import type { ServerControl } from './serverControlType'

/** A develop phone build's own control; none in a stable build. */
export function developServerControl(
  origin: string | undefined = appOrigin,
  storage: Parameters<typeof saveServerOverride>[0] = deviceStorage
): ServerControl | undefined {
  if (!isDevelopBuild(origin)) return undefined
  return async server => await saveServerOverride(storage, origin, server)
}
