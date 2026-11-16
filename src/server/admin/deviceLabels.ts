import type { AppType } from '../../common/userManagement'

/** What is known about the device one sign-in is on. */
export interface DeviceFacts {
  /**
   * `auth_sessions.device_name`, which holds either a name somebody gave the
   * device (a Director's, typed at sign-in) or what the device is (a TV
   * sign-in's `Apple TV` or `Google TV`, a native app's model). Nothing
   * records which. The label shows it either way, and `appType` reads only
   * the TV kinds from it, so a Director somebody named "Apple TV" would read
   * as tvOS.
   */
  deviceName: string | null
  /** The name the device gave chat for this sign-in, if it registered. */
  chatDeviceName: string | null
  chatPlatform: 'web' | 'ios' | 'android' | null
  userAgent: string | null
}

/** Chrome's reduced user agent names every Android phone `K`. */
const ANONYMOUS_ANDROID = new Set(['', 'K'])

/**
 * The device from its user agent alone: the kind of phone or computer, and
 * an Android phone's model when the agent still carries one.
 */
function agentDevice(agent: string): string | undefined {
  if (agent.includes('iPhone')) return 'iPhone'
  if (agent.includes('iPad')) return 'iPad'
  const android = /Android[^;)]*;\s*([^;)]*)/.exec(agent)
  if (android != null) {
    const model = android[1].replace(/\s+Build\/.*$/, '').trim()
    return ANONYMOUS_ANDROID.has(model) ? 'Android device' : model
  }
  if (agent.includes('Android') || agent.startsWith('okhttp'))
    return 'Android device'
  if (agent.includes('Macintosh')) return 'Mac'
  if (agent.includes('Windows')) return 'Windows PC'
  if (agent.includes('Linux') || agent.includes('X11')) return 'Linux PC'
  return undefined
}

/**
 * The most specific name the records give the device: the name it signed in
 * with, then the name it gave chat, then its user agent's, and
 * `Unknown device` when none says.
 */
export function deviceLabel(facts: DeviceFacts): string {
  const named = facts.deviceName?.trim()
  if (named != null && named !== '') return named
  const chat = facts.chatDeviceName?.trim()
  if (chat != null && chat !== '') return chat
  return agentDevice(facts.userAgent ?? '') ?? 'Unknown device'
}

/**
 * The app the sign-in was made in: a TV by its name, then the platform it
 * registered for chat with, then its user agent. A browser's agent starts
 * `Mozilla/`; React Native's requests go out through okhttp on Android and
 * CFNetwork on Apple's systems.
 */
export function appType(facts: DeviceFacts): AppType {
  const named = facts.deviceName?.trim()
  if (named === 'Apple TV') return 'tvOS'
  if (named === 'Google TV' || named === 'Android TV') return 'Android'
  if (facts.chatPlatform === 'web') return 'Web'
  if (facts.chatPlatform === 'ios') return 'iOS'
  if (facts.chatPlatform === 'android') return 'Android'
  const agent = facts.userAgent ?? ''
  if (agent.startsWith('Mozilla/')) return 'Web'
  if (agent.startsWith('okhttp') || agent.includes('Dalvik')) return 'Android'
  if (agent.includes('CFNetwork') || agent.includes('Darwin')) return 'iOS'
  return 'Unknown'
}
