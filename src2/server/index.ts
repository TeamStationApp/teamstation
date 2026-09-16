import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'

import express from 'express'

import { makeDatabase } from './db/database'
import { errorHandler, notFoundHandler } from './middleware/withErrors'
import { healthRoutes } from './routes/health'
import { serverConfig } from './serverConfig'

const VERSION = '0.1.0'

/**
 * The primary forks one worker per CPU and replaces any that dies; the workers
 * share the listening socket, so a slow request on one never blocks another.
 * Set `clusterWorkers` to 1 when debugging, so breakpoints land in the only
 * process there is.
 */
function runPrimary(workerCount: number): void {
  console.log(`gamestation ${VERSION}: forking ${workerCount} workers`)
  for (let i = 0; i < workerCount; i++) cluster.fork()

  let stopping = false
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return
    console.error(
      `worker ${worker.process.pid ?? '?'} exited (${signal ?? code}), replacing it`
    )
    cluster.fork()
  })

  const stop = (signal: string): void => {
    stopping = true
    console.log(`${signal}: stopping workers`)
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill(signal)
    }
  }
  process.on('SIGTERM', () => {
    stop('SIGTERM')
  })
  process.on('SIGINT', () => {
    stop('SIGINT')
  })
}

function runWorker(): void {
  const db = makeDatabase(serverConfig.databaseUrl)
  const app = express()

  app.set('trust proxy', 'loopback')
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.use('/api/v1', healthRoutes(db, VERSION))

  app.use(notFoundHandler)
  app.use(errorHandler)

  const server = app.listen(
    serverConfig.listenPort,
    serverConfig.listenHost,
    () => {
      console.log(
        `worker ${process.pid} listening on ${serverConfig.listenHost}:${serverConfig.listenPort}`
      )
    }
  )

  const shutdown = (): void => {
    server.close(() => {
      db.destroy().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const workerCount =
  serverConfig.clusterWorkers > 0
    ? serverConfig.clusterWorkers
    : availableParallelism()

if (cluster.isPrimary && workerCount > 1) runPrimary(workerCount)
else runWorker()
