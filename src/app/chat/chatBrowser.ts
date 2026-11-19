import { openExternal } from '../platform/externalBrowser'

export const openChatBrowser = openExternal
export function chatLinkOrigins(_apiBaseUrl: string): {
  active: string
  verified: string
} {
  const origin = window.location.origin
  return { active: origin, verified: origin }
}
