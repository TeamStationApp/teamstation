import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  PushAddress,
  PushMessage,
  PushResult,
  PushTransport,
  PushTransports
} from './send'

/**
 * One line of the log transport's file: everything needed to deliver the
 * message by hand, so a test replays it into a device or a browser. For the
 * web, `address` is the subscription and `message.payload` what its service
 * worker would read.
 */
export interface PushLogRecord {
  at: string
  registrationId: string
  userId: string
  platform: PushAddress['platform']
  environment: PushAddress['environment']
  address: string
  message: PushMessage
}

/**
 * Appends one JSON line per message to `file`, in the order they were sent.
 * A development seat or an end-to-end run, which has no real APNs, FCM or
 * push service to reach, reads them instead.
 */
export function logTransport(
  file: string,
  now: () => Date = () => new Date()
): PushTransport<PushMessage> {
  let ready: Promise<unknown> = mkdir(dirname(file), { recursive: true })
  return {
    async send(to: PushAddress, message: PushMessage): Promise<PushResult> {
      const record: PushLogRecord = {
        at: now().toISOString(),
        registrationId: to.id,
        userId: to.userId,
        platform: to.platform,
        environment: to.environment,
        address: to.address,
        message
      }
      const written = ready.then(async () => {
        await appendFile(file, `${JSON.stringify(record)}\n`)
      })
      ready = written.catch(() => undefined)
      try {
        await written
        return { status: 'sent' }
      } catch (error) {
        return { status: 'failed', reason: String(error) }
      }
    }
  }
}

/**
 * Each platform's transport with the log in front: every message is written,
 * then sent through the real service where there is one, which answers for
 * it. A platform with no service is still written, so a seat without keys
 * records what it would have sent.
 */
export function withLog(
  log: PushTransport<PushMessage>,
  transports: PushTransports
): PushTransports {
  const both = <M extends PushMessage>(
    real: PushTransport<M> | undefined
  ): PushTransport<M> => ({
    async send(to, message) {
      const logged = await log.send(to, message)
      return real == null ? logged : await real.send(to, message)
    }
  })
  return {
    ios: both(transports.ios),
    android: both(transports.android),
    web: both(transports.web)
  }
}
