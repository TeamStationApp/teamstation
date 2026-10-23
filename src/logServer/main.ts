import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'

import { collector, type CollectorConfig } from './app'
import { OpenSearch, searchTransport } from './openSearch'
import { LogSpool } from './spool'

export interface LogServerConfig extends CollectorConfig {
  host: string
  port: number
  spool: string
  search: { url: string; username: string; password: string; ca?: string }
}
export async function startCollector(
  config: LogServerConfig
): Promise<{ server: Server; stop: () => Promise<void> }> {
  if (
    typeof config.host !== 'string' ||
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    typeof config.spool !== 'string'
  )
    throw new Error('Invalid collector configuration')
  const sink = new OpenSearch(searchTransport(config.search))
  await sink.setup()
  const spool = new LogSpool(config.spool, sink)
  await spool.ready
  const app = collector(config, spool, sink)
  const server = await new Promise<Server>((resolve, reject) => {
    const value = app.listen(config.port, config.host, () => {
      resolve(value)
    })
    value.on('error', reject)
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  const timer = setInterval(() => {
    spool.flush().catch(() => {})
  }, 1000)
  return {
    server,
    stop: async () => {
      clearInterval(timer)
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error != null) reject(error)
          else resolve()
        })
        server.closeIdleConnections()
      })
      await spool.flush()
    }
  }
}

if (require.main === module) {
  ;(async () => {
    const path = process.env.TS_LOG_CONFIG
    if (path == null) throw new Error('Collector configuration path required')
    const config = JSON.parse(await readFile(path, 'utf8')) as LogServerConfig
    const { server, stop } = await startCollector(config)
    // Only the bound address is printed; never configuration or provider error bodies.
    console.log(JSON.stringify({ ready: true, address: server.address() }))
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.once(signal, () => {
        stop().then(
          () => {
            process.exit(0)
          },
          () => {
            process.exit(1)
          }
        )
      })
  })().catch(() => {
    console.error('Collector startup failed')
    process.exitCode = 1
  })
}
