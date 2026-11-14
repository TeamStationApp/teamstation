import type { ServerConfig } from '../serverConfigSchema'
import { type ApnsOptions, type ApnsSettings, apnsTransport } from './apns'
import { type FcmOptions, type FcmSettings, fcmTransport } from './fcm'
import { logTransport, withLog } from './log'
import { limited, type PushLog, type PushTransports } from './send'
import {
  type WebPushOptions,
  type WebPushSettings,
  webPushTransport
} from './webPush'

/** `serverConfig.push`, resolved: a service whose keys are missing is null. */
export interface PushSettings {
  apns: ApnsSettings | null
  fcm: FcmSettings | null
  webPush: WebPushSettings | null
  /** Group messages go to iPhones as alerts the app may hide. */
  iosFiltering: boolean
  /** Where the log transport writes, or null for none. */
  logFile: string | null
  /** How long a chat post waits before its wakes are sent. */
  chatHoldSeconds: number
}

/**
 * How long a chat post waits before it wakes anybody: time for a member
 * who has the conversation open to read it, and not be notified of it.
 */
export const CHAT_HOLD_SECONDS = 15

/** The section when every one of its values is there, and otherwise null. */
function complete<T extends Record<string, string>>(
  section: T | undefined
): T | null {
  if (section == null) return null
  return Object.values(section).every(value => value.trim() !== '')
    ? section
    : null
}

export function pushSettings(config: Pick<ServerConfig, 'push'>): PushSettings {
  const push = config.push
  return {
    apns: complete(push?.apns),
    fcm: complete(push?.fcm),
    webPush: complete(push?.webPush),
    iosFiltering: push?.iosFiltering ?? false,
    logFile: push?.logFile == null || push.logFile === '' ? null : push.logFile,
    chatHoldSeconds: Math.max(0, push?.chatHoldSeconds ?? CHAT_HOLD_SECONDS)
  }
}

export interface PushTransportOptions {
  apns?: ApnsOptions
  fcm?: FcmOptions
  webPush?: WebPushOptions
}

/**
 * A transport for each service that has its keys, each sending no more than
 * `SENDS_AT_ONCE` at once (`limited`), behind the log transport when there is
 * a log file. The server makes these once and hands them to whatever sends.
 *
 * A key that cannot be read (a truncated or mis-escaped PEM) leaves its own
 * service off, and says so in `log`: a notification setting never stops the
 * server, nor the other services.
 */
export function pushTransports(
  settings: PushSettings,
  options: PushTransportOptions = {},
  log: PushLog = line => {
    console.error(line)
  }
): PushTransports {
  const made = <T>(service: string, make: () => T): T | undefined => {
    try {
      return make()
    } catch (error) {
      log(`push: ${service} is off, its key cannot be read: ${String(error)}`)
      return undefined
    }
  }
  const ios =
    settings.apns == null
      ? undefined
      : made('APNs', () => apnsTransport(settings.apns!, options.apns))
  const android =
    settings.fcm == null
      ? undefined
      : made('FCM', () => fcmTransport(settings.fcm!, options.fcm))
  const web =
    settings.webPush == null
      ? undefined
      : made('Web Push', () =>
          webPushTransport(settings.webPush!, options.webPush)
        )
  const transports: PushTransports = {
    ...(ios == null ? {} : { ios: limited(ios) }),
    ...(android == null ? {} : { android: limited(android) }),
    ...(web == null ? {} : { web: limited(web) })
  }
  return settings.logFile == null
    ? transports
    : withLog(logTransport(settings.logFile), transports)
}
