import cluster from 'node:cluster'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RequestHandler } from 'express'

import {
  type EventName,
  type Level,
  parseEvent,
  type Property,
  REQUEST_ROUTES,
  userId
} from '../../common/observability/contract'
import { logEndpoint, Logger } from '../../common/observability/logger'

interface LogSink {
  emit: (
    event: EventName,
    properties?: Record<string, Property>,
    level?: Level,
    actor?: string
  ) => void
  accept: (message: unknown) => void
  close: () => Promise<void>
}

/** One file owner per service. Cluster workers forward sanitized records to their primary. */
export function createServerLog(options: {
  dsn: string
  directory: string
  role: 'server' | 'stats'
  version?: string
  send?: (message: unknown) => void
  request?: typeof fetch
  writeToken?: string
}): LogSink {
  const file = join(options.directory, options.role + '.json')
  const enabled = logEndpoint(options.dsn) != null
  const logger =
    options.send != null
      ? undefined
      : new Logger({
          app: 'TS srv',
          dsn: options.dsn,
          version: options.version,
          id: randomUUID,
          request: options.request,
          writeToken: options.writeToken,
          storage: {
            getItem: async () => {
              try {
                if ((await stat(file)).size > 524288) return null
                return await readFile(file, 'utf8')
              } catch {
                return null
              }
            },
            setItem: async (_key, text) => {
              await mkdir(options.directory, { recursive: true, mode: 0o700 })
              await writeFile(file + '.tmp', text, { mode: 0o600 })
              await rename(file + '.tmp', file)
            }
          }
        })
  const accept = (message: unknown): void => {
    try {
      if (message == null || typeof message !== 'object') return
      const value = message as { type?: unknown; event?: unknown }
      if (value.type !== 'ts-operational') return
      const event = parseEvent(value.event)
      if (event.A !== 'TS srv') return
      logger?.queue?.enqueue(event).catch(() => {})
    } catch {
      /* An IPC sender never bypasses the event schema. */
    }
  }
  return {
    accept,
    emit: (event, properties = {}, level = 'info', actor) => {
      if (!enabled) return
      if (options.send == null) {
        logger?.emit(event, properties, level, actor)
        return
      }
      try {
        options.send({
          type: 'ts-operational',
          event: parseEvent({
            D: new Date().toISOString(),
            A: 'TS srv',
            I: randomUUID(),
            E: event,
            L: level,
            R: 1,
            P: properties,
            ...(options.writeToken != null && userId(actor) != null
              ? { U: actor }
              : {}),
            ...(options.version == null ? {} : { V: options.version })
          })
        })
      } catch {
        /* A primary that is stopping cannot break a worker request. */
      }
    },
    close: async () => {
      await logger?.close()
    }
  }
}

let active: LogSink | undefined
export function emitLog(
  event: EventName,
  properties: Record<string, Property> = {},
  level: Level = 'info',
  actor?: string
): void {
  active?.emit(event, properties, level, actor)
}

export function startServerLogging(
  options: Parameters<typeof createServerLog>[0]
): () => Promise<void> {
  const sink = createServerLog({
    ...options,
    ...(cluster.isWorker
      ? {
          send: (message: unknown) => {
            process.send?.(message, () => {})
          }
        }
      : {})
  })
  active = sink
  const receive = (_worker: unknown, message: unknown): void => {
    sink.accept(message)
  }
  cluster.on('message', receive)
  sink.emit('service_started', { op: 'service' })
  return async () => {
    cluster.off('message', receive)
    if (active === sink) active = undefined
    sink.emit('service_stopped', { op: 'service' })
    await sink.close()
  }
}

/** Route classifiers, never a raw URL, query, user header or body. */
export const requestLogs: RequestHandler = (req, res, next) => {
  const start = performance.now()
  res.once('finish', () => {
    const route: unknown = req.route?.path
    emitLog(
      'request_completed',
      {
        op: 'request',
        status: res.statusCode,
        rp:
          typeof route === 'string' && REQUEST_ROUTES.includes(route as never)
            ? route
            : 'other',
        mt: [
          'GET',
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
          'HEAD',
          'OPTIONS'
        ].includes(req.method)
          ? req.method
          : 'OTHER',
        ms: Math.min(86400000, Math.max(0, performance.now() - start))
      },
      'info',
      req.actor?.userId
    )
  })
  next()
}
