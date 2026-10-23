import type {
  EventName,
  Level,
  Property
} from '../../common/observability/contract'
import { Logger } from '../../common/observability/logger'
import { deviceStorage } from '../platform/deviceStorage'
import { randomUuid } from '../stream/deviceId'

let logger: Logger | undefined
export function startAppLogging(
  dsn: string,
  platform: string,
  version: string,
  request?: typeof fetch
): void {
  if (logger != null) return
  logger = new Logger({
    dsn,
    app: platform === 'web' ? 'TS web' : 'TS',
    version,
    request,
    storage: deviceStorage,
    id: randomUuid
  })
  logger.emit('service_started', { op: 'service' })
}

export function emitAppLog(
  event: EventName,
  properties: Record<string, Property> = {},
  level: Level = 'info'
): void {
  logger?.emit(event, properties, level)
}

export function resetAppLogging(): void {
  logger?.queue?.stop()
  logger = undefined
}

export async function flushAppLogs(): Promise<void> {
  await logger?.queue?.flush()
}
