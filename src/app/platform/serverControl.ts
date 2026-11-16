import type { ServerControl } from './serverControlType'

/** The web has no server of its own to change. */
export function developServerControl(): ServerControl | undefined {
  return undefined
}
