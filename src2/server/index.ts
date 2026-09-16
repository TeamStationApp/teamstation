import cluster from 'node:cluster'
import { randomBytes } from 'node:crypto'
import { availableParallelism } from 'node:os'

import express from 'express'

import { makeDatabase } from './db/database'
import type { MediaContext } from './media/mediaContext'
import { withAudit } from './middleware/withAudit'
import { withActor } from './middleware/withAuth'
import { withCors } from './middleware/withCors'
import { errorHandler, notFoundHandler } from './middleware/withErrors'
import { openApiDocument } from './openapi'
import { authRoutes } from './routes/auth'
import { devMediaRoutes } from './routes/devMedia'
import { healthRoutes } from './routes/health'
import { mediaAuthRoute, mediaRoutes } from './routes/media'
import { statsRoutes } from './routes/stats'
import { teamRoutes } from './routes/teams'
import { serverConfig } from './serverConfig'

const VERSION = '0.1.0'
const MEDIA_SECRET_ENV = 'GS_MEDIA_SECRET'

/**
 * The key that signs `/media` tokens.
 *
 * Every worker has to agree on it, or a playlist minted by one worker would be
 * refused by the next, so the primary generates it before forking and the
 * workers inherit it. A generated one does not survive a restart, which only
 * means playback URLs issued before it stop verifying; the player asks for a
 * fresh one on a 403 and resumes where it was. Production sets `mediaSecret`.
 */
function resolveMediaSecret(): string {
  if (serverConfig.mediaSecret !== '') return serverConfig.mediaSecret
  const inherited = process.env[MEDIA_SECRET_ENV]
  if (inherited != null && inherited !== '') return inherited
  const generated = randomBytes(32).toString('base64url')
  process.env[MEDIA_SECRET_ENV] = generated
  return generated
}

/**
 * Delivers a sign-in code. There is no mail relay yet — M4 adds one —
 * so for now it logs the code and says plainly that it did, rather
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
  // Before forking, so every worker inherits the same one.
  resolveMediaSecret()
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
  const mediaSecret = resolveMediaSecret()
  const mediaContext: MediaContext = {
    ffmpegPath: serverConfig.ffmpegPath,
    mediaRoot: serverConfig.mediaDir,
    mediaSecret,
    publicUrl: serverConfig.publicUrl,
    workDir: serverConfig.workDir
  }
  const app = express()

  app.set('trust proxy', 'loopback')
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use(withCors(serverConfig.corsOrigins))

  // Who is calling, then what they changed, then the routes themselves.
  app.use(withActor(db))
  app.use(withAudit(db))

  app.get('/api/v1/openapi.json', (req, res) => {
    res.json(openApiDocument(VERSION))
  })
  app.use('/api/v1', healthRoutes(db, VERSION))
  app.use('/api/v1', authRoutes(db, { sendCode }))
  app.use('/api/v1', teamRoutes(db, mediaContext))
  app.use('/api/v1', statsRoutes(db))
  app.use('/api/v1', mediaRoutes(db, mediaContext))

  // What the reverse proxy's auth check calls. Not under /api/v1: it is not a
  // public endpoint, and the proxy is the only thing that should ever reach it.
  app.use(mediaAuthRoute(mediaSecret))

  // Development only; the reverse proxy serves these bytes in production.
  if (serverConfig.serveMediaLocally) {
    app.use(devMediaRoutes(serverConfig.mediaDir, mediaSecret))
  }

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
