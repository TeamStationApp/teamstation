import { fork } from 'node:child_process'
import cluster from 'node:cluster'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'

import express from 'express'

import { startChatReconciler } from './chat/reconciler'
import { makeDatabase } from './db/database'
import { modelsOf } from './dictation/models'
import { attachDictation } from './dictation/route'
import { purgeReplacedRecordings } from './director/purge'
import { reopenInterruptedUploads } from './director/uploads'
import {
  mailConfigured,
  sendInvitation,
  sendSignInCode
} from './email/sendMail'
import { jsonBody } from './jsonBody'
import {
  type LiveControllerOptions,
  startLiveController,
  stopLiveController
} from './live/controller'
import { livingWorkers } from './livingWorkers'
import type { MediaContext } from './media/mediaContext'
import { spaceConfigured } from './media/spacesHls'
import { withAudit } from './middleware/withAudit'
import { withActor } from './middleware/withAuth'
import { withCors } from './middleware/withCors'
import { errorHandler, notFoundHandler } from './middleware/withErrors'
import { oauthRequestLimit, scheduleOAuthPrune } from './oauth/maintenance'
import { createOAuthProvider } from './oauth/provider'
import { oauthInteractionRoutes } from './oauth/routes'
import { openApiDocument } from './openapi'
import { accountRoutes } from './routes/account'
import { authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { chatKeyRoutes } from './routes/chatKeys'
import { devMediaRoutes } from './routes/devMedia'
import { directorRoutes } from './routes/director'
import { directorUploadRoutes } from './routes/directorUploads'
import { eventListRoutes } from './routes/eventList'
import { eventRoutes } from './routes/events'
import { followRoutes } from './routes/follows'
import { guardianRoutes } from './routes/guardians'
import { healthRoutes } from './routes/health'
import { inviteRoutes } from './routes/invites'
import { lineupRoutes } from './routes/lineups'
import type { LiveRouteOptions } from './routes/live'
import { liveRoutes } from './routes/live'
import { logRoutes } from './routes/logs'
import { manageRoutes } from './routes/manage'
import { meRoutes } from './routes/me'
import { mediaAuthRoute, mediaRoutes } from './routes/media'
import { playerRoutes } from './routes/players'
import { scheduleRoutes } from './routes/schedule'
import { scoreboardRoutes } from './routes/scoreboard'
import { seasonRoutes } from './routes/seasons'
import { statsRoutes } from './routes/stats'
import { teamMemberRoutes } from './routes/teamMembers'
import { teamRoutes } from './routes/teams'
import { userRoutes } from './routes/users'
import { walkUpSongRoutes } from './routes/walkUpSongs'
import { attachScoreboard } from './scoreboard/attachScoreboard'
import { startScoreboard } from './scoreboard/scoreboardService'
import { primaryHost, publicUrl, serverConfig } from './serverConfig'
import { bindUpgrades } from './socket/bindUpgrades'
import { attachGameSocket } from './socket/gameSocket'
import {
  exitAfterBuilder,
  forceStop,
  startStatsBuilder,
  type StatsBuilderHandle
} from './statsBuilder/serverHooks'
import {
  type SupervisedChild,
  superviseStatsBuilder
} from './statsBuilder/supervisor'
import { stopWorker } from './stopWorker'

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

/**
 * A worker's own budget, which has to finish inside `FORCE_STOP_MS`.
 *
 * The primary's force is for a worker that cannot answer at all — a stopped
 * process, a wedged event loop. Anything a worker can decide for itself it
 * decides before then, so the ordinary path is a worker that left cleanly and
 * a primary that never had to take anything.
 */
const WORKER_STOP_MS = 6_000
const WORKER_CUT_CONNECTIONS_MS = 3_000

/**
 * How often the primary looks again for workers that have gone.
 *
 * A worker's exit is an edge, and a stop that decides on the edge alone has
 * nothing to fall back on when it misses one. Looking again costs a quarter of
 * a second in the case that used to cost ten.
 */
const WORKER_SWEEP_MS = 250
const MEDIA_SECRET_ENV = 'TS_MEDIA_SECRET'

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
 * Delivers an invitation an administrator addressed to somebody.
 *
 * Logged rather than sent with no relay configured, the same as a sign-in
 * code — and unlike that one it is **thrown** on failure, because the person
 * who typed the address is standing there waiting to be told whether it went.
 */
async function sendInvite(
  email: string,
  invitation: { scopeName: string; invitedBy: string; link: string }
): Promise<void> {
  if (!mailConfigured(serverConfig.smtp)) {
    console.log(
      `[no mail configured] invitation for ${email}: ${invitation.link}`
    )
    return
  }
  const sent = await sendInvitation(serverConfig.smtp, email, invitation)
  console.log(
    `invitation sent to ${email}: ${sent.accepted} accepted, id ${sent.messageId}`
  )
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
  return {
    live: serverConfig.live,
    sessionSecret: serverConfig.sessionSecret,
    // The name this deployment goes by, which is the name an encoder has to
    // publish to. There is nothing to fall back to and nothing to get wrong:
    // it is the same fact the playback URLs are built from.
    host: primaryHost
  }
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
  const started = startLiveController(liveControllerOptions(db))
  if (!started) console.error('live ingest did not start')
}

/**
 * The primary forks one worker per CPU and replaces any that dies; the workers
 * share the listening socket, so a slow request on one never blocks another.
 * Set `clusterWorkers` to 1 when debugging, so breakpoints land in the only
 * process there is.
 */
/**
 * Uploads a stopped process left half-taken-in.
 *
 * Called from **both** ways this server starts. It was attached to the
 * forking path alone, which meant a server configured with one worker — the
 * way anything being debugged runs — never swept at all,
 * and an upload interrupted there stayed `assembling` for ever.
 */
function reopenInterrupted(db: ReturnType<typeof makeDatabase>): void {
  reopenInterruptedUploads(db)
    .then((count: number) => {
      if (count > 0) console.log(`reopened ${count} interrupted upload(s)`)
    })
    .catch((error: unknown) => {
      console.error(`reopening interrupted uploads: ${String(error)}`)
    })
}

/** How often replaced recordings whose month is up are looked for. */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Deletes recordings an upload replaced, once their month is up.
 *
 * On the way up as well as on the timer: a server that was off for a week comes
 * back with a week of recordings owed a deletion, and waiting six hours to
 * start is six hours of a Space being paid for copies on no page.
 *
 * Only where a Space is configured — with local storage there is nothing to
 * be charged for and nothing to delete remotely.
 */
function startPurge(db: ReturnType<typeof makeDatabase>): void {
  // Off unless this deployment says so: deleting from a bucket another
  // deployment also serves would delete bytes it still needs. See
  // `purgeReplacedRecordings` in serverConfig.
  if (!serverConfig.purgeReplacedRecordings) return
  if (!spaceConfigured(serverConfig.space)) return
  const sweep = (): void => {
    purgeReplacedRecordings({
      db,
      space: serverConfig.space,
      mediaDir: serverConfig.mediaDir,
      log: message => {
        console.log(message)
      }
    })
      .then(gone => {
        if (gone.length > 0) {
          console.log(`purged ${gone.length} replaced recording(s)`)
        }
      })
      .catch((error: unknown) => {
        console.error(`purging replaced recordings: ${String(error)}`)
      })
  }
  sweep()
  const timer = setInterval(sweep, PURGE_INTERVAL_MS)
  timer.unref?.()
}

function runPrimary(workerCount: number): void {
  // Before forking, so every worker inherits the same one.
  resolveMediaSecret()
  const liveDb = makeDatabase(serverConfig.databaseUrl)
  startLive(liveDb)
  reopenInterrupted(liveDb)
  startPurge(liveDb)
  startChatReconciler(liveDb, serverConfig.databaseUrl)
  const builder = startStatsBuilder({
    enabled: serverConfig.statsBuilder,
    supervise: () =>
      superviseStatsBuilder({
        fork: (modulePath, args, options) =>
          fork(modulePath, args, options) as SupervisedChild,
        log: message => {
          console.log(message)
        },
        clock: () => new Date()
      }),
    log: message => {
      console.log(message)
    }
  })
  const exitWithBuilder = exitAfterBuilder(builder, code => {
    process.exit(code)
  })
  const forceExit = forceStop(builder, code => {
    process.exit(code)
  })
  console.log(`teamstation ${VERSION}: forking ${workerCount} workers`)
  for (let i = 0; i < workerCount; i++) cluster.fork()

  let stopping = false

  /**
   * The last worker out turns the lights off. Without this the primary
   * signalled its workers and then sat there for ever: the service manager waited
   * out its whole stop timeout on every deploy, SIGKILLed it, and each of those ninety
   * seconds was a 502 for anybody using the site.
   *
   * `noticedBy` is in the log so the two ways of getting here can be told
   * apart. A stop that only ever finishes on the sweep is a stop whose exit
   * events are arriving too early to be believed.
   */
  const finishIfEveryWorkerHasGone = (noticedBy: string): void => {
    if (livingWorkers(cluster.workers).length > 0) return
    if (noticedBy !== 'exit') {
      console.log(`every worker has gone, noticed by the ${noticedBy}`)
    }
    exitWithBuilder(0)
  }

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      finishIfEveryWorkerHasGone('exit')
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
    builder.stop(signal).catch((error: unknown) => {
      console.error('stats builder: stop failed', error)
    })
    const workers = livingWorkers(cluster.workers)
    console.log(`${signal}: stopping ${workers.length} workers`)
    if (workers.length === 0) {
      exitWithBuilder(0)
      return
    }
    for (const worker of workers) worker.kill(signal)

    // Looking again, because a worker that has already gone sends no further
    // exit event and the primary would otherwise wait out its whole budget
    // over an empty process table.
    const sweep = setInterval(() => {
      finishIfEveryWorkerHasGone('sweep')
    }, WORKER_SWEEP_MS)
    sweep.unref()

    // A worker finishing a request deserves a moment; one that is wedged must
    // not hold a deploy open. Ten seconds, then take it.
    const forced = setTimeout(() => {
      console.error(`${signal}: workers did not stop in time, forcing`)
      for (const worker of livingWorkers(cluster.workers)) {
        worker.process.kill('SIGKILL')
      }
      forceExit(1)
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
    publicUrl,
    space: serverConfig.space
  }
  // Redis is connected to and not waited for: the API comes up without it,
  // and only the scoreboard notices that it is away.
  const scoreboard = startScoreboard({
    db,
    redis: serverConfig.redis,
    databaseUrl: serverConfig.databaseUrl,
    log: message => {
      console.error(`worker ${process.pid}: ${message}`)
    }
  })
  const app = express()

  app.set('trust proxy', 'loopback')
  app.disable('x-powered-by')
  app.use(withCors(serverConfig.corsOrigins))

  // Who is calling, then their body, which for a picture is read only when
  // somebody is signed in, then what they changed, then the routes.
  app.use(withActor(db))
  if (serverConfig.oauth?.enabled === true) {
    const provider = createOAuthProvider(db, serverConfig.oauth, publicUrl)
    app.use(['/oauth', '/api/v1/oauth/approvals'], oauthRequestLimit(db))
    app.use(oauthInteractionRoutes(db, provider, publicUrl))
    scheduleOAuthPrune(db)
    app.use('/oauth', provider.callback())
  }
  app.use(jsonBody)
  app.use(withAudit(db))

  app.get('/api/v1/openapi.json', (req, res) => {
    res.json(openApiDocument(VERSION))
  })
  app.use(
    '/api/v1',
    healthRoutes(db, VERSION, {
      dictation: serverConfig.dictation != null,
      dictationModels:
        serverConfig.dictation == null ? [] : modelsOf(serverConfig.dictation)
    })
  )
  app.use(
    '/api/v1',
    authRoutes(db, {
      passwordParameterSecret: serverConfig.sessionSecret,
      sendCode,
      space: serverConfig.space,
      publicUrl
    })
  )
  app.use('/api/v1', inviteRoutes(db, { sendCode, publicUrl }))
  app.use('/api/v1', manageRoutes(db, { sendInvite, publicUrl }))
  app.use('/api/v1', guardianRoutes(db, { sendInvite, publicUrl }))
  app.use('/api/v1', seasonRoutes(db, mediaContext))
  app.use(
    '/api/v1',
    eventListRoutes(db, mediaContext, { store: scoreboard.store })
  )
  app.use('/api/v1', teamRoutes(db, mediaContext, scoreboard.store))
  app.use('/api/v1', followRoutes(db, mediaContext))
  app.use('/api/v1', chatRoutes(db, mediaContext))
  app.use('/api/v1', chatKeyRoutes(db))
  app.use('/api/v1', scheduleRoutes(db))
  app.use('/api/v1', teamMemberRoutes(db, mediaContext))
  app.use(
    '/api/v1',
    eventRoutes(db, { onGameWritten: scoreboard.onGameWritten })
  )
  app.use('/api/v1', lineupRoutes(db))
  app.use('/api/v1', scoreboardRoutes(db, scoreboard.store))
  app.use('/api/v1', logRoutes())
  app.use('/api/v1', statsRoutes(db))
  app.use('/api/v1', playerRoutes(db, mediaContext))
  app.use('/api/v1', walkUpSongRoutes(db))
  app.use('/api/v1', userRoutes(db))
  app.use('/api/v1', meRoutes(db, serverConfig.buildsUrl))
  app.use(
    '/api/v1',
    accountRoutes(db, {
      ...mediaContext,
      sendCode: async (email, code) => {
        if (!mailConfigured(serverConfig.smtp))
          throw new Error('Email is not configured')
        await sendSignInCode(serverConfig.smtp, email, code)
      }
    })
  )
  app.use('/api/v1', mediaRoutes(db, mediaContext))
  app.use('/api/v1', liveRoutes(db, liveRouteOptions()))
  app.use(
    '/api/v1',
    directorRoutes(db, {
      ...liveRouteOptions(),
      space: serverConfig.space,
      // What a camera claimed by a Director is called, so a coach with an iPad
      // and a laptop pointed at one game can tell which row is which.
      deviceLabel: 'TS Director'
    })
  )
  // Its own router because its bodies are not JSON: a part is megabytes of
  // recording, and `express.json` on the way in would try to parse it.
  app.use(
    '/api/v1',
    directorUploadRoutes(db, {
      uploadsDir:
        serverConfig.uploadsDir === ''
          ? path.join(serverConfig.mediaDir, 'uploads')
          : serverConfig.uploadsDir,
      ffmpegPath: serverConfig.ffmpegPath,
      space: serverConfig.space
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
  // One upgrade listener. Node delivers an upgrade to every listener on the
  // same socket, so each socket takes only the paths it owns.
  const gameSocket = attachGameSocket(server, db, serverConfig.databaseUrl, {
    listenForUpgrades: false
  })
  const closeScoreboard = attachScoreboard(server, scoreboard.hub, {
    listen: false
  })
  // Dictation is a WebSocket too, asked before the scoreboard, which takes
  // whatever is left.
  const dictation =
    serverConfig.dictation == null
      ? null
      : attachDictation(server, {
          db,
          config: serverConfig.dictation,
          allowedOrigins: [...serverConfig.corsOrigins, publicUrl],
          listenForUpgrades: false
        })
  const unbindUpgrades = bindUpgrades(server, [
    (req, socket, head) => gameSocket.acceptUpgrade(req, socket, head),
    (req, socket, head) => dictation?.acceptUpgrade(req, socket, head) === true,
    (req, socket, head) => {
      scoreboard.hub.handleUpgrade(req, socket, head)
      return true
    }
  ])

  // Unclustered — one process, which is both the API and the ingest.
  let builder: StatsBuilderHandle = {
    stop: async () => undefined
  }
  if (cluster.isPrimary) {
    startLive(db)
    reopenInterrupted(db)
    startPurge(db)
    startChatReconciler(db, serverConfig.databaseUrl)
    builder = startStatsBuilder({
      enabled: serverConfig.statsBuilder,
      supervise: () =>
        superviseStatsBuilder({
          fork: (modulePath, args, options) =>
            fork(modulePath, args, options) as SupervisedChild,
          log: message => {
            console.log(message)
          },
          clock: () => new Date()
        }),
      log: message => {
        console.log(message)
      }
    })
  }

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    dictation?.close()
    stopLiveController()
    unbindUpgrades()
    // Before the server: an upgraded socket is not one of its connections,
    // so closing the server would leave every scoreboard socket open.
    closeScoreboard().catch((error: unknown) => {
      console.error(`worker ${process.pid}: scoreboard close: ${String(error)}`)
    })
    stopWorker({
      server,
      destroyDatabase: async () => {
        await db.destroy()
      },
      cutConnectionsMs: WORKER_CUT_CONNECTIONS_MS,
      deadlineMs: WORKER_STOP_MS,
      exit: exitAfterBuilder(builder, code => {
        process.exit(code)
      }),
      log: message => {
        console.error(`worker ${process.pid}: ${message}`)
      }
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
