import type { ChatPlatform } from '../../common/api'

/**
 * How this device names itself when it registers for chat, so the person
 * can tell their devices apart on Chat devices. The browser reads its user
 * agent; the phone asks React Native (`thisDevice.native.ts`).
 */
export interface ThisDevice {
  name: string
  platform: ChatPlatform
}

/** "Chrome on macOS", or as near as the user agent allows. */
export function browserName(userAgent: string): string {
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Firefox/')
      ? 'Firefox'
      : userAgent.includes('Chrome/')
        ? 'Chrome'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'A browser'
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : userAgent.includes('Android')
      ? 'Android'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : userAgent.includes('Windows')
          ? 'Windows'
          : userAgent.includes('Linux')
            ? 'Linux'
            : undefined
  return system == null ? browser : `${browser} on ${system}`
}

export function thisDevice(): ThisDevice {
  return {
    name: browserName(globalThis.navigator?.userAgent ?? ''),
    platform: 'web'
  }
}
