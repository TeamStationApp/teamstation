import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'

import express from 'express'

import { makeDatabase } from './db/database'
import { withAudit } from './middleware/withAudit'
import { withActor } from './middleware/withAuth'
import { errorHandler, notFoundHandler } from './middleware/withErrors'
import { openApiDocument } from './openapi'
import { authRoutes } from './routes/auth'
import { healthRoutes } from './routes/health'
import { serverConfig } from './serverConfig'

const VERSION = '0.1.0'

/**
 * Delivers a sign-in code. There is no SMTP yet — M4 copies PeerTube's
 * settings — so for now it logs the code and says plainly that it did, rather
 * than pretending to have sent mail.
 */
async function sendCode(email: string, code: string): Promise<void> {
  console.log(`[no mail configured] sign-in code for ${email}: ${code}`)
  await Promise.resolve()
}

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

  // Who is calling, then what they changed, then the routes themselves.
  app.use(withActor(db))
  app.use(withAudit(db))

  app.get('/api/v1/openapi.json', (req, res) => {
    res.json(openApiDocument(VERSION))
  })
  app.use('/api/v1', healthRoutes(db, VERSION))
  app.use('/api/v1', authRoutes(db, { sendCode }))

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
