import cluster from 'node:cluster'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'

import express from 'express'

import { makeDatabase } from './db/database'
import { mailConfigured, sendSignInCode } from './email/sendMail'
import {
  type LiveControllerOptions,
  startLiveController,
  stopLiveController
} from './live/controller'
import type { MediaContext } from './media/mediaContext'
import { withAudit } from './middleware/withAudit'
import { withActor } from './middleware/withAuth'
import { withCors } from './middleware/withCors'
import { errorHandler, notFoundHandler } from './middleware/withErrors'
import { openApiDocument } from './openapi'
import { authRoutes } from './routes/auth'
import { devMediaRoutes } from './routes/devMedia'
import { directorRoutes } from './routes/director'
import { healthRoutes } from './routes/health'
import { inviteRoutes } from './routes/invites'
import type { LiveRouteOptions } from './routes/live'
import { liveRoutes } from './routes/live'
import { mediaAuthRoute, mediaRoutes } from './routes/media'
import { seasonRoutes } from './routes/seasons'
import { statsRoutes } from './routes/stats'
import { teamRoutes } from './routes/teams'
import { serverConfig } from './serverConfig'

/**
 * What is actually running, not just what the package says.
 *
 * A build drops a `build.json` beside itself with its full version.
 * Reporting a bare `0.1.0` meant a reviewer had to infer "the build
 * changed" from the hash in the bundle's file name, five rounds running — the
 * one number that would have answered it for certain was already being
 * generated and then thrown away.
 *
 * No file — a checkout, a test, a laptop — and it is the package version,
 * which is the honest answer there.
 */
function versionOf(): string {
  for (const at of [
    path.join(process.cwd(), 'build.json'),
    path.join(__dirname, '..', '..', 'build.json')
  ]) {
    try {
      const read: unknown = JSON.parse(readFileSync(at, 'utf8'))
      if (
        typeof read === 'object' &&
        read !== null &&
        typeof (read as { version?: unknown }).version === 'string'
      ) {
        return (read as { version: string }).version
      }
    } catch {
      // The next place, then the package version.
    }
  }
  return '0.1.0'
}

const VERSION = versionOf()

/**
 * How long a stop may take before it is taken rather than waited for.
 *
 * The service manager's own stop timeout is 90 seconds and every one is a 502,
 * so this has to be far below it: a deploy should cost a blink, not a minute
 * and a half.
 */
const FORCE_STOP_MS = 10_000
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
 * Delivers a sign-in code.
 *
 * With no relay configured it logs the code and says so plainly, rather than
 * pretending to have sent mail. With one, a failure is **thrown**: the caller
 * answers 202 either way so that asking cannot reveal who has an account, but
 * a send that failed must show up in the log rather than leaving somebody
 * waiting for a message that was never going to arrive.
 */
async function sendCode(
  email: string,
  code: string,
  link?: string
): Promise<void> {
  if (!mailConfigured(serverConfig.smtp)) {
    console.log(
      `[no mail configured] sign-in code for ${email}: ${code}` +
        (link == null ? '' : `\n[no mail configured] link: ${link}`)
    )
    return
  }
  try {
    const sent = await sendSignInCode(serverConfig.smtp, email, code, link)
    console.log(
      `sign-in code sent to ${email}: ${sent.accepted} accepted, id ${sent.messageId}`
    )
  } catch (error) {
    // Logged loudly and swallowed: the reply must look the same either way.
    console.error(`FAILED to send a sign-in code to ${email}: ${String(error)}`)
  }
}

/**
 * The live ingest runs in exactly one process.
 *
 * It binds an RTMP port and holds the ffmpeg children writing a game's HLS, so
 * a second copy would fight the first for both. Clustered, that process is the
 * primary, which listens for nothing else; unclustered, it is the one process
 * there is. Every API worker reaches a stream by writing its row — see
 * `server/live/controller.ts`.
 */
function liveControllerOptions(
  db: ReturnType<typeof makeDatabase>
): LiveControllerOptions {
  return {
    db,
    live: serverConfig.live,
    ffmpegPath: serverConfig.ffmpegPath,
    mediaRoot: serverConfig.mediaDir,
    workDir: serverConfig.workDir,
    sessionSecret: serverConfig.sessionSecret,
    space: serverConfig.space
  }
}

function liveRouteOptions(): LiveRouteOptions {
  let fallbackHost = serverConfig.listenHost
  try {
    fallbackHost = new URL(serverConfig.publicUrl).hostname
  } catch {
    // A publicUrl that is not a URL is a configuration mistake worth surviving:
    // the stream URL then names the bind address, which is wrong but visible.
  }
  return {
    live: serverConfig.live,
    sessionSecret: serverConfig.sessionSecret,
    fallbackHost
  }
}

/**
 * Stills are written to `workDir` and served from `mediaDir/work`.
 *
 * Nothing makes those the same place, and when they are not, every thumbnail
 * in the app is a plain plate and nothing anywhere says why — the still is cut,
 * filed, and then looked for somewhere else. It costs one comparison at boot to
 * say so out loud.
 */
function checkStillsAreReachable(): void {
  const wanted = path.join(serverConfig.mediaDir, 'work')
  if (path.resolve(serverConfig.workDir) === path.resolve(wanted)) return
  console.error(
    `workDir is ${serverConfig.workDir} but stills are served from ${wanted}: ` +
      'no thumbnail will be found. One of the two settings is wrong.'
  )
}

function startLive(db: ReturnType<typeof makeDatabase>): void {
  if (!serverConfig.live.enabled) {
    console.log('live ingest is switched off (live.enabled is false)')
    return
  }
  if (serverConfig.sessionSecret === '') {
    console.error('live ingest disabled: sessionSecret is not set')
    return
  }
  if (serverConfig.live.publicUrl === '') {
    // Said at the top of the log rather than discovered by an operator whose
    // stream URL names 0.0.0.0. It is the one live setting with no sensible
    // default: only the deployment knows what the ingest is called from
    // outside.
    console.error(
      'live.publicUrl is not set: stream URLs will name the bind address, ' +
        'which nobody outside this machine can publish to'
    )
  }
  const started = startLiveController(liveControllerOptions(db))
  if (!started) console.error('live ingest did not start')
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
  checkStillsAreReachable()
  const liveDb = makeDatabase(serverConfig.databaseUrl)
  startLive(liveDb)
  console.log(`gamestation ${VERSION}: forking ${workerCount} workers`)
  for (let i = 0; i < workerCount; i++) cluster.fork()

  let stopping = false
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      // The last worker out turns the lights off. Without this the primary
      // signalled its workers and then sat there for ever: the service manager waited
      // out its whole stop timeout on every deploy, SIGKILLed it, and each of those
      // ninety seconds was a 502 for anybody using the site.
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0)
      return
    }
    console.error(
      `worker ${worker.process.pid ?? '?'} exited (${signal ?? code}), replacing it`
    )
    cluster.fork()
  })

  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    stopLiveController()
    const workers = Object.values(cluster.workers ?? {})
    console.log(`${signal}: stopping ${workers.length} workers`)
    if (workers.length === 0) process.exit(0)
    for (const worker of workers) worker?.kill(signal)

    // A worker finishing a request deserves a moment; one that is wedged must
    // not hold a deploy open. Ten seconds, then take it.
    const forced = setTimeout(() => {
      console.error(`${signal}: workers did not stop in time, forcing`)
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.process.kill('SIGKILL')
      }
      process.exit(1)
    }, FORCE_STOP_MS)
    forced.unref()
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
    space: serverConfig.space,
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
  app.use(
    '/api/v1',
    authRoutes(db, {
      sendCode,
      space: serverConfig.space,
      publicUrl: serverConfig.publicUrl
    })
  )
  app.use(
    '/api/v1',
    inviteRoutes(db, { sendCode, publicUrl: serverConfig.publicUrl })
  )
  app.use('/api/v1', seasonRoutes(db, mediaContext))
  app.use('/api/v1', teamRoutes(db, mediaContext))
  app.use('/api/v1', statsRoutes(db))
  app.use('/api/v1', mediaRoutes(db, mediaContext))
  app.use('/api/v1', liveRoutes(db, liveRouteOptions()))
  app.use(
    '/api/v1',
    directorRoutes(db, {
      ...liveRouteOptions(),
      space: serverConfig.space,
      // What a camera claimed by a Director is called, so a coach with an iPad
      // and a laptop pointed at one game can tell which row is which.
      deviceLabel: 'GS Director'
    })
  )

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

  // Unclustered — one process, which is both the API and the ingest.
  if (cluster.isPrimary) startLive(db)

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    stopLiveController()

    // `server.close` waits for every open connection to end, and a browser's
    // keep-alive connection sits open and idle for minutes after the page has
    // finished loading. Closing the idle ones is what lets a worker that is
    // doing nothing actually stop; without it the wait is not for work, it is
    // for a socket nobody is using.
    server.closeIdleConnections()
    const forced = setTimeout(() => {
      server.closeAllConnections()
    }, FORCE_STOP_MS / 2)
    forced.unref()

    server.close(() => {
      clearTimeout(forced)
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
